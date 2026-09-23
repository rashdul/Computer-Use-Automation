import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, onSessionExpired, setEnvironment } from "../lib/api";
import { isApiError } from "../lib/errors";
import { endSessionByToken, passwordAgeSeconds, supabase, usernameToEmail } from "../lib/supabase";
import type { EnvironmentSettings, Permission, SessionContext } from "../lib/types";
import { clearAllDrafts } from "../pages/opening/draft";

export type ExpiryReason = "idle" | "revoked" | "disabled";

interface AuthState {
  /** signing_out: leaving on purpose — guards must not redirect while it lasts. */
  status: "loading" | "signed_out" | "signing_out" | "ready";
  context: SessionContext | null;
  environment: EnvironmentSettings | null;
  can: (permission: Permission) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  expire: (reason: ExpiryReason) => Promise<void>;
  stepUp: (password: string) => Promise<void>;
  /** True when Administration needs the password confirmed again. */
  needsStepUp: () => boolean;
  /** True while the session is ending; unsaved-work guards must let navigation through. */
  isLeaving: () => boolean;
  refresh: () => Promise<void>;
  setEnvironmentLocal: (env: EnvironmentSettings) => void;
}

const AuthContext = createContext<AuthState | null>(null);

const STEP_UP_KEY = "rfcu.console.stepup";
const STEP_UP_WINDOW_S = 15 * 60;
export const JUST_SIGNED_IN_KEY = "rfcu.console.just-signed-in";
const LAST_USER_KEY = "rfcu.console.last-user";
const PUBLIC_PATHS = ["/login", "/session-expired"];

export class SignInError extends Error {}

function signInMessage(err: { message?: string; status?: number; code?: string } | null): string {
  if (!err) return "Sign-in failed. Try again.";
  if (err.status === 429) return "Too many sign-in attempts. Wait a minute, then try again.";
  if (err.status === 400 || /invalid login credentials/i.test(err.message ?? "")) {
    return "The username or password is incorrect.";
  }
  if (err.status === 0 || /fetch/i.test(err.message ?? "")) return "Can't reach the sign-in service. Check the workstation's connection.";
  return "Sign-in failed. Try again, or contact the IT Help Desk (ext. 4400).";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [context, setContext] = useState<SessionContext | null>(null);
  const [environment, setEnv] = useState<EnvironmentSettings | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const expiring = useRef(false);
  const signingOut = useRef(false);
  const leaving = useRef(false);
  /** Set when signing out or expiring; the reset finishes once a public page is showing. */
  const pendingReset = useRef(false);
  const locationRef = useRef(location);
  locationRef.current = location;

  const applyEnvironment = useCallback((env: EnvironmentSettings) => {
    setEnvironment(env);
    setEnv(env);
  }, []);

  const loadContext = useCallback(async () => {
    const ctx = await api.sessionContext();
    applyEnvironment(ctx.environment);
    setContext(ctx);
    setStatus("ready");
    return ctx;
  }, [applyEnvironment]);

  /** Revokes the Auth session on the server and drops the stored tokens. */
  const endServerSession = useCallback(async () => {
    signingOut.current = true;
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    signingOut.current = false;
  }, []);

  /** Forgets the signed-in user in this tab. */
  const resetLocal = useCallback(() => {
    setContext(null);
    setEnvironment(null);
    setEnv(null);
    setStatus("signed_out");
    sessionStorage.removeItem(STEP_UP_KEY);
    queryClient.clear();
  }, [queryClient]);

  const clearLocal = useCallback(async () => {
    await endServerSession();
    resetLocal();
  }, [endServerSession, resetLocal]);

  /**
   * Revoke first, then leave. The reset waits until the router has committed a
   * public page: dropping to "signed_out" while a protected route is still
   * mounted would let the route guard redirect to sign-in and lose the reason.
   */
  const leaveTo = useCallback(
    async (target: string) => {
      await endServerSession();
      pendingReset.current = true;
      await navigate(target, { replace: true });
    },
    [endServerSession, navigate],
  );

  useEffect(() => {
    if (!pendingReset.current || status !== "signing_out") return;
    if (!PUBLIC_PATHS.some((p) => location.pathname.startsWith(p))) return;
    pendingReset.current = false;
    expiring.current = false;
    resetLocal();
    // location.key changes on every navigation, including to the same path with a new reason
  }, [location.key, location.pathname, status, resetLocal]);

  const expire = useCallback(
    async (reason: ExpiryReason) => {
      if (expiring.current) return;
      expiring.current = true;
      leaving.current = true;
      setStatus("signing_out");
      const loc = locationRef.current;
      const next = loc.pathname + loc.search;
      if (reason === "idle") {
        await api.recordAuthEvent("idle_timeout", { route: loc.pathname }).catch(() => undefined);
      }
      const safeNext = next.startsWith("/login") || next.startsWith("/session-expired") ? "/members" : next;
      await leaveTo(`/session-expired?reason=${reason}&next=${encodeURIComponent(safeNext)}`);
    },
    [leaveTo],
  );

  // Any RPC answering 401 (session ended server-side) or 403 PT403 (account disabled).
  useEffect(() => {
    onSessionExpired((reason) => {
      if (status === "ready") void expire(reason);
    });
  }, [expire, status]);

  // Restore an existing tab session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        if (!cancelled) setStatus("signed_out");
        return;
      }
      try {
        await loadContext();
      } catch (e) {
        if (cancelled) return;
        // the session ended server-side while the tab was open: say so instead of showing a bare sign-in page
        if (isApiError(e) && e.kind === "session_expired") void expire("revoked");
        else if (isApiError(e) && e.kind === "account_disabled") void expire("disabled");
        else setStatus("signed_out");
      }
    })();
    return () => {
      cancelled = true;
    };
    // restore once per page load
  }, []);

  // A refresh-token failure (session deleted server-side) signs the client out.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" && status === "ready" && !signingOut.current && !expiring.current) {
        void expire("revoked");
      }
    });
    return () => data.subscription.unsubscribe();
  }, [expire, status]);

  // Heartbeat: detects revoked sessions and picks up environment / permission changes.
  useEffect(() => {
    if (status !== "ready") return;
    const beat = async () => {
      try {
        const hb = await api.heartbeat();
        applyEnvironment(hb.environment);
        setContext((c) => (c ? { ...c, permissions: hb.permissions, environment: hb.environment } : c));
      } catch {
        /* 401s are handled globally; transient failures are ignored */
      }
    };
    const t = window.setInterval(beat, 30_000);
    const onFocus = () => void beat();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [status, applyEnvironment]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(username), password });
      if (error) throw new SignInError(signInMessage(error));
      leaving.current = false;
      // application drafts belong to whoever started them
      if (sessionStorage.getItem(LAST_USER_KEY) !== username.trim().toLowerCase()) clearAllDrafts();
      sessionStorage.setItem(LAST_USER_KEY, username.trim().toLowerCase());
      try {
        await api.recordAuthEvent("sign_in");
        sessionStorage.setItem(STEP_UP_KEY, "0");
        sessionStorage.setItem(JUST_SIGNED_IN_KEY, "1");
        await loadContext();
      } catch (e) {
        await clearLocal();
        if (isApiError(e) && e.kind === "account_disabled") {
          throw new SignInError("This staff account is disabled. Contact the IT Help Desk (ext. 4400).");
        }
        throw new SignInError("Signed in, but your staff profile couldn't be loaded. Try again.");
      }
    },
    [loadContext, clearLocal],
  );

  const signOut = useCallback(async () => {
    leaving.current = true;
    setStatus("signing_out");
    await api.recordAuthEvent("sign_out").catch(() => undefined);
    clearAllDrafts();
    await leaveTo("/login?signed_out=1");
  }, [leaveTo]);

  const stepUp = useCallback(
    async (password: string) => {
      if (!context) throw new SignInError("You're signed out.");
      const previous = (await supabase.auth.getSession()).data.session?.access_token;
      const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(context.staff.username), password });
      if (error) {
        throw new SignInError(error.status === 400 ? "That password is incorrect." : signInMessage(error));
      }
      // the re-check opened a fresh session; don't leave the old one behind
      if (previous) void endSessionByToken(previous);
      sessionStorage.setItem(STEP_UP_KEY, String(Date.now()));
      await api.recordAuthEvent("step_up").catch(() => undefined);
    },
    [context],
  );

  const needsStepUp = useCallback(() => {
    const confirmedAt = Number(sessionStorage.getItem(STEP_UP_KEY) ?? "0");
    const recentlyConfirmed = Date.now() - confirmedAt < STEP_UP_WINDOW_S * 1000;
    return !recentlyConfirmed;
  }, []);

  const isLeaving = useCallback(() => leaving.current, []);

  const refresh = useCallback(async () => {
    await loadContext();
  }, [loadContext]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      context,
      environment,
      can: (p) => !!context?.permissions.includes(p),
      signIn,
      signOut,
      expire,
      stepUp,
      needsStepUp,
      isLeaving,
      refresh,
      setEnvironmentLocal: applyEnvironment,
    }),
    [status, context, environment, signIn, signOut, expire, stepUp, needsStepUp, isLeaving, refresh, applyEnvironment],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** Password age from the current JWT (server enforces the same 15-minute window). */
export async function currentPasswordAge(): Promise<number | null> {
  const { data } = await supabase.auth.getSession();
  return passwordAgeSeconds(data.session?.access_token);
}
