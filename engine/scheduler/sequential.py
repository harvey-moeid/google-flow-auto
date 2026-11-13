from __future__ import annotations
import asyncio
from dataclasses import dataclass
from typing import Protocol

@dataclass
class Job:
    id: str
    account_id: str
    engine: str
    payload: dict

class Adapter(Protocol):
    async def run(self, job: Job, profile_manager): ...

class SequentialScheduler:
    """Single-process sequential scheduler; production also needs a shared D1/DO lease."""
    def __init__(self, profile_manager, adapters: dict[str, Adapter]):
        self.profile_manager = profile_manager
        self.adapters = adapters
        self._lock = asyncio.Lock()

    async def execute(self, job: Job):
        async with self._lock:
            adapter = self.adapters.get(job.engine)
            if adapter is None:
                raise ValueError(f'Unknown engine: {job.engine}')
            return await adapter.run(job, self.profile_manager)
