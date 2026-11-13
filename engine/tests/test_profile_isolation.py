import pytest

from accounts.profile_manager import ProfileManager


def test_profiles_root_lives_inside_data_dir(tmp_path):
    pm = ProfileManager(str(tmp_path))
    assert pm.root == (tmp_path / "profiles").resolve()
    assert pm.root.is_dir()


def test_each_slot_gets_its_own_sibling_directory(tmp_path):
    pm = ProfileManager(str(tmp_path))
    paths = {i: pm._profile_path(f"acct-{i:02d}") for i in range(1, 11)}
    assert len(set(paths.values())) == 10
    for i, path in paths.items():
        assert path.name == f"slot-{i:02d}"
        assert path.parent == pm.root
        assert path.is_dir()


def test_same_slot_always_maps_to_same_directory(tmp_path):
    pm = ProfileManager(str(tmp_path))
    assert pm._profile_path("acct-05") == pm._profile_path("acct-05")


@pytest.mark.parametrize(
    "bad",
    ["acct-1", "acct-001", "acct-00", "acct-11", "../acct-01", "acct-01/../acct-02", "", "acct-²"],
)
def test_invalid_ids_are_rejected_and_create_nothing(tmp_path, bad):
    pm = ProfileManager(str(tmp_path / "data"))
    with pytest.raises(ValueError):
        pm._profile_path(bad)
    assert list(pm.root.iterdir()) == []
    assert not (tmp_path / "acct-01").exists()


async def test_open_requires_start(tmp_path):
    pm = ProfileManager(str(tmp_path))
    with pytest.raises(RuntimeError, match="start"):
        await pm.open_for_manual_login("acct-01", "https://example.com")
    # a failed open must not have created a profile directory either
    assert list(pm.root.iterdir()) == []


async def test_close_is_safe_when_never_started(tmp_path):
    pm = ProfileManager(str(tmp_path))
    await pm.close()
    await pm.close_account("acct-01")
