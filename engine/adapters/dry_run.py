class DryRunAdapter:
    async def run(self, job, profile_manager):
        return {"ok": True, "mode": "dry-run", "job_id": job.id, "account_id": job.account_id, "message": "No Google Flow request was submitted."}
