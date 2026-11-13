from dataclasses import dataclass
from pathlib import Path
import json

@dataclass
class AccountSlot:
    account_id: str
    slot: int
    label: str

class LocalRegistry:
    """Local worker registry only. D1 remains the source of truth for jobs."""
    def __init__(self, root: str):
        self.path = Path(root) / "accounts.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def list_slots(self):
        if self.path.exists():
            return json.loads(self.path.read_text())
        return [{"account_id": f"acct-{i:02d}", "slot": i, "label": f"Google Account {i:02d}"} for i in range(1, 11)]
