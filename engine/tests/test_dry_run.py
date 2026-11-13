import pytest

from adapters.base import NotConfiguredAdapter
from adapters.dry_run import DryRunAdapter
from scheduler.sequential import Job, SequentialScheduler


class ForbiddenProfileManager:
    """Any attribute access fails the test: dry-run and placeholders must never open a profile."""

    def __getattr__(self, name):
        raise AssertionError(f"profile manager touched: {name}")


def make_scheduler():
    return SequentialScheduler(
        ForbiddenProfileManager(),
        {
            "dry-run": DryRunAdapter(),
            "flowkit": NotConfiguredAdapter(),
            "gflow": NotConfiguredAdapter(),
        },
    )


async def test_dry_run_returns_expected_result_without_profile():
    job = Job("t1", "acct-03", "dry-run", {})
    result = await DryRunAdapter().run(job, ForbiddenProfileManager())
    assert result == {
        "ok": True,
        "mode": "dry-run",
        "job_id": "t1",
        "account_id": "acct-03",
        "message": "No Google Flow request was submitted.",
    }


async def test_dry_run_through_scheduler():
    result = await make_scheduler().execute(Job("t2", "acct-01", "dry-run", {}))
    assert result["ok"] is True
    assert result["mode"] == "dry-run"
    assert result["job_id"] == "t2"


@pytest.mark.parametrize("engine", ["flowkit", "gflow"])
async def test_live_engines_stay_disabled(engine):
    with pytest.raises(RuntimeError, match="not configured"):
        await make_scheduler().execute(Job("t3", "acct-01", engine, {}))
