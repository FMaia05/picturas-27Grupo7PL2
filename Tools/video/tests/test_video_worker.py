import json
import sys
from pathlib import Path
from queue import Queue
from threading import get_ident
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

# On the host, the shared utils package is a sibling of video.
sys.path.append(str(Path(__file__).resolve().parents[2]))

import video
import video_processor


def message(tools):
    return json.dumps({
        "messageId": "request-1",
        "procedure": "video",
        "parameters": {
            "inputImageURI": "source.mp4",
            "outputImageURI": "out.mp4",
            "tools": tools,
            "progress": {"user": "owner", "projectId": "project", "imgId": "media"},
        },
    }).encode()


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.delenv("VIDEO_QUEUE_NAME", raising=False)
    channel, replies, connection = Mock(), Mock(), Mock()
    connection.channel.side_effect = [channel, replies]
    callbacks = Queue()
    connection.add_callback_threadsafe.side_effect = callbacks.put
    make_connection = Mock(return_value=connection)
    monkeypatch.setattr(video.pika, "BlockingConnection", make_connection)
    return channel, replies, callbacks, make_connection


@pytest.mark.parametrize("queue", [None, "video_preview_queue", "video_subtitles_queue"])
def test_worker_uses_selected_queue_and_heartbeat(worker, monkeypatch, queue):
    channel, replies, _, make_connection = worker
    if queue:
        monkeypatch.setenv("VIDEO_QUEUE_NAME", queue)
    service = video.VideoWorker()
    service.run()
    expected = queue or "video_queue"
    assert make_connection.call_args.args[0].heartbeat == 20
    channel.queue_declare.assert_called_once_with(queue=expected, passive=True)
    channel.basic_qos.assert_called_once_with(prefetch_count=1)
    channel.basic_consume.assert_called_once_with(
        queue=expected, on_message_callback=service.callback, auto_ack=False
    )
    replies.confirm_delivery.assert_called_once_with()


@pytest.mark.parametrize("body", [message({"procedure": "brightness"}), b"null", b"{invalid"])
def test_malformed_payload_goes_directly_to_dlq(worker, monkeypatch, body):
    channel, replies, callbacks, _ = worker
    process = Mock()
    monkeypatch.setattr(video, "process_video", process)
    video.VideoWorker().callback(channel, SimpleNamespace(delivery_tag=1), None, body)
    channel.basic_nack.assert_called_once_with(delivery_tag=1, requeue=False)
    process.assert_not_called()
    replies.basic_publish.assert_not_called()
    assert callbacks.empty()


def test_unexpected_failure_is_dead_lettered_on_the_second_delivery(worker, monkeypatch):
    channel, replies, callbacks, _ = worker
    process = Mock(side_effect=RuntimeError("unexpected test failure"))
    monkeypatch.setattr(video, "process_video", process)
    service = video.VideoWorker()
    for tag, redelivered in [(1, False), (2, True)]:
        method = SimpleNamespace(delivery_tag=tag, redelivered=redelivered)
        service.callback(channel, method, None, message([]))
        callbacks.get(timeout=3)()
        channel.basic_nack.assert_called_with(delivery_tag=tag, requeue=not redelivered)
    assert process.call_count == 2
    channel.basic_ack.assert_not_called()
    assert json.loads(replies.basic_publish.call_args.kwargs["body"])["error"]["code"] == 2001


def test_progress_and_confirmed_reply_are_published_on_the_pika_thread(worker, monkeypatch):
    channel, replies, callbacks, _ = worker
    pika_thread = get_ident()
    operations = []

    def record(name):
        def operation(**kwargs):
            assert get_ident() == pika_thread
            operations.append((name, kwargs))
        return operation

    def process(*args, progress_cb, **kwargs):
        assert get_ident() != pika_thread
        progress_cb(40)
        return {"frames": 1}

    monkeypatch.setattr(video, "process_video", process)
    channel.basic_publish.side_effect = record("progress")
    replies.basic_publish.side_effect = record("reply")
    channel.basic_ack.side_effect = record("ack")
    method = SimpleNamespace(delivery_tag=8, redelivered=False)
    video.VideoWorker().callback(channel, method, None, message([]))
    callbacks.get(timeout=3)()
    callbacks.get(timeout=3)()
    assert [name for name, _ in operations] == ["progress", "reply", "ack"]
    progress = json.loads(operations[0][1]["body"])
    assert progress["percent"] == 40
    assert progress["projectId"] == "project"
    reply = operations[1][1]
    assert reply["properties"].delivery_mode == 2
    assert reply["mandatory"] is True
    assert json.loads(reply["body"])["correlationId"] == "request-1"
    assert operations[2][1]["delivery_tag"] == 8


def test_repeated_renders_use_unique_atomic_temporary_paths(sample_video, tmp_path, monkeypatch):
    output = tmp_path / "out" / "video.mp4"
    working = tmp_path / ".video-work"
    monkeypatch.setenv("VIDEO_WORK_DIR", str(working))
    paths = []
    start_encoder = video_processor._start_encoder

    def record_path(source, temporary, *args):
        paths.append(Path(temporary))
        return start_encoder(source, temporary, *args)

    monkeypatch.setattr(video_processor, "_start_encoder", record_path)
    for _ in range(2):
        video_processor.process_video(sample_video, str(output), [], preview=True)
    assert len(set(paths)) == 2
    assert all(path.parent == working and path.name.endswith(".part.mp4") for path in paths)
    assert all(not path.exists() for path in paths)
    assert output.is_file()
