class NotConfiguredAdapter:
    """Safe placeholder: no undocumented Flow endpoints or UI selectors."""
    async def run(self, job, profile_manager):
        raise RuntimeError("Live Google Flow adapter is not configured. Implement and verify the current UI workflow before enabling live jobs.")
