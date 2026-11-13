import pytest

from accounts.registry import LocalRegistry
from accounts.slots import account_id_for_slot, slot_from_account_id


@pytest.mark.parametrize("slot", range(1, 11))
def test_valid_ids_round_trip(slot):
    account_id = f"acct-{slot:02d}"
    assert slot_from_account_id(account_id) == slot
    assert account_id_for_slot(slot) == account_id


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "acct-",
        "acct-0",
        "acct-1",  # alias of acct-01
        "acct-001",  # alias of acct-01
        "acct-00",
        "acct-11",
        "acct-100",
        "ACCT-01",
        " acct-01",
        "acct-01 ",
        "acct-01\n",
        "acct-+1",
        "acct--1",
        "acct-0１",  # full-width digit
        "acct-²",  # superscript two: str.isdigit() is True for it
        "acct-01/../acct-02",
        "../acct-01",
        "slot-01",
        "acct-01\x00",
    ],
)
def test_invalid_ids_rejected(bad):
    with pytest.raises(ValueError):
        slot_from_account_id(bad)


@pytest.mark.parametrize("bad", [None, 1, 1.5, b"acct-01", ["acct-01"]])
def test_non_string_ids_rejected(bad):
    with pytest.raises(ValueError):
        slot_from_account_id(bad)


@pytest.mark.parametrize("bad", [0, 11, -1, 100, True, False, 1.0, "1", None])
def test_invalid_slot_numbers_rejected(bad):
    with pytest.raises(ValueError):
        account_id_for_slot(bad)


def test_default_registry_has_ten_unique_valid_slots(tmp_path):
    registry = LocalRegistry(str(tmp_path))
    slots = registry.list_slots()
    assert len(slots) == 10
    assert len({s["account_id"] for s in slots}) == 10
    assert [s["slot"] for s in slots] == list(range(1, 11))
    for s in slots:
        assert slot_from_account_id(s["account_id"]) == s["slot"]
    # reading the defaults must not persist anything
    assert not registry.path.exists()
