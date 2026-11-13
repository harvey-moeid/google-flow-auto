from __future__ import annotations
from pathlib import Path
from playwright.async_api import async_playwright, BrowserContext
from .slots import slot_from_account_id

class ProfileManager:
    """Separate persistent Chromium profile per account. Store only on encrypted trusted disk."""
    def __init__(self, data_dir: str, headless: bool = False):
        self.root = Path(data_dir).resolve() / "profiles"
        self.root.mkdir(parents=True, exist_ok=True)
        self.headless = headless
        self._pw = None
        self._contexts: dict[str, BrowserContext] = {}

    async def start(self):
        self._pw = await async_playwright().start()

    def _profile_path(self, account_id: str) -> Path:
        slot = slot_from_account_id(account_id)
        path = self.root / f"slot-{slot:02d}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def open_for_manual_login(self, account_id: str, origin: str) -> BrowserContext:
        if not self._pw:
            raise RuntimeError("Call start() first")
        if account_id in self._contexts:
            return self._contexts[account_id]
        context = await self._pw.chromium.launch_persistent_context(user_data_dir=str(self._profile_path(account_id)), headless=self.headless, viewport={"width": 1440, "height": 1000}, accept_downloads=True, args=["--no-first-run", "--disable-dev-shm-usage"])
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(origin, wait_until="domcontentloaded")
        self._contexts[account_id] = context
        return context

    async def close_account(self, account_id: str):
        context = self._contexts.pop(account_id, None)
        if context:
            await context.close()

    async def close(self):
        for account_id in list(self._contexts):
            await self.close_account(account_id)
        if self._pw:
            await self._pw.stop()
            self._pw = None
