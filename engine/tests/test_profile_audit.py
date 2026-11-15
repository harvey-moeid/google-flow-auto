import os

import pytest

from worker.profile_audit import MARKER_NAME, ProfileIsolationError, audit, ensure_marker


def make_profiles(data_dir, slots=range(1, 11)):
    root = data_dir / "profiles"
    for n in slots:
        d = root / f"slot-{n:02d}"
        d.mkdir(parents=True)
        ensure_marker(d, n)
        (d / "Cookies").write_text(f"session-of-{n:02d}")
    return root


def codes(result):
    return sorted((p["slot"], p["code"]) for p in result.problems)


def test_no_profiles_dir_is_ok(tmp_path):
    result = audit(tmp_path)
    assert result.ok and result.checked == 0


def test_ten_clean_profiles_pass(tmp_path):
    make_profiles(tmp_path)
    result = audit(tmp_path)
    assert result.ok and result.checked == 10 and result.unmarked == []


def test_isolation_survives_a_simulated_restart(tmp_path):
    make_profiles(tmp_path)
    for _ in range(3):  # each loop = a fresh process re-reading the same disk
        assert audit(tmp_path).ok
        for n in range(1, 11):
            d = tmp_path / "profiles" / f"slot-{n:02d}"
            assert (d / "Cookies").read_text() == f"session-of-{n:02d}"
            assert (d / MARKER_NAME).read_text().strip() == f"slot-{n:02d}"
            ensure_marker(d, n)  # reopening the same slot is always accepted


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_symlinked_slot_is_reported(tmp_path):
    root = make_profiles(tmp_path, slots=range(1, 3))
    (root / "slot-03").symlink_to(root / "slot-01", target_is_directory=True)
    assert codes(audit(tmp_path)) == [(3, "symlink")]


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_slot_pointing_outside_root_is_reported(tmp_path):
    root = make_profiles(tmp_path, slots=range(1, 3))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (root / "slot-04").symlink_to(elsewhere, target_is_directory=True)
    assert (4, "symlink") in codes(audit(tmp_path))


def test_alias_and_copy_directories_are_unexpected(tmp_path):
    root = make_profiles(tmp_path, slots=range(1, 3))
    (root / "slot-1").mkdir()
    (root / "slot-01.bak").mkdir()
    assert codes(audit(tmp_path)) == [(None, "unexpected_entry"), (None, "unexpected_entry")]


def test_profile_copied_from_another_slot_is_reported(tmp_path):
    root = make_profiles(tmp_path, slots=range(1, 3))
    (root / "slot-02" / MARKER_NAME).write_text("slot-01\n")  # slot-01 files copied into slot-02
    assert codes(audit(tmp_path)) == [(2, "marker_mismatch")]


def test_legacy_profile_without_marker_is_a_warning_not_an_error(tmp_path):
    root = make_profiles(tmp_path, slots=range(1, 3))
    (root / "slot-02" / MARKER_NAME).unlink()
    result = audit(tmp_path)
    assert result.ok and result.unmarked == [2]


def test_ensure_marker_adopts_unmarked_and_refuses_foreign(tmp_path):
    d = tmp_path / "slot-05"
    d.mkdir()
    ensure_marker(d, 5)
    assert (d / MARKER_NAME).read_text().strip() == "slot-05"
    with pytest.raises(ProfileIsolationError):
        ensure_marker(d, 6)


def test_result_never_contains_paths(tmp_path):
    root = make_profiles(tmp_path, slots=range(1, 3))
    (root / "slot-02" / MARKER_NAME).write_text("slot-01\n")
    (root / "evil-name").mkdir()
    dumped = repr(audit(tmp_path).as_dict())
    assert str(tmp_path) not in dumped and "evil-name" not in dumped and "session-of" not in dumped
