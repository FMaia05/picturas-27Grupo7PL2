"""Attempts of each job, kept on the shared volume.

Classic queues tell that a message was redelivered, but not how many times: a job that
kills its worker process (e.g. out of memory) would be delivered again for ever.
"""
import hashlib
import os
from pathlib import Path
import shutil
import socket

MAX_ATTEMPTS = int(os.getenv("VIDEO_MAX_ATTEMPTS", "3"))
_BASE = os.getenv("VIDEO_WORK_DIR")


def _record(msg_id, base):
    return Path(base) / "attempts" / hashlib.sha256(msg_id.encode()).hexdigest()


def start(msg_id, base=_BASE):
    """Registers one more attempt and returns its number (1 = first)."""
    if not base:
        return 1
    record = _record(msg_id, base)
    record.parent.mkdir(parents=True, exist_ok=True)
    try:
        number = int(record.read_text()) + 1
    except (FileNotFoundError, ValueError):
        number = 1
    record.write_text(str(number))
    return number


def finish(msg_id, base=_BASE):
    if base:
        _record(msg_id, base).unlink(missing_ok=True)


def own_work_directory(base=_BASE):
    """Gives this replica its own work directory, without what a crash left in it."""
    if not base:
        return None
    own = Path(base) / f"worker-{socket.gethostname()}"
    shutil.rmtree(own, ignore_errors=True)
    own.mkdir(parents=True, exist_ok=True)
    os.environ["VIDEO_WORK_DIR"] = str(own)
    return own
