"""Runs every UI walkthrough in order against the console on localhost:5173.

Scenario members and environment controls are reset before and after, so runs
are repeatable (the opening walkthrough expects the happy-path member to have
no 12-month certificate yet). Screenshots land in target-app/test-output/.

    python <webapp-testing>/scripts/with_server.py --server "npm run dev" --port 5173 --timeout 60 \
        -- python tests/ui/run_all.py [walk_faults.py ...]
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WALKS = ["recon.py", "walk_members.py", "walk_opening.py", "walk_admin.py", "walk_faults.py"]


def reset() -> int:
    return subprocess.call([sys.executable, str(HERE / "reset_scenarios.py"), "--environment"], cwd=HERE)


def main() -> int:
    walks = sys.argv[1:] or WALKS
    if reset():
        print("Couldn't reset scenario data; stopping.")
        return 1
    started = time.time()
    failed = [name for name in walks if subprocess.call([sys.executable, str(HERE / name)], cwd=HERE)]
    reset()
    print(f"\n{len(walks) - len(failed)}/{len(walks)} walkthroughs passed in {time.time() - started:.0f}s")
    if failed:
        print("Failed:", ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
