import { readFile } from "node:fs/promises";
import { parse } from "dotenv";

/** Only the target app is allowed to use its configured backend. The agent has no network action. */
export async function targetBackendOrigin(): Promise<string | undefined> {
  const file = await readFile("target-app/.env.local", "utf8").catch(() => "");
  const configured =
    process.env.RFCU_BACKEND_ORIGIN ?? parse(file).VITE_SUPABASE_URL;
  if (!configured) return undefined;
  return new URL(configured).origin;
}
const SAFE_RPC = new Set([
  "get_session_context",
  "session_heartbeat",
  "record_auth_event",
  "search_members",
  "get_recent_members",
  "get_member",
  "get_member_accounts",
  "get_account",
  "get_account_transactions",
]);
export function allowResource(
  url: string,
  appOrigin: string,
  backendOrigin?: string,
) {
  const u = new URL(url);
  if (u.origin === appOrigin) return true;
  if (u.origin !== backendOrigin) return false;
  if (
    ["/auth/v1/token", "/auth/v1/user", "/auth/v1/logout"].includes(u.pathname)
  )
    return true;
  const rpc = u.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  return !!rpc && SAFE_RPC.has(rpc[1]);
}
