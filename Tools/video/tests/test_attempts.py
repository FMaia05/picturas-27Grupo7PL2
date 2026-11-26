import json
import os
import sys
from pathlib import Path
from queue import Queue
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

# On the host, the shared utils package is a sibling of video.
sys.path.append(str(Path(__file__).resolve().parents[2]))

import attempts
import video


def test_attempts_are_counted_per_job_and_forgotten_at_the_end(tmp_path):
    assert [attempts.start("a", tmp_path) for _ in range(3)] == [1, 2, 3]
    assert attempts.start("b", tmp_path) == 1
    attempts.finish("a", tmp_path)
    attempts.finish("a", tmp_path)
    assert attempts.start("a", tmp_path) == 1


def test_without_a_shared_directory_nothing_is_counted():
    assert [attempts.start("a", None) for _ in range(5)] == [1] * 5
    attempts.finish("a", None)


def test_replica_cleans_only_its_own_leftovers(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_WORK_DIR", str(tmp_path))
    own = attempts.own_work_directory(tmp_path)
    (own / "x.part.mp4").write_bytes(b"x")
    other = tmp_path / "worker-other"
    other.mkdir()
    (other / "y.part.mp4").write_bytes(b"y")
    attempts.start("a", tmp_path)
    assert attempts.own_work_directory(tmp_path) == own
    assert list(own.iterdir()) == [] and (other / "y.part.mp4").exists()
    assert attempts.start("a", tmp_path) == 2
    assert os.environ["VIDEO_WORK_DIR"] == str(own)


@pytest.fixture
def worker(tmp_path, monkeypatch):
    channel, replies, connection = Mock(), Mock(), Mock()
    connection.channel.side_effect = [channel, replies]
    callbacks = Queue()
    connection.add_callback_threadsafe.side_effect = callbacks.put
    monkeypatch.setattr(video.pika, "BlockingConnection", Mock(return_value=connection))
    for name in ("start", "finish"):
        original = getattr(attempts, name)
        monkeypatch.setattr(attempts, name, lambda msg, f=original: f(msg, tmp_path))
    return channel, replies, callbacks


BODY = json.dumps({"messageId": "request-1", "procedure": "video", "parameters": {
    "inputImageURI": "in.mp4", "outputImageURI": "out.mp4", "tools": [], "progress": {}}}).encode()


def test_job_that_killed_three_workers_is_reported_and_dead_lettered(worker, monkeypatch):
    channel, replies, callbacks = worker
    process = Mock()
    monkeypatch.setattr(video, "process_video", process)
    for _ in range(attempts.MAX_ATTEMPTS):
        attempts.start("request-1")  # attempts whose process died before finishing
    video.VideoWorker().callback(channel, SimpleNamespace(delivery_tag=4, redelivered=True), None, BODY)
    callbacks.get(timeout=3)()
    process.assert_not_called()
    reply = json.loads(replies.basic_publish.call_args.kwargs["body"])
    assert reply["correlationId"] == "request-1" and reply["error"]["code"] == 2001
    channel.basic_nack.assert_called_once_with(delivery_tag=4, requeue=False)


def test_finished_job_starts_again_from_the_first_attempt(worker, monkeypatch):
    channel, _, callbacks = worker
    monkeypatch.setattr(video, "process_video", Mock(return_value={"frames": 1}))
    video.VideoWorker().callback(channel, SimpleNamespace(delivery_tag=1, redelivered=False), None, BODY)
    callbacks.get(timeout=3)()
    channel.basic_ack.assert_called_once_with(delivery_tag=1)
    assert attempts.start("request-1") == 1


@pytest.mark.parametrize("size,expected", [
    ((1280, 720), []), ((720, 1280), []), ((1920, 1080), ["-threads", "2"]), ((3840, 2160), ["-threads", "2"]),
])
def test_ffmpeg_threads_are_bounded_where_the_memory_limit_requires_it(size, expected, monkeypatch):
    from video_processor import ffmpeg_threads
    monkeypatch.delenv("VIDEO_LARGE_THREADS", raising=False)
    assert ffmpeg_threads(*size) == expected
