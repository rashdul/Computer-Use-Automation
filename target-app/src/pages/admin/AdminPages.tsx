import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, ClipboardList, Database, FlaskConical, Filter, LogOut, Package, RotateCcw, ShieldCheck, Users } from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Badge, DL, Panel, Stats } from "../../components/display";
import { Banner, LoadError, SkeletonLines, SlowNotice } from "../../components/feedback";
import { Check, Field, Input, Select } from "../../components/form";
import { Modal } from "../../components/Modal";
import { Pager, SkeletonRows } from "../../components/navigation";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { bytes, count, dateNumeric, dateTime, money, relative, time } from "../../lib/format";
import { AUDIT_ACTIONS, CATEGORY_LABEL, INTERRUPT_LABEL, ROLE_LABEL, SCOPE_LABEL, TRIGGER_LABEL, actionLabel } from "../../lib/labels";
import type { AdminProduct, Permission, PermissionMatrix, Role, StaffRow } from "../../lib/types";
import { AuditTable } from "../activity/AuditTable";

/* ---------------------------------------------------------------------------
 * Overview
 * ------------------------------------------------------------------------- */
export function AdminOverviewPage() {
  const q = useQuery({ queryKey: ["admin-overview"], queryFn: api.admin.overview, refetchInterval: 30_000 });
  if (q.isPending) return <div className="panel panel__body"><SkeletonLines lines={8} /></div>;
  if (q.isError) return <LoadError error={q.error} onRetry={() => q.refetch()} what="the overview" />;
  const o = q.data;
  const env = o.environment;
  const cap = 500 * 1024 * 1024;

  return (
    <div className="stack">
      <Stats
        items={[
          { label: "Members", value: count(o.counts.members), sub: `${count(o.counts.active_members)} active · ${count(o.counts.restricted_members)} restricted` },
          { label: "Sub-accounts", value: count(o.counts.open_accounts), sub: `${count(o.counts.accounts)} including closed` },
          { label: "Posted transactions", value: `≈ ${count(o.counts.transactions_estimate)}`, sub: "Online history since Jul 1" },
          { label: "Audit events", value: `≈ ${count(o.counts.audit_events_estimate)}`, sub: `${count(o.counts.notes)} member notes` },
          { label: "Staff", value: `${o.counts.active_staff} / ${o.counts.staff}`, sub: `${o.counts.active_sessions} signed-in sessions` },
          { label: "Database", value: bytes(o.database_bytes), sub: `${Math.round((o.database_bytes / cap) * 100)}% of the 500 MB plan` },
        ]}
      />
      <Stats
        items={[
          { label: "Sub-accounts opened today", value: count(o.today.accounts_opened) },
          { label: "Member views today", value: count(o.today.member_views) },
          { label: "Access denied today", value: count(o.today.access_denied) },
          { label: "Sign-ins today", value: count(o.today.sign_ins) },
          { label: "Deposits on book", value: money(o.balances.deposits) },
          { label: "Loans on book", value: money(o.balances.loans) },
        ]}
      />
      <div className="grid-12">
        <Panel
          title="Environment status"
          icon={<Activity size={15} aria-hidden="true" />}
          className="span-6"
          footer={
            <Link to="/admin/environment" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
              Change environment controls <ArrowRight size={13} aria-hidden="true" />
            </Link>
          }
        >
          <DL
            items={[
              [
                "Latency",
                env.latency_mode === "off" ? (
                  <Badge tone="ok">Off</Badge>
                ) : (
                  <>
                    <Badge tone="warn">On</Badge>{" "}
                    {env.latency_mode === "fixed" ? `${env.latency_fixed_ms} ms` : `${env.latency_min_ms}–${env.latency_max_ms} ms`} ·{" "}
                    {SCOPE_LABEL[env.latency_scope]}
                  </>
                ),
              ],
              [
                "Failure injection",
                env.failure_rate_pct === 0 ? (
                  <Badge tone="ok">Off</Badge>
                ) : (
                  <>
                    <Badge tone="bad">{env.failure_rate_pct}%</Badge> {SCOPE_LABEL[env.failure_scope]}
                  </>
                ),
              ],
              [
                "Unexpected dialogs",
                !env.interrupts_enabled ? (
                  <Badge tone="ok">Off</Badge>
                ) : (
                  <>
                    <Badge tone="warn">On</Badge> {TRIGGER_LABEL[env.interrupt_trigger]} · {env.interrupt_probability_pct}% ·{" "}
                    {env.interrupt_kinds.map((k) => INTERRUPT_LABEL[k]).join(", ")}
                  </>
                ),
              ],
              ["Timeouts", `Slow notice at ${env.slow_notice_after_ms / 1000}s · request timeout ${env.request_timeout_ms / 1000}s`],
              ["Idle sign-out", `${env.idle_timeout_minutes} min (warning ${env.idle_warning_seconds}s before)`],
              ["Maintenance banner", env.maintenance_banner ?? <span className="subtle">None</span>],
              ["Last changed", `${env.updated_by_name} · ${relative(env.updated_at)}`],
            ]}
          />
        </Panel>
        <Panel title="Recent administration changes" icon={<ClipboardList size={15} aria-hidden="true" />} className="span-6" flush>
          {o.recent_admin_events.length ? (
            <ul className="relation-list">
              {o.recent_admin_events.map((e) => (
                <li key={e.reference}>
                  <span>
                    <span style={{ fontWeight: 600 }}>{actionLabel(e.action)}</span>
                    <span className="recent-item__sub" style={{ display: "block" }}>
                      {e.summary}
                    </span>
                  </span>
                  <span className="recent-item__sub" style={{ textAlign: "right", whiteSpace: "nowrap", flex: "none" }}>
                    {e.actor_name}
                    <br />
                    {relative(e.occurred_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="panel__body subtle">No administration changes yet.</div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Staff & sessions
 * ------------------------------------------------------------------------- */
const ROLES: Role[] = ["teller", "member_service_rep", "branch_manager", "compliance_officer", "system_admin"];

export function AdminStaffPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const staff = useQuery({ queryKey: ["admin-staff"], queryFn: api.admin.staff });
  const sessions = useQuery({ queryKey: ["admin-sessions"], queryFn: api.admin.sessions, refetchInterval: 20_000 });
  const [disabling, setDisabling] = useState<StaffRow | null>(null);
  const [pendingRole, setPendingRole] = useState<Record<string, Role>>({});

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-staff"] });
    void qc.invalidateQueries({ queryKey: ["admin-sessions"] });
    void qc.invalidateQueries({ queryKey: ["admin-overview"] });
  };

  const updateStaff = useMutation({
    mutationFn: (v: { s: StaffRow; role?: Role; active?: boolean }) => api.admin.updateStaff(v.s.id, v.role, v.active),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["admin-staff"] });
      const prev = qc.getQueryData<StaffRow[]>(["admin-staff"]);
      if (prev) {
        qc.setQueryData<StaffRow[]>(
          ["admin-staff"],
          prev.map((x) => (x.id === v.s.id ? { ...x, role: v.role ?? x.role, is_active: v.active ?? x.is_active } : x)),
        );
      }
      return { prev };
    },
    onSettled: (_r, _e, v) =>
      setPendingRole((m) => {
        const next = { ...m };
        delete next[v.s.id];
        return next;
      }),
    onSuccess: (r, v) => {
      refresh();
      setDisabling(null);
      toast.show({
        title: v.role ? `${v.s.full_name} is now ${ROLE_LABEL[v.role]}` : v.active ? `${v.s.full_name} enabled` : `${v.s.full_name} disabled`,
        text: r.sessions_ended ? `${r.sessions_ended} open session${r.sessions_ended === 1 ? "" : "s"} ended.` : undefined,
      });
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin-staff"], ctx.prev);
      toast.show({
        tone: "bad",
        title: "Change not saved",
        text: isApiError(e) && e.kind === "conflict" ? String((e.details as { message?: string })?.message ?? "") : isApiError(e) ? e.message : undefined,
      });
    },
  });

  const endOne = useMutation({
    mutationFn: (s: { id: string; name: string }) => api.admin.endSessions(s.id),
    onSuccess: (r, s) => {
      refresh();
      toast.show({ title: `Ended ${r.sessions_ended} session${r.sessions_ended === 1 ? "" : "s"} for ${s.name}` });
    },
  });

  return (
    <div className="stack">
      <Panel title="Staff" icon={<Users size={15} aria-hidden="true" />} count={staff.data ? `· ${staff.data.length}` : undefined} flush>
        {staff.isError ? (
          <div className="panel__body">
            <LoadError error={staff.error} onRetry={() => staff.refetch()} what="staff" />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Username</th>
                  <th scope="col">Role</th>
                  <th scope="col">Branch · workstation</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!staff.data ? (
                  <SkeletonRows columns={8} rows={10} />
                ) : (
                  staff.data.map((s) => (
                    <tr key={s.id} className={s.is_active ? undefined : "row-muted"}>
                      <td>
                        <span className="col-primary">{s.full_name}</span>
                        {s.is_you && <Badge tone="info">You</Badge>}
                        <span className="cell-sub">
                          {s.title} · <span className="mono">{s.employee_id}</span>
                        </span>
                      </td>
                      <td className="mono">{s.username}</td>
                      <td>
                        <label className="sr-only" htmlFor={`role-${s.id}`}>
                          Role for {s.full_name}
                        </label>
                        <Select
                          id={`role-${s.id}`}
                          value={pendingRole[s.id] ?? s.role}
                          disabled={s.is_you || s.id in pendingRole}
                          onChange={(e) => {
                            const role = e.target.value as Role;
                            setPendingRole((m) => ({ ...m, [s.id]: role }));
                            updateStaff.mutate({ s, role });
                          }}
                          style={{ height: 28, width: 250 }}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="nowrap">
                        {s.branch_code} <span className="subtle mono">{s.workstation}</span>
                      </td>
                      <td>
                        <Badge tone={s.is_active ? "ok" : "neutral"} dot>
                          {s.is_active ? "Active" : "Disabled"}
                        </Badge>
                      </td>
                      <td className="nowrap">{s.last_sign_in_at ? relative(s.last_sign_in_at) : <span className="subtle">Never</span>}</td>
                      <td className="num">{s.active_sessions}</td>
                      <td className="nowrap" style={{ textAlign: "right" }}>
                        {s.active_sessions > 0 && !s.is_you && (
                          <Button size="sm" variant="ghost" onClick={() => endOne.mutate({ id: s.id, name: s.full_name })} loading={endOne.isPending && endOne.variables?.id === s.id}>
                            End sessions
                          </Button>
                        )}
                        {!s.is_you &&
                          (s.is_active ? (
                            <Button size="sm" variant="danger-ghost" onClick={() => setDisabling(s)}>
                              Disable
                            </Button>
                          ) : (
                            <Button size="sm" onClick={() => updateStaff.mutate({ s, active: true })}>
                              Enable
                            </Button>
                          ))}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Signed-in sessions" icon={<LogOut size={15} aria-hidden="true" />} count={sessions.data ? `· ${sessions.data.length}` : undefined} flush>
        {sessions.isError ? (
          <div className="panel__body">
            <LoadError error={sessions.error} onRetry={() => sessions.refetch()} what="sessions" />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Staff</th>
                  <th scope="col">Workstation</th>
                  <th scope="col">Started</th>
                  <th scope="col">Last active</th>
                  <th scope="col">Browser</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!sessions.data ? (
                  <SkeletonRows columns={6} rows={3} />
                ) : sessions.data.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="subtle">
                      No one is signed in.
                    </td>
                  </tr>
                ) : (
                  sessions.data.map((s) => (
                    <tr key={s.session_id}>
                      <td>
                        <span className="col-primary">{s.full_name}</span> {s.is_current && <Badge tone="info">This session</Badge>}
                        <span className="cell-sub">{s.role_label}</span>
                      </td>
                      <td className="mono">{s.workstation}</td>
                      <td className="nowrap">{dateTime(s.started_at)}</td>
                      <td className="nowrap">{relative(s.last_active_at)}</td>
                      <td className="subtle" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.user_agent ?? undefined}>
                        {browserLabel(s.user_agent)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {!s.is_current && (
                          <Button size="sm" variant="ghost" onClick={() => endOne.mutate({ id: s.staff_id, name: s.full_name })}>
                            End session
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Modal
        open={disabling !== null}
        onClose={() => setDisabling(null)}
        tone="bad"
        icon={<LogOut size={16} aria-hidden="true" />}
        title={`Disable ${disabling?.full_name ?? ""}?`}
        footer={
          <>
            <Button onClick={() => setDisabling(null)} autoFocus>
              Cancel
            </Button>
            <Button variant="danger" loading={updateStaff.isPending} onClick={() => disabling && updateStaff.mutate({ s: disabling, active: false })}>
              Disable account
            </Button>
          </>
        }
      >
        They're signed out everywhere immediately and can't sign in until an administrator enables the account again.
      </Modal>
    </div>
  );
}

function browserLabel(ua: string | null): string {
  if (!ua) return "—";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /python|curl|urllib/i.test(ua) ? "API client" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

/* ---------------------------------------------------------------------------
 * Roles & permissions
 * ------------------------------------------------------------------------- */
export function AdminPermissionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["admin-permissions"], queryFn: api.admin.permissions });
  // what the admin just clicked, shown until the server answers (a controlled
  // checkbox would otherwise snap back for a frame before the optimistic update)
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const set = useMutation({
    mutationFn: (v: { role: Role; permission: Permission; granted: boolean; label: string }) => api.admin.setPermission(v.role, v.permission, v.granted),
    // flip the checkbox immediately; roll back if the server refuses
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["admin-permissions"] });
      const prev = qc.getQueryData<PermissionMatrix>(["admin-permissions"]);
      if (prev) {
        qc.setQueryData<PermissionMatrix>(["admin-permissions"], {
          ...prev,
          permissions: prev.permissions.map((p) =>
            p.code === v.permission
              ? { ...p, granted_to: v.granted ? [...p.granted_to, v.role] : p.granted_to.filter((r) => r !== v.role) }
              : p,
          ),
        });
      }
      return { prev };
    },
    onSuccess: (_r, v) => {
      toast.show({ title: v.granted ? `Granted “${v.label}” to ${ROLE_LABEL[v.role]}` : `Revoked “${v.label}” from ${ROLE_LABEL[v.role]}`, text: "Signed-in staff pick this up within 30 seconds." });
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin-permissions"], ctx.prev);
      toast.show({
        tone: "bad",
        title: "Permission not changed",
        text: isApiError(e) && e.kind === "conflict" ? String((e.details as { message?: string })?.message ?? "") : undefined,
      });
    },
    onSettled: (_r, _e, v) => {
      setPending((m) => {
        const next = { ...m };
        delete next[`${v.role}:${v.permission}`];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ["admin-permissions"] });
    },
  });

  if (q.isPending) return <div className="panel panel__body"><SkeletonLines lines={8} /></div>;
  if (q.isError) return <LoadError error={q.error} onRetry={() => q.refetch()} what="permissions" />;
  const categories = [...new Set(q.data.permissions.map((p) => p.category))];

  return (
    <Panel title="Roles & permissions" icon={<ShieldCheck size={15} aria-hidden="true" />} flush footer={<span className="subtle" style={{ fontSize: "var(--fs-sm)" }}>Changes apply immediately and are recorded in the audit log. The server enforces every permission.</span>}>
      <div className="table-wrap">
        <table className="table matrix">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {q.data.roles.map((r) => (
                <th key={r.role} scope="col" className="role-col">
                  {r.label}
                  <span className="cell-sub">{r.staff_count} active</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <Fragment key={c}>
                <tr className="table-subhead">
                  <td colSpan={q.data.roles.length + 1}>{c}</td>
                </tr>
                {q.data.permissions
                  .filter((p) => p.category === c)
                  .map((p) => (
                    <tr key={p.code}>
                      <td>
                        <span className="col-primary">{p.label}</span> <span className="subtle mono" style={{ fontSize: 11 }}>{p.code}</span>
                        <span className="perm-desc">{p.description}</span>
                      </td>
                      {q.data.roles.map((r) => {
                        const key = `${r.role}:${p.code}`;
                        const granted = pending[key] ?? p.granted_to.includes(r.role);
                        const locked = r.role === "system_admin" && p.code === "admin.console";
                        return (
                          <td key={r.role} className="cell-check">
                            <label className="check" title={locked ? "System Administrators always keep Administration" : undefined}>
                              <input
                                type="checkbox"
                                checked={granted}
                                disabled={locked || key in pending}
                                aria-label={`${p.label} for ${r.label}`}
                                onChange={(e) => {
                                  const on = e.target.checked;
                                  setPending((m) => ({ ...m, [key]: on }));
                                  set.mutate({ role: r.role, permission: p.code, granted: on, label: p.label });
                                }}
                              />
                            </label>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
 * Products
 * ------------------------------------------------------------------------- */
export function AdminProductsPage() {
  const q = useQuery({ queryKey: ["admin-products"], queryFn: api.admin.products });
  if (q.isPending) return <div className="panel panel__body"><SkeletonLines lines={8} /></div>;
  if (q.isError) return <LoadError error={q.error} onRetry={() => q.refetch()} what="products" />;
  return (
    <Panel title="Products" icon={<Package size={15} aria-hidden="true" />} flush footer={<span className="subtle" style={{ fontSize: "var(--fs-sm)" }}>Rate changes apply to new accounts only. Products that aren't offered disappear from Open sub-account.</span>}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">Rate (%)</th>
              <th scope="col" className="num">Minimum to open ($)</th>
              <th scope="col">Offered</th>
              <th scope="col" className="num">Open accounts</th>
              <th scope="col">Updated</th>
              <th scope="col">
                <span className="sr-only">Save</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((p) => (
              <ProductRow key={p.code} p={p} />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ProductRow({ p }: { p: AdminProduct }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rate, setRate] = useState(p.rate?.toFixed(3) ?? "");
  const [min, setMin] = useState(p.min_opening_deposit.toFixed(2));
  const [active, setActive] = useState(p.is_active);
  const dirty = rate !== (p.rate?.toFixed(3) ?? "") || min !== p.min_opening_deposit.toFixed(2) || active !== p.is_active;
  const save = useMutation({
    mutationFn: () => api.admin.updateProduct(p.code, { rate: Number(rate), min_opening_deposit: Number(min), is_active: active }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-products"] });
      void qc.invalidateQueries({ queryKey: ["products"] });
      toast.show({ title: `${p.name} updated` });
    },
    onError: (e) => toast.show({ tone: "bad", title: `${p.name} not saved`, text: isApiError(e) ? e.fields.map((f) => f.message).join(" ") : undefined }),
  });
  const isLoan = p.category === "loan";
  return (
    <tr>
      <td>
        <span className="col-primary">{p.name}</span> <span className="subtle mono" style={{ fontSize: 11 }}>{p.code}</span>
      </td>
      <td className="muted">{CATEGORY_LABEL[p.category]}</td>
      <td className="num">
        <label className="sr-only" htmlFor={`rate-${p.code}`}>
          Rate for {p.name}
        </label>
        <Input id={`rate-${p.code}`} className="inline-number" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} style={{ height: 28 }} />
      </td>
      <td className="num">
        {isLoan ? (
          <span className="subtle">—</span>
        ) : (
          <>
            <label className="sr-only" htmlFor={`min-${p.code}`}>
              Minimum opening deposit for {p.name}
            </label>
            <Input id={`min-${p.code}`} className="inline-number" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} style={{ height: 28, width: 110 }} />
          </>
        )}
      </td>
      <td>
        <Check label={active ? "Offered" : "Not offered"} checked={active} onChange={(e) => setActive(e.target.checked)} />
      </td>
      <td className="num">{count(p.open_accounts)}</td>
      <td className="nowrap subtle">{p.updated_at ? relative(p.updated_at) : "—"}</td>
      <td style={{ textAlign: "right" }}>
        <Button size="sm" variant={dirty ? "primary" : "secondary"} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------------------------
 * Audit log
 * ------------------------------------------------------------------------- */
const AUDIT_PAGE = 50;

export function AdminAuditPage() {
  const empty = { actor: "", action: "", outcome: "", member: "", from: "", to: "" };
  const [draft, setDraft] = useState(empty);
  const [filters, setFilters] = useState(empty);
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["admin-audit", filters, offset],
    queryFn: () => api.admin.audit({ ...filters, limit: AUDIT_PAGE, offset }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="stack">
      <Panel>
        <form
          className="search-bar"
          style={{ flexWrap: "wrap" }}
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setFilters(draft);
          }}
        >
          <Field label="Staff">
            <Input value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} placeholder="Name or username" style={{ width: 170 }} />
          </Field>
          <Field label="Action">
            <Select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
              <option value="">Any action</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Outcome">
            <Select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}>
              <option value="">Any outcome</option>
              <option value="success">Success</option>
              <option value="denied">Denied</option>
              <option value="failed">Failed</option>
            </Select>
          </Field>
          <Field label="Member #">
            <Input mono value={draft.member} maxLength={7} onChange={(e) => setDraft({ ...draft, member: e.target.value.replace(/\D/g, "") })} style={{ width: 110 }} />
          </Field>
          <Field label="From">
            <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </Field>
          <Button type="submit" variant="primary" icon={<Filter size={14} aria-hidden="true" />}>
            Apply
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(empty);
              setFilters(empty);
              setOffset(0);
            }}
          >
            Clear
          </Button>
        </form>
      </Panel>
      <SlowNotice active={q.isFetching} what="the audit log" />
      {q.isError ? (
        <LoadError error={q.error} onRetry={() => q.refetch()} what="the audit log" />
      ) : (
        <Panel
          title="Audit log"
          icon={<ClipboardList size={15} aria-hidden="true" />}
          count={q.data ? `· ${count(q.data.total)}` : undefined}
          flush
          footer={q.data && q.data.total > AUDIT_PAGE ? <Pager total={q.data.total} limit={AUDIT_PAGE} offset={offset} onChange={setOffset} noun="events" disabled={q.isFetching} /> : undefined}
        >
          {!q.data ? (
            <table className="table">
              <tbody>
                <SkeletonRows columns={7} rows={12} />
              </tbody>
            </table>
          ) : (
            <AuditTable rows={q.data.rows} showActor expandable />
          )}
        </Panel>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Test data
 * ------------------------------------------------------------------------- */
export function AdminTestDataPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["admin-scenarios"], queryFn: api.admin.scenarios });
  const [confirm, setConfirm] = useState(false);
  const reset = useMutation({
    mutationFn: api.admin.resetScenarios,
    onSuccess: (r) => {
      setConfirm(false);
      void qc.invalidateQueries();
      toast.show({
        title: `Reversed ${r.openings_reversed} account opening${r.openings_reversed === 1 ? "" : "s"}`,
        text: r.funds_returned ? `${money(r.funds_returned)} returned to funding accounts.` : "Scenario members are back to their seeded state.",
      });
    },
  });

  return (
    <div className="stack">
      <Banner tone="info" title="Scenario catalogue">
        Each row is a synthetic member chosen because it produces exactly one runtime condition. Use them to exercise automated flows
        deterministically.
      </Banner>
      <Panel
        title="Scenarios"
        icon={<FlaskConical size={15} aria-hidden="true" />}
        count={q.data ? `· ${q.data.length}` : undefined}
        flush
        actions={
          <Button size="sm" variant="danger-ghost" icon={<RotateCcw size={13} aria-hidden="true" />} onClick={() => setConfirm(true)}>
            Reset test data
          </Button>
        }
      >
        {q.isError ? (
          <div className="panel__body">
            <LoadError error={q.error} onRetry={() => q.refetch()} what="scenarios" />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Scenario</th>
                  <th scope="col">Member #</th>
                  <th scope="col">Sign in as</th>
                  <th scope="col">Expected outcome</th>
                </tr>
              </thead>
              <tbody>
                {!q.data ? (
                  <SkeletonRows columns={4} rows={10} />
                ) : (
                  q.data.map((s) => (
                    <tr key={s.key}>
                      <td style={{ maxWidth: 380 }}>
                        <span className="col-primary">{s.title}</span>
                        <span className="cell-sub" style={{ whiteSpace: "normal" }}>
                          {s.description}
                        </span>
                      </td>
                      <td className="mono">{s.member_number ? <Link to={`/members/${s.member_number}`}>{s.member_number}</Link> : "—"}</td>
                      <td className="mono">{s.sign_in_as ?? "—"}</td>
                      <td style={{ maxWidth: 380 }}>{s.expected_outcome}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="About this data" icon={<Database size={15} aria-hidden="true" />}>
        <p className="muted" style={{ lineHeight: 1.55 }}>
          Every member, account, and transaction here is synthetic. SSNs use the never-issued 9xx area, emails use reserved example domains,
          and phone numbers use the 555 exchange. Sign-in credentials are issued by the UAT coordinator. Automated runs that open
          sub-accounts change the scenario members; reset them between runs.
        </p>
        <p className="subtle" style={{ marginTop: 8, fontSize: "var(--fs-sm)" }}>
          Generated {dateNumeric("2026-09-22")} · refreshed {time(new Date().toISOString())} ET
        </p>
      </Panel>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="warn"
        icon={<RotateCcw size={16} aria-hidden="true" />}
        title="Reset scenario members?"
        footer={
          <>
            <Button onClick={() => setConfirm(false)} autoFocus>
              Cancel
            </Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
              Reset test data
            </Button>
          </>
        }
      >
        Sub-accounts opened through the console for scenario members are removed, and their opening deposits are returned to the source
        accounts. The audit log keeps its history.
      </Modal>
    </div>
  );
}
