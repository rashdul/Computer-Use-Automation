import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Clock, Lock, Search, SearchX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";
import { Badge, Panel } from "../../components/display";
import { EmptyState, LoadError, SlowNotice } from "../../components/feedback";
import { Field, Input, Select } from "../../components/form";
import { Pager, SkeletonRows } from "../../components/navigation";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { count, dateNumeric, phone, relative, ssnMasked } from "../../lib/format";
import { MEMBER_STATUS } from "../../lib/labels";
import type { SearchRow } from "../../lib/types";

const PAGE_SIZE = 25;

export function MemberSearchPage() {
  useDocumentTitle("Member search");
  const { context } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const branch = params.get("branch") ?? "";
  const sort = params.get("sort") ?? "relevance";
  const offset = Number(params.get("offset") ?? "0") || 0;

  const [draft, setDraft] = useState(q);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(q);
    setLocalError(q && q.trim().length < 2 ? "Enter at least 2 characters to search." : null);
  }, [q]);

  useEffect(() => {
    if (!q) inputRef.current?.focus();
  }, [q]);

  const search = useQuery({
    queryKey: ["search", q, status, branch, sort, offset],
    queryFn: () => api.searchMembers({ query: q, status, branch, sort, limit: PAGE_SIZE, offset }),
    enabled: q.trim().length >= 2,
    placeholderData: keepPreviousData,
  });

  const recent = useQuery({ queryKey: ["recent-members"], queryFn: api.recentMembers, enabled: !q, staleTime: 15_000 });

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    if (!("offset" in next)) p.delete("offset");
    setParams(p);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (value.length < 2) {
      setLocalError(value ? "Enter at least 2 characters to search." : "Enter a name, member number, SSN, phone, or email.");
      inputRef.current?.focus();
      return;
    }
    setLocalError(null);
    update({ q: value });
  };

  const serverFieldError = isApiError(search.error) && search.error.kind === "validation" ? search.error.fields[0]?.message : null;
  const fieldError = localError ?? serverFieldError;
  const result = search.data;
  const loading = search.isFetching && !search.isPlaceholderData;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header__text">
          <h1>Member search</h1>
          <p>Find a membership by name, member number, SSN, phone, or email.</p>
        </div>
      </div>

      <div className="stack">
        <Panel>
          <form className="search-bar" role="search" onSubmit={submit} noValidate>
            <Field label="Search" className="search-bar__query" error={fieldError}>
              <Input
                ref={inputRef}
                name="q"
                type="search"
                placeholder="e.g. Okafor, 1030966, 4298, (410) 555-0147"
                autoComplete="off"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => update({ status: e.target.value })}>
                <option value="">Any status</option>
                <option value="active">Active</option>
                <option value="dormant">Dormant</option>
                <option value="closed">Closed</option>
                <option value="deceased">Deceased</option>
              </Select>
            </Field>
            <Field label="Branch">
              <Select value={branch} onChange={(e) => update({ branch: e.target.value })}>
                <option value="">All branches</option>
                {context?.branches.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.code} · {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sort by">
              <Select value={sort} onChange={(e) => update({ sort: e.target.value })}>
                <option value="relevance">Best match</option>
                <option value="name">Name (A–Z)</option>
                <option value="member_number">Member number</option>
                <option value="member_since">Newest members</option>
              </Select>
            </Field>
            <Button type="submit" variant="primary" icon={<Search size={15} aria-hidden="true" />} loading={loading} loadingText="Searching…">
              Search
            </Button>
          </form>
        </Panel>

        {q.trim().length >= 2 ? (
          <>
            <SlowNotice active={search.isFetching} what="search results" />
            {search.isError && !serverFieldError ? (
              <LoadError error={search.error} onRetry={() => search.refetch()} what="search results" />
            ) : (
              !serverFieldError && (
                <Panel
                  title="Results"
                  count={result ? `· ${count(result.total)}` : undefined}
                  flush
                  actions={
                    q && (
                      <Button size="sm" variant="ghost" icon={<X size={13} aria-hidden="true" />} onClick={() => setParams({})}>
                        Clear search
                      </Button>
                    )
                  }
                  footer={
                    result && result.total > PAGE_SIZE ? (
                      <Pager total={result.total} limit={PAGE_SIZE} offset={offset} onChange={(o) => update({ offset: String(o) })} noun="members" />
                    ) : undefined
                  }
                >
                  {result && result.total === 0 && !loading ? (
                    <EmptyState
                      icon={<SearchX size={18} aria-hidden="true" />}
                      title={`No members match “${q}”`}
                      actions={
                        <Button onClick={() => setParams({})} icon={<X size={14} aria-hidden="true" />}>
                          Clear search
                        </Button>
                      }
                    >
                      Check the spelling, or search by the 7-digit member number or the last 4 digits of the SSN.
                      {(status || branch) && " Filters are narrowing the results — try Any status and All branches."}
                    </EmptyState>
                  ) : (
                    <ResultsTable rows={result?.rows} loading={loading || !result} onOpen={(n) => navigate(`/members/${n}`)} />
                  )}
                </Panel>
              )
            )}
          </>
        ) : (
          <div className="search-layout">
            <Panel title="Recently viewed" icon={<Clock size={15} aria-hidden="true" />} flush>
              {recent.isPending ? (
                <table className="table">
                  <tbody>
                    <SkeletonRows columns={3} rows={5} />
                  </tbody>
                </table>
              ) : recent.isError ? (
                <div className="panel__body">
                  <LoadError error={recent.error} onRetry={() => recent.refetch()} what="recent members" />
                </div>
              ) : recent.data.length === 0 ? (
                <EmptyState title="No members viewed yet">Members you open appear here for quick access.</EmptyState>
              ) : (
                <ul className="recent-list">
                  {recent.data.map((m) => (
                    <li key={m.member_number}>
                      <Link to={`/members/${m.member_number}`} className="recent-item">
                        <span>
                          <span className="recent-item__name">
                            {m.display_name} {m.is_restricted && <Lock size={12} className="lock-icon" aria-label="Restricted record" />}
                          </span>
                          <span className="recent-item__sub">
                            <span className="mono">{m.member_number}</span>
                            {m.city && ` · ${m.city}, ${m.state}`}
                          </span>
                        </span>
                        <span className="recent-item__sub">{relative(m.last_viewed_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Search tips">
              <dl className="tips">
                <dt>Name</dt>
                <dd>
                  Last name, first name, or both: <code>okafor</code>, <code>renee cunningham</code>
                </dd>
                <dt>Member number</dt>
                <dd>
                  All 7 digits: <code>1030966</code>. An account number like <code>1030966-S01</code> also works.
                </dd>
                <dt>SSN</dt>
                <dd>
                  Last 4 digits <code>4298</code> or all 9 <code>912-21-4298</code>. SSN searches are logged.
                </dd>
                <dt>Phone or email</dt>
                <dd>
                  10-digit phone <code>(410) 555-0787</code> or the full email address.
                </dd>
              </dl>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultsTable({ rows, loading, onOpen }: { rows?: SearchRow[]; loading: boolean; onOpen: (memberNumber: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="table table--interactive">
        <caption className="sr-only">Members matching the search</caption>
        <thead>
          <tr>
            <th scope="col">Member #</th>
            <th scope="col">Name</th>
            <th scope="col">Date of birth</th>
            <th scope="col">SSN</th>
            <th scope="col">Mobile</th>
            <th scope="col">City</th>
            <th scope="col">Branch</th>
            <th scope="col">Status</th>
            <th scope="col">Member since</th>
          </tr>
        </thead>
        <tbody>
          {loading && !rows ? (
            <SkeletonRows columns={9} />
          ) : (
            rows?.map((r) => (
              <tr
                key={r.member_number}
                data-href={`/members/${r.member_number}`}
                tabIndex={0}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a")) return;
                  onOpen(r.member_number);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(r.member_number);
                }}
                aria-label={`${r.display_name}, member ${r.member_number}`}
              >
                <td className="mono">
                  <Link to={`/members/${r.member_number}`}>{r.member_number}</Link>
                </td>
                <td className="col-primary">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {r.display_name}
                    {r.is_restricted && (
                      <Badge tone="warn" title={r.restriction_reason ?? "Restricted record"}>
                        <Lock aria-hidden="true" /> Restricted
                      </Badge>
                    )}
                  </span>
                </td>
                {r.masked ? (
                  <>
                    <td className="subtle" colSpan={4}>
                      Details hidden — restricted record
                    </td>
                  </>
                ) : (
                  <>
                    <td className="nowrap">{dateNumeric(r.date_of_birth)}</td>
                    <td className="masked">{ssnMasked(r.ssn_last4)}</td>
                    <td className="nowrap">{phone(r.phone_mobile)}</td>
                    <td className="nowrap">
                      {r.city}, {r.state}
                    </td>
                  </>
                )}
                <td className="mono">{r.branch_code}</td>
                <td>
                  <Badge tone={MEMBER_STATUS[r.status].tone} dot>
                    {MEMBER_STATUS[r.status].label}
                  </Badge>
                </td>
                <td className="nowrap">{r.masked ? "—" : dateNumeric(r.member_since)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
