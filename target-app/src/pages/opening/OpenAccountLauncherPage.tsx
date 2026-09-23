import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Panel } from "../../components/display";
import { EmptyState } from "../../components/feedback";
import { Field, Input } from "../../components/form";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { api } from "../../lib/api";
import { relative } from "../../lib/format";

/** Entry point from the sidebar: pick the member, then open the form. */
export function OpenAccountLauncherPage() {
  useDocumentTitle("Open sub-account");
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recent = useQuery({ queryKey: ["recent-members"], queryFn: api.recentMembers, staleTime: 15_000 });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = value.trim();
    if (!/^\d{7}$/.test(n)) {
      setError("Enter the member's 7-digit member number.");
      inputRef.current?.focus();
      return;
    }
    navigate(`/members/${n}/accounts/new`);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header__text">
          <h1>Open a sub-account</h1>
          <p>Start with the member who will own the account. You can search by name from Member search.</p>
        </div>
      </div>
      <div className="search-layout">
        <Panel title="Which member?">
          <form onSubmit={submit} noValidate className="lookup-row" style={{ alignItems: "flex-start" }}>
            <Field label="Member number" error={error} hint="7 digits, printed on the member's statement">
              <Input
                ref={inputRef}
                mono
                inputMode="numeric"
                maxLength={7}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value.replace(/\D/g, ""));
                  setError(null);
                }}
                style={{ width: 220 }}
              />
            </Field>
            <Button type="submit" variant="primary" iconAfter={<ArrowRight size={15} aria-hidden="true" />} style={{ marginTop: 21 }}>
              Continue
            </Button>
          </form>
        </Panel>
        <Panel title="Recently viewed" icon={<Clock size={15} aria-hidden="true" />} flush>
          {recent.data && recent.data.length ? (
            <ul className="recent-list">
              {recent.data.slice(0, 6).map((m) => (
                <li key={m.member_number}>
                  <Link to={`/members/${m.member_number}/accounts/new`} className="recent-item">
                    <span>
                      <span className="recent-item__name">{m.display_name}</span>
                      <span className="recent-item__sub">
                        <span className="mono">{m.member_number}</span>
                      </span>
                    </span>
                    <span className="recent-item__sub">{relative(m.last_viewed_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No recent members">Members you open appear here.</EmptyState>
          )}
        </Panel>
      </div>
    </div>
  );
}
