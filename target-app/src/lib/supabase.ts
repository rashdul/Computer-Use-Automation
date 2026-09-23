import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy target-app/.env.example to .env.local and fill it in.",
  );
}

/**
 * Sessions live in sessionStorage: closing the tab signs the user out, which
 * is what branch staff expect on shared workstations.
 */
export const supabase = createClient(url, key, {
  auth: {
    storage: window.sessionStorage,
    storageKey: "rfcu.console.auth",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

/**
 * Ends one Auth session by its access token. Used after the Administration
 * password check, which signs in again and so replaces the current session.
 */
export async function endSessionByToken(accessToken: string): Promise<void> {
  await fetch(`${url}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: { apikey: key!, Authorization: `Bearer ${accessToken}` },
  }).catch(() => undefined);
}

/** Staff sign in with a username; Supabase Auth needs an email-shaped identifier. */
export const STAFF_EMAIL_DOMAIN = "rashedfcu.internal";

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${STAFF_EMAIL_DOMAIN}`;
}

/** Seconds since the last password authentication, read from the JWT `amr` claim. */
export function passwordAgeSeconds(accessToken: string | undefined): number | null {
  if (!accessToken) return null;
  try {
    const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const stamps: number[] = (payload.amr ?? [])
      .filter((e: { method?: string }) => e.method === "password")
      .map((e: { timestamp?: number }) => e.timestamp ?? 0);
    if (!stamps.length) return null;
    return Math.floor(Date.now() / 1000) - Math.max(...stamps);
  } catch {
    return null;
  }
}
