import subprocess
import sys
import textwrap

import pytest

from worker.host_lock import HostLock, HostLocked, LOCK_NAME


def test_second_lock_on_same_dir_is_refused(tmp_path):
    first = HostLock(tmp_path).acquire()
    try:
        with pytest.raises(HostLocked):
            HostLock(tmp_path).acquire()
    finally:
        first.release()


def test_release_allows_reacquire_and_keeps_file(tmp_path):
    lock = HostLock(tmp_path).acquire()
    lock.release()
    assert not lock.held
    assert (tmp_path / LOCK_NAME).exists()
    with HostLock(tmp_path):
        pass


def test_different_data_dirs_do_not_conflict(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    with HostLock(a), HostLock(b):
        pass


def test_lock_file_holds_only_pid(tmp_path):
    import os

    with HostLock(tmp_path):
        assert (tmp_path / LOCK_NAME).read_text() == str(os.getpid())


def test_lock_is_dropped_when_holder_is_killed(tmp_path):
    code = textwrap.dedent(
        f"""
        import sys, time
        sys.path.insert(0, ".")
        from worker.host_lock import HostLock
        lock = HostLock({str(tmp_path)!r}).acquire()  # keep a reference: a dropped HostLock closes its file and frees the lock
        print("locked", flush=True)
        time.sleep(60)
        """
    )
    proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    try:
        assert proc.stdout.readline().strip() == "locked"
        with pytest.raises(HostLocked):
            HostLock(tmp_path).acquire()
        proc.kill()  # SIGKILL: no cleanup code runs
        proc.wait(timeout=10)
        with HostLock(tmp_path):
            pass  # the OS released the lock; no stale-lock handling needed
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
