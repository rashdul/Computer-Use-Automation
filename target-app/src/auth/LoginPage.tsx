import { Eye, EyeOff, LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Button } from "../components/Button";
import { EnvTag } from "../components/display";
import { Banner } from "../components/feedback";
import { Field, Input } from "../components/form";
import { Logo } from "../components/Logo";
import { SignInError, useAuth } from "./AuthContext";

function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return "/members";
  return next;
}

export function LoginPage() {
  const { status, signIn } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const next = safeNext(params.get("next"));

  useEffect(() => {
    document.title = "Sign in · RFCU Member Services";
    usernameRef.current?.focus();
  }, []);

  if (status === "ready") return <Navigate to={next} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof fieldErrors = {};
    if (!username.trim()) errs.username = "Enter your username.";
    if (!password) errs.password = "Enter your password.";
    setFieldErrors(errs);
    setError(null);
    if (errs.username || errs.password) return;
    setBusy(true);
    try {
      await signIn(username, password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof SignInError ? err.message : "Sign-in failed. Try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth__brand">
        <div className="auth__brand-top">
          <Logo tone="dark" size={36} />
          <EnvTag />
        </div>
        <div className="auth__headline">
          <div className="auth__rule" />
          <h1>Member Services Console</h1>
          <p>Member lookup, account servicing, and sub-account opening for branch and contact-center staff.</p>
        </div>
        <p className="auth__legal">
          Authorized use only. Activity in this system is recorded and reviewed under RFCU Information Security Policy 4.2 and the Bank
          Secrecy Act. Federally insured by NCUA. This is a user-acceptance environment containing synthetic member data.
        </p>
      </aside>

      <main className="auth__panel">
        <form className="auth__form" onSubmit={submit} noValidate aria-describedby={error ? "signin-error" : undefined}>
          <h2>Sign in</h2>
          <p>Use your RFCU network username and password.</p>

          <div className="auth__fields">
            {params.get("signed_out") && !error && (
              <Banner tone="ok" live>
                You've signed out.
              </Banner>
            )}
            {error && (
              <Banner tone="bad" live id="signin-error">
                {error}
              </Banner>
            )}
            <Field label="Username" error={fieldErrors.username}>
              <Input
                ref={usernameRef}
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field label="Password" error={fieldErrors.password}>
              <PasswordInput value={password} onChange={setPassword} visible={showPassword} onToggle={() => setShowPassword((v) => !v)} />
            </Field>
            <Button type="submit" variant="primary" size="lg" block loading={busy} loadingText="Signing in…" icon={<LogIn size={15} aria-hidden="true" />}>
              Sign in
            </Button>
          </div>

          <p className="auth__help">
            Locked out or forgot your password? Call the IT Help Desk at ext. 4400. Passwords are managed through your Windows account.
          </p>
        </form>
      </main>
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  visible,
  onToggle,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  visible: boolean;
  onToggle: () => void;
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <div className="input-affix input-affix--post">
      <Input
        {...rest}
        name="password"
        type={visible ? "text" : "password"}
        autoComplete="current-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="input-affix__button" onClick={onToggle} aria-label={visible ? "Hide password" : "Show password"}>
        {visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}

export { PasswordInput };
