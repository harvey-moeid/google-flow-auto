import pytest
pytest.importorskip("cryptography")
from worker.profile_backup import ProfileBackupError, create_backup, restore_backup
from worker.profile_audit import MARKER_NAME, ensure_marker, audit


def make_profiles(data_dir, slots=(1, 2)):
    root = data_dir / "profiles"
    for slot in slots:
        profile = root / f"slot-{slot:02d}"
        profile.mkdir(parents=True)
        ensure_marker(profile, slot)
        (profile / "Cookies").write_bytes(f"session-{slot}".encode())
        (profile / "Default").mkdir()
        (profile / "Default" / "Preferences").write_text(f'{{"slot":{slot}}}')
    return root


def test_encrypted_backup_restore_round_trip(tmp_path):
    source, restored = tmp_path / "source", tmp_path / "restored"
    make_profiles(source)
    backup = tmp_path / "profiles.gfab"
    result = create_backup(source, backup, "correct horse battery staple")
    assert result["ok"] and backup.exists()
    assert b"session-1" not in backup.read_bytes()
    restored.mkdir()
    result = restore_backup(restored, backup, "correct horse battery staple")
    assert result == {"ok": True, "operation": "restore", "slots": 2}
    for slot in (1, 2):
        profile = restored / "profiles" / f"slot-{slot:02d}"
        assert (profile / "Cookies").read_text() == f"session-{slot}"
        assert (profile / MARKER_NAME).read_text().strip() == f"slot-{slot:02d}"
    assert audit(restored).ok


def test_wrong_passphrase_does_not_create_profiles(tmp_path):
    source = tmp_path / "source"
    make_profiles(source, slots=(1,))
    backup = tmp_path / "profiles.gfab"
    create_backup(source, backup, "correct horse battery staple")
    restored = tmp_path / "restored"
    restored.mkdir()
    with pytest.raises(ProfileBackupError, match="authentication failed"):
        restore_backup(restored, backup, "wrong passphrase value")
    assert not (restored / "profiles").exists()


def test_modified_backup_is_rejected_without_profile_write(tmp_path):
    source = tmp_path / "source"
    make_profiles(source, slots=(1,))
    backup = tmp_path / "profiles.gfab"
    create_backup(source, backup, "correct horse battery staple")
    content = bytearray(backup.read_bytes())
    content[len(content) // 2] ^= 1
    backup.write_bytes(content)
    restored = tmp_path / "restored"
    restored.mkdir()
    with pytest.raises(ProfileBackupError, match="authentication failed"):
        restore_backup(restored, backup, "correct horse battery staple")
    assert not (restored / "profiles").exists()


def test_backup_refuses_unmarked_profiles(tmp_path):
    root = make_profiles(tmp_path, slots=(1,))
    (root / "slot-01" / MARKER_NAME).unlink()
    with pytest.raises(ProfileBackupError, match="isolation markers"):
        create_backup(tmp_path, tmp_path / "out.gfab", "correct horse battery staple")


def test_backup_refuses_symlink_inside_profile(tmp_path):
    root = make_profiles(tmp_path, slots=(1,))
    target = tmp_path / "outside"
    target.write_text("do not include")
    try:
        (root / "slot-01" / "linked").symlink_to(target)
    except OSError:
        pytest.skip("symlinks unavailable")
    with pytest.raises(ProfileBackupError, match="Symlinks"):
        create_backup(tmp_path, tmp_path / "out.gfab", "correct horse battery staple")


def test_backup_never_overwrites_existing_file(tmp_path):
    make_profiles(tmp_path, slots=(1,))
    output = tmp_path / "out.gfab"
    output.write_text("keep")
    with pytest.raises(ProfileBackupError, match="already exists"):
        create_backup(tmp_path, output, "correct horse battery staple")
    assert output.read_text() == "keep"


def test_restore_refuses_to_overwrite_existing_profiles(tmp_path):
    source = tmp_path / "source"
    make_profiles(source, slots=(1,))
    backup = tmp_path / "out.gfab"
    create_backup(source, backup, "correct horse battery staple")
    destination = tmp_path / "destination"
    make_profiles(destination, slots=(2,))
    with pytest.raises(ProfileBackupError, match="refuses to overwrite"):
        restore_backup(destination, backup, "correct horse battery staple")
    assert (destination / "profiles" / "slot-02" / "Cookies").read_text() == "session-2"


def test_short_passphrase_is_rejected(tmp_path):
    make_profiles(tmp_path, slots=(1,))
    with pytest.raises(ProfileBackupError, match="at least 12"):
        create_backup(tmp_path, tmp_path / "out.gfab", "too-short")
