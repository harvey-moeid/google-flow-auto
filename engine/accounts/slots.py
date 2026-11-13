"""Strict account-slot identifiers. Kept free of Playwright so it is cheap to import and test."""
from __future__ import annotations
import re

MIN_SLOT = 1
MAX_SLOT = 10

# Exactly "acct-01" .. "acct-10", ASCII only. Aliases such as "acct-1", "acct-001" or
# full-width digits are rejected so two identifiers can never share one browser profile.
_ACCOUNT_ID = re.compile(r"acct-(0[1-9]|10)")


def slot_from_account_id(account_id: str) -> int:
    if not isinstance(account_id, str) or not _ACCOUNT_ID.fullmatch(account_id):
        raise ValueError("Invalid account slot identifier")
    return int(account_id[5:])


def account_id_for_slot(slot: int) -> str:
    if not isinstance(slot, int) or isinstance(slot, bool) or not MIN_SLOT <= slot <= MAX_SLOT:
        raise ValueError("Account slot must be between 1 and 10")
    return f"acct-{slot:02d}"
