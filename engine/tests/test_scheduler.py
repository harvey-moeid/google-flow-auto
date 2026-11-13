import asyncio

import pytest

from scheduler.sequential import Job, SequentialScheduler


class TrackingAdapter:
    """Records overlap. Several adapters can share one state to prove a single global lane."""

    def __init__(self, state, delay=0.01):
        self.state = state
        self.delay = delay

    async def run(self, job, profile_manager):
        self.state["active"] += 1
        self.state["max_active"] = max(self.state["max_active"], self.state["active"])
        self.state["order"].append(("start", job.id))
        await asyncio.sleep(self.delay)
        self.state["order"].append(("end", job.id))
        self.state["active"] -= 1
        return {"job_id": job.id, "engine": job.engine}


class FailingAdapter:
    async def run(self, job, profile_manager):
        raise RuntimeError("boom")


def new_state():
    return {"active": 0, "max_active": 0, "order": []}


def make_job(job_id, engine="a", account_id="acct-01"):
    return Job(job_id, account_id, engine, {})


async def test_concurrent_submissions_never_overlap_and_keep_order():
    state = new_state()
    scheduler = SequentialScheduler(object(), {"a": TrackingAdapter(state)})
    jobs = [make_job(f"j{i}") for i in range(8)]
    results = await asyncio.gather(*(scheduler.execute(j) for j in jobs))
    assert state["max_active"] == 1
    expected = []
    for j in jobs:
        expected += [("start", j.id), ("end", j.id)]
    assert state["order"] == expected
    assert [r["job_id"] for r in results] == [j.id for j in jobs]


async def test_lane_is_global_across_engines_and_accounts():
    state = new_state()
    scheduler = SequentialScheduler(
        object(), {"a": TrackingAdapter(state), "b": TrackingAdapter(state)}
    )
    jobs = [
        make_job("j0", "a", "acct-01"),
        make_job("j1", "b", "acct-02"),
        make_job("j2", "a", "acct-03"),
        make_job("j3", "b", "acct-04"),
    ]
    await asyncio.gather(*(scheduler.execute(j) for j in jobs))
    assert state["max_active"] == 1


async def test_unknown_engine_raises_and_releases_lock():
    state = new_state()
    scheduler = SequentialScheduler(object(), {"a": TrackingAdapter(state)})
    with pytest.raises(ValueError, match="Unknown engine"):
        await scheduler.execute(make_job("bad", engine="nope"))
    result = await asyncio.wait_for(scheduler.execute(make_job("good")), timeout=2)
    assert result["job_id"] == "good"


async def test_adapter_failure_releases_lock():
    state = new_state()
    scheduler = SequentialScheduler(
        object(), {"fail": FailingAdapter(), "a": TrackingAdapter(state)}
    )
    with pytest.raises(RuntimeError, match="boom"):
        await scheduler.execute(make_job("x", engine="fail"))
    result = await asyncio.wait_for(scheduler.execute(make_job("y")), timeout=2)
    assert result["job_id"] == "y"


async def test_failure_in_queue_does_not_block_later_jobs():
    state = new_state()
    scheduler = SequentialScheduler(
        object(), {"fail": FailingAdapter(), "a": TrackingAdapter(state)}
    )
    outcomes = await asyncio.gather(
        scheduler.execute(make_job("1")),
        scheduler.execute(make_job("2", engine="fail")),
        scheduler.execute(make_job("3")),
        return_exceptions=True,
    )
    assert outcomes[0]["job_id"] == "1"
    assert isinstance(outcomes[1], RuntimeError)
    assert outcomes[2]["job_id"] == "3"
    assert state["max_active"] == 1


async def test_profile_manager_is_passed_to_adapter():
    seen = []

    class Capture:
        async def run(self, job, profile_manager):
            seen.append(profile_manager)
            return {}

    marker = object()
    scheduler = SequentialScheduler(marker, {"a": Capture()})
    await scheduler.execute(make_job("j"))
    assert seen == [marker]
