"""Put the scenario-catalogue members back to their seeded state.

Signs in as the system administrator through Supabase Auth (a fresh password
sign-in satisfies the 15-minute step-up window) and calls the audited
admin_reset_scenarios RPC. Optionally also resets environment controls.

    python target-app/tests/ui/reset_scenarios.py [--environment]
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from support import APP_ROOT, password_for


def env_value(key: str) -> str:
    for line in (APP_ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip()
    raise SystemExit(f"{key} missing from target-app/.env.local")


URL = env_value("VITE_SUPABASE_URL")
KEY = env_value("VITE_SUPABASE_PUBLISHABLE_KEY")


def call(path: str, body: dict, token: str | None = None) -> tuple[int, object]:
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(), method="POST")
    req.add_header("apikey", KEY)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def main() -> int:
    status, auth = call("/auth/v1/token?grant_type=password", {"email": "dwhitfield@rashedfcu.internal", "password": password_for("dwhitfield")})
    if status != 200:
        print("admin sign-in failed:", status)
        return 1
    token = auth["access_token"]  # type: ignore[index]
    status, body = call("/rest/v1/rpc/admin_reset_scenarios", {}, token)
    print("reset scenarios:", status, body)
    if "--environment" in sys.argv:
        status, env = call("/rest/v1/rpc/admin_reset_environment", {}, token)
        print("reset environment:", status)
    call("/auth/v1/logout?scope=local", {}, token)
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
