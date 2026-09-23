import { LogIn } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { ButtonLink } from "../components/Button";
import { StatePage } from "../components/feedback";
import { Logo } from "../components/Logo";
import { useAuth } from "./AuthContext";

const REASONS: Record<string, { title: string; text: string }> = {
  idle: {
    title: "You were signed out after a period of inactivity",
    text: "For security, the console ends sessions that have been idle. An account application in progress is kept for you in this browser tab; other unsaved entries, such as a note you were typing, are not.",
  },
  revoked: {
    title: "Your session has ended",
    text: "The session was ended by an administrator, by a sign-in on another workstation, or because it reached its time limit. An account application in progress is kept for you in this browser tab; other unsaved entries are not.",
  },
  disabled: {
    title: "Your staff account is disabled",
    text: "An administrator disabled this account, so the session was closed. Contact the IT Help Desk (ext. 4400) if you think this is a mistake.",
  },
};

export function SessionExpiredPage() {
  const [params] = useSearchParams();
  const reason = params.get("reason") ?? "revoked";
  const copy = REASONS[reason] ?? REASONS.revoked;
  const next = params.get("next") ?? "/members";

  useEffect(() => {
    document.title = "Session ended · RFCU Member Services";
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "var(--page)", padding: "56px 24px" }}>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <Logo tone="light" size={34} />
      </div>
      <StatePage
        tone={reason === "disabled" ? "bad" : "info"}
        code={reason === "idle" ? "Session timed out" : reason === "disabled" ? "Account disabled" : "Session ended"}
        title={copy.title}
        actions={
          reason === "disabled" ? undefined : (
            <ButtonLink to={`/login?next=${encodeURIComponent(next)}`} variant="primary" icon={<LogIn size={15} aria-hidden="true" />}>
              Sign in again
            </ButtonLink>
          )
        }
        foot="After you sign in, you'll return to the screen you were on."
      >
        {copy.text}
      </StatePage>
    </div>
  );
}

export function FullScreenLoading({ label = "Starting your session…" }: { label?: string }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--page)" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, color: "var(--text-2)" }}>
        <Logo tone="light" size={34} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span className="spinner" aria-hidden="true" /> {label}
        </span>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <FullScreenLoading />;
  if (status === "signing_out") return <FullScreenLoading label="Signing out…" />;
  if (status === "signed_out") {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
