"""Read-only isolation audit for the ten browser profile directories. Free of Playwright.

Checks (per `<data_dir>/profiles`):
  * only `slot-01` .. `slot-10` directories exist (an alias such as `slot-1` or a copied `slot-01.bak`
    could end up sharing a login);
  * no slot directory is a symlink or resolves outside the profiles root;
  * no two slot directories are the same filesystem object;
  * each slot carries a `.flow-slot` marker naming ITS OWN slot (a directory copied from another slot is
    reported, because it would share that slot Google session).

The result holds slot numbers and short codes only. Paths, file names and profile contents are never
returned, printed or reported to the API.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

MARKER_NAME = ".flow-slot"
_SLOT_DIR = re.compile(r"slot-(0[1-9]|10)")


class ProfileIsolationError(RuntimeError):
    """A profile directory failed an isolation check."""


def marker_text(slot):
    return f"slot-{slot:02d}"


def ensure_marker(profile_dir, slot):
    """Writes the marker on first use; refuses a directory that is marked for a different slot."""
    path = Path(profile_dir) / MARKER_NAME
    try:
        current = path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        path.write_text(marker_text(slot) + "\n", encoding="ascii")
        return
    except (OSError, UnicodeDecodeError):
        raise ProfileIsolationError("Profile marker is unreadable") from None
    if current != marker_text(slot):
        raise ProfileIsolationError("Profile directory is marked for a different slot")


@dataclass
class AuditResult:
    checked: int = 0
    problems: list = field(default_factory=list)  # {"slot": int | None, "code": str}
    unmarked: list = field(default_factory=list)  # legacy profiles; adopted on first open

    @property
    def ok(self):
        return not self.problems

    def as_dict(self):
        return {"ok": self.ok, "checked": self.checked, "problems": self.problems, "unmarked": self.unmarked}


def audit(data_dir):
    result = AuditResult()
    root = Path(data_dir) / "profiles"
    if not root.exists():
        return result
    try:
        real_root = root.resolve(strict=True)
        entries = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError:
        result.problems.append({"slot": None, "code": "profiles_unreadable"})
        return result
    seen = {}
    for entry in entries:
        if not _SLOT_DIR.fullmatch(entry.name):
            result.problems.append({"slot": None, "code": "unexpected_entry"})
            continue
        slot = int(entry.name[5:])
        result.checked += 1
        if entry.is_symlink():
            result.problems.append({"slot": slot, "code": "symlink"})
            continue
        if not entry.is_dir():
            result.problems.append({"slot": slot, "code": "not_a_directory"})
            continue
        try:
            resolved = entry.resolve(strict=True)
            stat = entry.stat()
        except OSError:
            result.problems.append({"slot": slot, "code": "unreadable"})
            continue
        if resolved.parent != real_root:
            result.problems.append({"slot": slot, "code": "outside_root"})
            continue
        key = (stat.st_dev, stat.st_ino)
        if key in seen:
            result.problems.append({"slot": slot, "code": "shared_directory"})
            continue
        seen[key] = slot
        try:
            marker = (entry / MARKER_NAME).read_text(encoding="ascii").strip()
        except FileNotFoundError:
            result.unmarked.append(slot)
            continue
        except (OSError, UnicodeDecodeError):
            result.problems.append({"slot": slot, "code": "marker_unreadable"})
            continue
        if marker != marker_text(slot):
            result.problems.append({"slot": slot, "code": "marker_mismatch"})
    return result
