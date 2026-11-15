"""Single-instance lock for the worker data directory.

Two worker processes on the same host would share the same `profiles/slot-NN` directories and could
run two live jobs at once, defeating isolation and the one-global-lane rule. The server lease already
serialises jobs, so this lock is the host-side guard: it makes a second `--serve`, `--once`, `--enroll`
or local job on the same data directory refuse to start.

The lock is an OS advisory lock on `<data_dir>/worker.lock`. The operating system drops it when the
process exits for ANY reason (crash, SIGKILL, power loss), so there is no stale-lock cleanup to get
wrong. The file only holds the owning process id for the operator and is never sent to the API.
"""
from __future__ import annotations

import os
from pathlib import Path

try:  # POSIX
    import fcntl

    def _lock(fh) -> None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(fh) -> None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

except ImportError:  # Windows
    import msvcrt

    def _lock(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)


LOCK_NAME = "worker.lock"


class HostLocked(RuntimeError):
    """Another worker process already owns this data directory."""


class HostLock:
    def __init__(self, data_dir):
        self.path = Path(data_dir).resolve() / LOCK_NAME
        self._fh = None

    def acquire(self):
        if self._fh is not None:
            return self
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+b")
        try:
            _lock(fh)
        except OSError:
            fh.close()
            raise HostLocked("Another worker process already holds this data directory") from None
        fh.seek(0)
        fh.truncate()
        fh.write(str(os.getpid()).encode("ascii"))
        fh.flush()
        self._fh = fh
        return self

    def release(self):
        fh, self._fh = self._fh, None
        if fh is None:
            return
        try:
            _unlock(fh)
        finally:
            fh.close()  # file kept on purpose: deleting it would let two processes lock different inodes

    @property
    def held(self):
        return self._fh is not None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
