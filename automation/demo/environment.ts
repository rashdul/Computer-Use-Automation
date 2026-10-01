/**
 * Demo-only fault injection. Sets RFCU's own Administration -> Environment
 * controls (the same settings an administrator changes in the UI) so a replay
 * meets a real unexpected dialog. Not used by discovery or replay.
 *
 *   tsx automation/demo/environment.ts attestation   # BSA/AML attestation on the member screen (escalate)
 *   tsx automation/demo/environment.ts maintenance   # maintenance notice on the member screen (recoverable)
 *   tsx automation/demo/environment.ts reset
 */
import { readFileSync } from "node:fs";
import { loadDotEnv } from "../safety.js";

loadDotEnv();

/**
 * Administrator for this demo helper only: CUA_ADMIN_USERNAME / CUA_ADMIN_PASSWORD, else the
 * dwhitfield row of RFCU's own credentials file (in GitHub on purpose: RFCU is not an actual app).
 */
function adminCredentials(): { username: string; password: string } {
  const { CUA_ADMIN_USERNAME: username, CUA_ADMIN_PASSWORD: password } = process.env;
  if (username && password) return { username, password };
  const row = readFileSync("target-app/STAFF_CREDENTIALS.local.md", "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith("| `dwhitfield`"));
  const fromFile = row?.split("|").map((c) => c.trim()).filter(Boolean).at(-1)?.replace(/^`|`$/g, "");
  if (!fromFile) throw new Error("set CUA_ADMIN_USERNAME and CUA_ADMIN_PASSWORD, or add the dwhitfield row to target-app/STAFF_CREDENTIALS.local.md");
  return { username: "dwhitfield", password: fromFile };
}

const env = Object.fromEntries(
  readFileSync("target-app/.env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;

async function rpc(token: string, fn: string, body: unknown = {}) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn} failed: HTTP ${res.status}`);
  return res.json();
}

const dialogOnMemberScreen = (kind: string) => ({
  interrupts_enabled: true,
  interrupt_trigger: "member_details",
  interrupt_probability_pct: 100,
  interrupt_kinds: [kind],
  interrupt_once_per_session: true,
  interrupt_delay_ms: 0,
});

async function main() {
  const mode = process.argv[2];
  if (!["attestation", "maintenance", "reset"].includes(mode)) throw new Error("usage: environment.ts attestation|maintenance|reset");
  // Administration requires a fresh password sign-in by a system administrator.
  const admin = adminCredentials();
  const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${admin.username}@rashedfcu.internal`, password: admin.password }),
  });
  if (!auth.ok) throw new Error(`admin sign-in failed: HTTP ${auth.status}`);
  const { access_token } = (await auth.json()) as { access_token: string };

  if (mode === "reset") await rpc(access_token, "admin_reset_environment");
  else await rpc(access_token, "admin_update_environment", { p_patch: dialogOnMemberScreen(mode === "attestation" ? "compliance_attestation" : "maintenance_notice") });
  console.error(`environment: ${mode} applied`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
