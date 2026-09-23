import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router";
import { SignInError, useAuth } from "../../auth/AuthContext";
import { PasswordInput } from "../../auth/LoginPage";
import { Button } from "../../components/Button";
import { Banner, LoadError, SkeletonLines } from "../../components/feedback";
import { Field, Input } from "../../components/form";
import { Tabs } from "../../components/navigation";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { PermissionDenied } from "../StatePages";

export function AdminLayout() {
  useDocumentTitle("Administration");
  const { can, needsStepUp } = useAuth();
  const qc = useQueryClient();
  const [unlocked, setUnlocked] = useState(() => !needsStepUp());

  // the database refuses admin calls 15 minutes after the last password entry
  useEffect(() => {
    const relock = (error: unknown) => {
      if (isApiError(error) && error.kind === "step_up_required") {
        sessionStorage.setItem("rfcu.console.stepup", "0");
        setUnlocked(false);
      }
    };
    const unsubQ = qc.getQueryCache().subscribe((e) => relock(e.query.state.error));
    const unsubM = qc.getMutationCache().subscribe((e) => relock(e.mutation?.state.error));
    return () => {
      unsubQ();
      unsubM();
    };
  }, [qc]);

  if (!can("admin.console")) return <ServerDenied />;
  if (!unlocked) return <StepUpGate onUnlocked={() => setUnlocked(true)} />;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header__text">
          <div className="page-header__eyebrow">UAT environment</div>
          <h1>Administration</h1>
          <p>Staff access, environment controls, products, and the audit trail. Every change here is recorded.</p>
        </div>
      </div>
      <div className="admin-nav">
        <Tabs
          label="Administration sections"
          items={[
            { to: "/admin", label: "Overview", end: true },
            { to: "/admin/environment", label: "Environment controls" },
            { to: "/admin/staff", label: "Staff & sessions" },
            { to: "/admin/permissions", label: "Roles & permissions" },
            { to: "/admin/products", label: "Products" },
            { to: "/admin/audit", label: "Audit log" },
            { to: "/admin/test-data", label: "Test data" },
          ]}
        />
      </div>
      <Outlet />
    </div>
  );
}

/** Non-administrators still hit the server so the attempt is audited and referenced. */
function ServerDenied() {
  const q = useQuery({ queryKey: ["admin-probe"], queryFn: api.admin.overview, retry: false });
  if (q.isPending) {
    return (
      <div className="page">
        <div className="panel panel__body">
          <SkeletonLines lines={4} />
        </div>
      </div>
    );
  }
  if (isApiError(q.error) && q.error.kind === "permission_denied") return <PermissionDenied error={q.error} subject="Administration" />;
  return (
    <div className="page">
      <LoadError error={q.error} onRetry={() => q.refetch()} what="Administration" />
    </div>
  );
}

function StepUpGate({ onUnlocked }: { onUnlocked: () => void }) {
  const { context, stepUp } = useAuth();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    wrapRef.current?.querySelector<HTMLInputElement>("input[type='password']")?.focus();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await stepUp(password);
      await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("admin") });
      onUnlocked();
    } catch (err) {
      setError(err instanceof SignInError ? err.message : "Couldn't confirm your password. Try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <section className="state state--info" aria-labelledby="stepup-title" style={{ maxWidth: 480 }}>
        <div className="state__stripe" />
        <form className="state__body" onSubmit={submit} ref={wrapRef} noValidate>
          <div className="state__code" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <LockKeyhole size={13} aria-hidden="true" /> Privileged access
          </div>
          <h1 className="state__title" id="stepup-title">
            Confirm your password
          </h1>
          <p className="state__text">
            Administration changes staff access and live environment controls. Re-enter your password to continue — you'll stay unlocked
            for 15 minutes.
          </p>
          <div className="stack stack--sm" style={{ marginTop: 18 }}>
            {error && (
              <Banner tone="bad" live>
                {error}
              </Banner>
            )}
            <Field label="Username">
              <Input value={context?.staff.username ?? ""} readOnly autoComplete="username" />
            </Field>
            <Field label="Password">
              <PasswordInput value={password} onChange={setPassword} visible={show} onToggle={() => setShow((v) => !v)} />
            </Field>
            <Button type="submit" variant="primary" size="lg" block loading={busy} loadingText="Confirming…" icon={<KeyRound size={15} aria-hidden="true" />}>
              Unlock Administration
            </Button>
          </div>
        </form>
        <div className="state__foot" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldCheck size={14} aria-hidden="true" /> The database enforces the same 15-minute window on every administrative request.
        </div>
      </section>
    </div>
  );
}
