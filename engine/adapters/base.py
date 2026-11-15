class EngineNotConfigured(RuntimeError):
    """The requested engine has no verified implementation. Never retryable."""


class AuthRequired(Exception):
    """The browser session needs the owner to sign in again. The job parks in waiting_for_user."""


class NotConfiguredAdapter:
    """Safe placeholder: no undocumented Flow endpoints or UI selectors."""
    async def run(self, job, profile_manager):
        raise EngineNotConfigured("Live Google Flow adapter is not configured. Implement and verify the current UI workflow before enabling live jobs.")
