from __future__ import annotations
import argparse, asyncio, os
from dotenv import load_dotenv
from accounts.profile_manager import ProfileManager
from scheduler.sequential import SequentialScheduler, Job
from adapters.dry_run import DryRunAdapter
from adapters.base import NotConfiguredAdapter
load_dotenv()
async def main():
 parser=argparse.ArgumentParser();parser.add_argument("--job-id");parser.add_argument("--account-id",default="acct-01");parser.add_argument("--engine",default="dry-run",choices=["dry-run","flowkit","gflow"]);args=parser.parse_args()
 pm=ProfileManager(os.getenv("FLOW_WORKER_DATA_DIR","./.worker-data"),headless=os.getenv("FLOW_HEADLESS","false").lower()=="true");await pm.start()
 scheduler=SequentialScheduler(pm,{"dry-run":DryRunAdapter(),"flowkit":NotConfiguredAdapter(),"gflow":NotConfiguredAdapter()});job=Job(args.job_id or "local-test",args.account_id,args.engine,{})
 try: print(await scheduler.execute(job))
 finally: await pm.close()
if __name__=="__main__": asyncio.run(main())