"""PictuRAS video microservice (RabbitMQ worker).

Receives the video and the whole effect pipeline in a single message,
processes it with video_processor and replies to the projects orchestrator on
project_queue. Progress is sent straight to the WebSocket gateway (ws_queue),
as a percentage.

Unlike the image tools, the message is only acknowledged after the job ends:
if the worker dies midway, RabbitMQ redelivers it.
"""
import datetime
import json
import os
from functools import partial
from threading import Thread
import time
import uuid

import pika
import pytz
from pika.exchange_type import ExchangeType

import attempts
import utils.env as env
from effects import UnsupportedEffect
from frame_extraction import InvalidExtraction
from video_processor import InvalidSpeed, InvalidTrim, InvalidVideo, ProcessingError, process_video

EXCHANGE = "picturas"
PROJECT_QUEUE = "project_queue"
WS_QUEUE = "ws_queue"
MICROSERVICE = "picturas-video-tool-ms"

CODES = {
    "wrong_procedure": 2000,
    "error_processing": 2001,
    "unsupported_effect": 2002,
    "invalid_trim": 2003,
    "invalid_video": 2004,
    "invalid_speed": 2005,
}


def now():
    return datetime.datetime.now(pytz.utc)


class VideoWorker:
    def __init__(self):
        self._queue = os.getenv("VIDEO_QUEUE_NAME", "video_queue")
        self._connection = self._connect()
        self._channel = self._connection.channel()
        self._channel.exchange_declare(exchange=EXCHANGE,
                                       exchange_type=ExchangeType.direct, durable=True)
        self._channel.queue_declare(queue=self._queue, passive=True)
        self._replies = self._connection.channel()
        self._replies.confirm_delivery()
        # one video at a time per replica; parallelism comes from replicas
        self._channel.basic_qos(prefetch_count=1)

    @staticmethod
    def _connect():
        credentials = pika.PlainCredentials(env.RABBITMQ_USERNAME, env.RABBITMQ_PASSWORD)
        params = pika.ConnectionParameters(
            env.RABBITMQ_HOST, int(env.RABBITMQ_PORT), "/", credentials,
            heartbeat=20,
        )
        for attempt in range(30):
            try:
                return pika.BlockingConnection(params)
            except pika.exceptions.AMQPConnectionError:
                time.sleep(2)
        raise RuntimeError("Could not connect to RabbitMQ")

    def _publish(self, queue, msg):
        if queue == PROJECT_QUEUE:
            self._replies.basic_publish(exchange=EXCHANGE, routing_key=queue,
                                        body=json.dumps(msg), mandatory=True,
                                        properties=pika.BasicProperties(delivery_mode=2))
        else:
            self._channel.basic_publish(exchange=EXCHANGE, routing_key=queue,
                                        body=json.dumps(msg))

    def _schedule(self, callback, *args, **kwargs):
        try:
            self._connection.add_callback_threadsafe(partial(callback, *args, **kwargs))
        except pika.exceptions.ConnectionWrongStateError:
            # The broker will redeliver the unacknowledged job.
            pass

    def _reply_success(self, msg_id, started, output_uri, video_info):
        output = {"type": video_info.get("output_type", "video"),
                  "imageURI": video_info.get("output_path", output_uri)}
        if output["type"] == "frames":
            output["frames"] = video_info["frames"]
        self._publish(PROJECT_QUEUE, {
            "messageId": f"video-{uuid.uuid4()}",
            "correlationId": msg_id,
            "timestamp": now().isoformat(),
            "status": "success",
            "output": output,
            "metadata": {
                "processingTime": (now() - started).total_seconds() * 1000,
                "microservice": MICROSERVICE,
                "video": video_info,
            },
        })

    def _reply_error(self, msg_id, started, code, message, input_uri):
        self._publish(PROJECT_QUEUE, {
            "messageId": f"video-{uuid.uuid4()}",
            "correlationId": msg_id,
            "timestamp": now().isoformat(),
            "status": "error",
            "error": {
                "code": code,
                "message": message,
                "msg": message,  # the orchestrator reads error.msg
                "details": {"inputFileURI": input_uri},
            },
            "metadata": {
                "processingTime": (now() - started).total_seconds() * 1000,
                "microservice": MICROSERVICE,
            },
        })

    def _progress(self, progress, preview, percent):
        if not progress or not progress.get("user"):
            return
        self._publish(WS_QUEUE, {
            "messageId": f"update-client-video-progress-{uuid.uuid4()}",
            "timestamp": now().isoformat(),
            "status": "success",
            "user": progress["user"],
            "projectId": progress.get("projectId"),
            "imgId": progress.get("imgId"),
            "preview": bool(preview),
            "percent": percent,
        })

    def callback(self, ch, method, properties, body):
        started = now()
        try:
            info = json.loads(body)
            if not isinstance(info, dict):
                raise ValueError("Expected a JSON object")
            params = info.get("parameters")
            if not isinstance(params, dict):
                raise ValueError("Expected parameters")
            for field, value in (("messageId", info.get("messageId")),
                                 ("procedure", info.get("procedure")),
                                 ("inputImageURI", params.get("inputImageURI")),
                                 ("outputImageURI", params.get("outputImageURI"))):
                if not isinstance(value, str) or not value:
                    raise ValueError(f"Expected a non-empty {field}")
            tools = params.get("tools")
            if not isinstance(tools, list) or any(
                not isinstance(tool, dict) or not isinstance(tool.get("procedure"), str)
                or not isinstance(tool.get("params", {}), dict) for tool in tools
            ):
                raise ValueError("Expected tools to be a list of tool objects")
            if not isinstance(params.get("progress", {}), dict):
                raise ValueError("Expected a progress object")
        except ValueError as error:
            print(f"[video] invalid message rejected: {error}", flush=True)
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)
            return

        Thread(target=self._process, args=(ch, method, started, info, params),
               daemon=True).start()

    def _process(self, ch, method, started, info, params):
        msg_id = info["messageId"]
        input_uri = params["inputImageURI"]
        output_uri = params["outputImageURI"]
        tools = params["tools"]
        preview = bool(params.get("preview"))
        progress = params.get("progress", {})
        errors = {
            UnsupportedEffect: "unsupported_effect",
            InvalidTrim: "invalid_trim",
            InvalidSpeed: "invalid_speed",
            InvalidVideo: "invalid_video",
            InvalidExtraction: "error_processing",
            ProcessingError: "error_processing",
        }

        if attempts.start(msg_id) > attempts.MAX_ATTEMPTS:
            print(f"[video] job {msg_id} rejected after {attempts.MAX_ATTEMPTS} attempts", flush=True)
            attempts.finish(msg_id)
            reply = partial(self._reply_error, msg_id, started, CODES["error_processing"],
                            "The video could not be processed after several attempts", input_uri)
            self._schedule(self._finish, ch, method.delivery_tag, reply, dead_letter=True)
            return

        print(f"[video] msg={msg_id} preview={preview} tools={[t['procedure'] for t in tools]}",
              flush=True)
        if info["procedure"] != "video":
            attempts.finish(msg_id)
            reply = partial(self._reply_error, msg_id, started, CODES["wrong_procedure"],
                            "The procedure received does not fit into this tool", input_uri)
            self._schedule(self._finish, ch, method.delivery_tag, reply)
            return

        try:
            result = process_video(
                input_uri, output_uri, tools, preview=preview,
                progress_cb=lambda pct: self._schedule(self._progress, progress, preview, pct),
            )
            reply = partial(self._reply_success, msg_id, started, output_uri, result)
            print(f"[video] msg={msg_id} ok frames={result['frames']} "
                  f"t={(now() - started).total_seconds():.1f}s", flush=True)
        except tuple(errors) as error:
            code = next(code for failure, code in errors.items() if isinstance(error, failure))
            reply = partial(self._reply_error, msg_id, started, CODES[code], str(error), input_uri)
        except Exception as error:
            print(f"[video] msg={msg_id} unexpected failure: {error}", flush=True)
            if not method.redelivered:
                self._schedule(ch.basic_nack, delivery_tag=method.delivery_tag, requeue=True)
                return
            attempts.finish(msg_id)
            reply = partial(self._reply_error, msg_id, started, CODES["error_processing"],
                            str(error), input_uri)
            self._schedule(self._finish, ch, method.delivery_tag, reply, dead_letter=True)
            return

        attempts.finish(msg_id)
        self._schedule(self._finish, ch, method.delivery_tag, reply)

    @staticmethod
    def _finish(ch, delivery_tag, reply, dead_letter=False):
        # Only settle work after the durable reply has been confirmed.
        reply()
        if dead_letter:
            ch.basic_nack(delivery_tag=delivery_tag, requeue=False)
        else:
            ch.basic_ack(delivery_tag=delivery_tag)

    def run(self):
        self._channel.basic_consume(queue=self._queue, on_message_callback=self.callback,
                                    auto_ack=False)
        print(f"[video] waiting for jobs on {self._queue}", flush=True)
        self._channel.start_consuming()


if __name__ == "__main__":
    attempts.own_work_directory()
    VideoWorker().run()
