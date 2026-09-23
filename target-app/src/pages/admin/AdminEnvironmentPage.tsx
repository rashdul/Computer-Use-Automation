import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, RotateCcw, Save, SlidersHorizontal, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";
import { Panel } from "../../components/display";
import { Banner, LoadError, SkeletonLines } from "../../components/feedback";
import { Check, Field, Input, Segmented, Select } from "../../components/form";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { relative } from "../../lib/format";
import { INTERRUPT_LABEL, SCOPE_LABEL, TRIGGER_LABEL } from "../../lib/labels";
import type { EnvironmentSettings, InterruptKind, InterruptTrigger, Scope } from "../../lib/types";

type Editable = Omit<EnvironmentSettings, "updated_at" | "updated_by_name">;

const PRESETS: { label: string; hint: string; patch: Partial<Editable> }[] = [
  { label: "All clear", hint: "No injected faults", patch: { latency_mode: "off", failure_rate_pct: 0, interrupts_enabled: false, maintenance_banner: null } },
  { label: "Slow core (3–6 s)", hint: "Random latency on every member request", patch: { latency_mode: "random", latency_min_ms: 3000, latency_max_ms: 6000, latency_scope: "all" } },
  { label: "Timeouts on opening", hint: "12 s latency, 8 s timeout on account opening", patch: { latency_mode: "fixed", latency_fixed_ms: 12000, latency_scope: "account_opening", request_timeout_ms: 8000 } },
  { label: "Flaky service (25%)", hint: "One in four member requests fails", patch: { failure_rate_pct: 25, failure_scope: "all" } },
  { label: "Dialog on review", hint: "Always interrupt the review step", patch: { interrupts_enabled: true, interrupt_trigger: "review", interrupt_probability_pct: 100, interrupt_once_per_session: false } },
  { label: "2-minute idle timeout", hint: "Warn at 30 s remaining", patch: { idle_timeout_minutes: 2, idle_warning_seconds: 30 } },
];

const KINDS: InterruptKind[] = ["maintenance_notice", "compliance_attestation", "password_expiry", "printer_offline", "duplicate_session"];

function editable(e: EnvironmentSettings): Editable {
  const { updated_at: _u, updated_by_name: _b, ...rest } = e;
  return rest;
}

export function AdminEnvironmentPage() {
  const q = useQuery({ queryKey: ["admin-environment"], queryFn: api.admin.environment });
  if (q.isPending) return <div className="panel panel__body"><SkeletonLines lines={10} /></div>;
  if (q.isError) return <LoadError error={q.error} onRetry={() => q.refetch()} what="environment controls" />;
  return <EnvironmentForm initial={q.data} />;
}

function EnvironmentForm({ initial }: { initial: EnvironmentSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { setEnvironmentLocal } = useAuth();
  const [form, setForm] = useState<Editable>(() => editable(initial));
  const [base, setBase] = useState<Editable>(() => editable(initial));
  const [meta, setMeta] = useState({ at: initial.updated_at, by: initial.updated_by_name });
  const [confirm, setConfirm] = useState<"reset" | "sessions" | null>(null);

  useEffect(() => {
    setForm(editable(initial));
    setBase(editable(initial));
  }, [initial]);

  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setForm((f) => ({ ...f, [k]: v }));
  const patch = useMemo(() => {
    const out: Partial<Editable> = {};
    (Object.keys(form) as (keyof Editable)[]).forEach((k) => {
      if (JSON.stringify(form[k]) !== JSON.stringify(base[k])) (out as Record<string, unknown>)[k] = form[k];
    });
    return out;
  }, [form, base]);
  const dirty = Object.keys(patch).length > 0;

  const localErrors = useMemo(() => {
    const e: string[] = [];
    if (form.latency_min_ms > form.latency_max_ms) e.push("Minimum latency can't be more than the maximum.");
    if (form.idle_warning_seconds >= form.idle_timeout_minutes * 60) e.push("The idle warning must start before the timeout.");
    if (form.interrupts_enabled && form.interrupt_kinds.length === 0) e.push("Choose at least one dialog type, or turn dialogs off.");
    return e;
  }, [form]);

  const applied = (env: EnvironmentSettings) => {
    setEnvironmentLocal(env);
    setBase(editable(env));
    setForm(editable(env));
    setMeta({ at: env.updated_at, by: env.updated_by_name });
    void qc.invalidateQueries({ queryKey: ["admin-overview"] });
    qc.setQueryData(["admin-environment"], env);
  };

  const save = useMutation({
    mutationFn: () => api.admin.updateEnvironment(patch),
    onSuccess: (env) => {
      applied(env);
      toast.show({ title: "Environment controls saved", text: "Signed-in staff pick up the change within 30 seconds." });
    },
  });
  const reset = useMutation({
    mutationFn: api.admin.resetEnvironment,
    onSuccess: (env) => {
      applied(env);
      setConfirm(null);
      toast.show({ title: "Environment reset to defaults" });
    },
  });
  const endSessions = useMutation({
    mutationFn: () => api.admin.endSessions(),
    onSuccess: (r) => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["admin-sessions"] });
      toast.show({ title: `Ended ${r.sessions_ended} session${r.sessions_ended === 1 ? "" : "s"}`, text: "Those users see “Session ended” on their next action." });
    },
  });

  const serverError = save.error && isApiError(save.error) && save.error.kind === "validation" ? save.error.fields.map((f) => f.message).join(" ") : null;

  return (
    <div className="stack">
      <Panel title="Presets" icon={<Zap size={15} aria-hidden="true" />}>
        <div className="toolbar">
          {PRESETS.map((p) => (
            <Button key={p.label} size="sm" onClick={() => setForm((f) => ({ ...f, ...p.patch }))} title={p.hint}>
              {p.label}
            </Button>
          ))}
          <span className="toolbar__spacer" />
          <span className="subtle" style={{ fontSize: "var(--fs-sm)" }}>
            Presets fill the form; nothing changes until you save.
          </span>
        </div>
      </Panel>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!localErrors.length && dirty) save.mutate();
        }}
      >
        <Panel
          title="Environment controls"
          icon={<SlidersHorizontal size={15} aria-hidden="true" />}
          flush
          actions={
            <span className="subtle" style={{ fontSize: "var(--fs-sm)" }}>
              Last changed by {meta.by} · {relative(meta.at)}
            </span>
          }
          footer={
            <>
              <Button variant="danger-ghost" icon={<RotateCcw size={14} aria-hidden="true" />} onClick={() => setConfirm("reset")}>
                Reset to defaults
              </Button>
              <span className="toolbar">
                {dirty && <span className="subtle" style={{ fontSize: "var(--fs-sm)" }}>{Object.keys(patch).length} unsaved change{Object.keys(patch).length === 1 ? "" : "s"}</span>}
                <Button onClick={() => setForm(base)} disabled={!dirty || save.isPending}>
                  Discard
                </Button>
                <Button type="submit" variant="primary" icon={<Save size={14} aria-hidden="true" />} disabled={!dirty || localErrors.length > 0} loading={save.isPending} loadingText="Saving…">
                  Save changes
                </Button>
              </span>
            </>
          }
        >
          {(localErrors.length > 0 || serverError || (save.isError && !serverError)) && (
            <div className="panel__body" style={{ paddingBottom: 0 }}>
              {localErrors.length > 0 && <Banner tone="bad">{localErrors.join(" ")}</Banner>}
              {serverError && <Banner tone="bad" live>{serverError}</Banner>}
              {save.isError && !serverError && <LoadError error={save.error} what="the change" />}
            </div>
          )}
          <div className="settings-grid">
            <Row title="Network latency" text="Adds delay before member requests reach the core. Use it to test loading states.">
              <Segmented
                name="latency_mode"
                label="Latency mode"
                value={form.latency_mode}
                onChange={(v) => set("latency_mode", v)}
                options={[
                  { value: "off", label: "Off" },
                  { value: "fixed", label: "Fixed" },
                  { value: "random", label: "Random range" },
                ]}
              />
              {form.latency_mode === "fixed" && <MsField label="Added delay" value={form.latency_fixed_ms} onChange={(v) => set("latency_fixed_ms", v)} max={30000} />}
              {form.latency_mode === "random" && (
                <>
                  <MsField label="Minimum" value={form.latency_min_ms} onChange={(v) => set("latency_min_ms", v)} max={30000} />
                  <MsField label="Maximum" value={form.latency_max_ms} onChange={(v) => set("latency_max_ms", v)} max={30000} />
                </>
              )}
              {form.latency_mode !== "off" && <ScopeField label="Delay applies to" value={form.latency_scope} onChange={(v) => set("latency_scope", v)} />}
            </Row>
            <Row title="Slow-loading notice" text="When screens say a request is taking longer than usual, and when they give up.">
              <MsField label="Show notice after" value={form.slow_notice_after_ms} onChange={(v) => set("slow_notice_after_ms", v)} min={500} max={30000} />
              <MsField label="Time out after" value={form.request_timeout_ms} onChange={(v) => set("request_timeout_ms", v)} min={3000} max={60000} />
            </Row>
            <Row title="Failure injection" text="Answers a share of member requests with “service unavailable” instead of calling the core.">
              <Field label="Failure rate (%)">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  className="inline-number"
                  value={form.failure_rate_pct}
                  onChange={(e) => set("failure_rate_pct", clamp(Number(e.target.value), 0, 100))}
                />
              </Field>
              {form.failure_rate_pct > 0 && <ScopeField label="Failures apply to" value={form.failure_scope} onChange={(v) => set("failure_scope", v)} />}
            </Row>
            <Row title="Unexpected dialogs" text="Interrupts staff with realistic notices they must deal with before continuing.">
              <div className="stack stack--sm" style={{ width: "100%" }}>
                <Check label="Show unexpected dialogs" checked={form.interrupts_enabled} onChange={(e) => set("interrupts_enabled", e.target.checked)} />
                {form.interrupts_enabled && (
                  <>
                    <div className="toolbar" style={{ alignItems: "flex-end" }}>
                      <Field label="Where">
                        <Select
                          value={form.interrupt_trigger}
                          onChange={(e) => set("interrupt_trigger", e.target.value as InterruptTrigger)}
                          style={{ minWidth: 220 }}
                        >
                          {Object.entries(TRIGGER_LABEL).map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Chance (%)">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          className="inline-number"
                          value={form.interrupt_probability_pct}
                          onChange={(e) => set("interrupt_probability_pct", clamp(Number(e.target.value), 0, 100))}
                        />
                      </Field>
                      <MsField label="Appears after" value={form.interrupt_delay_ms} onChange={(v) => set("interrupt_delay_ms", v)} max={10000} />
                      <div style={{ paddingBottom: 7 }}>
                        <Check
                          label="Once per session"
                          checked={form.interrupt_once_per_session}
                          onChange={(e) => set("interrupt_once_per_session", e.target.checked)}
                        />
                      </div>
                    </div>
                    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                      <legend className="field__label" style={{ padding: 0, marginBottom: 6 }}>
                        Dialog types
                      </legend>
                      <div className="kinds">
                        {KINDS.map((k) => (
                          <Check
                            key={k}
                            label={INTERRUPT_LABEL[k]}
                            checked={form.interrupt_kinds.includes(k)}
                            onChange={(e) =>
                              set("interrupt_kinds", e.target.checked ? [...form.interrupt_kinds, k] : form.interrupt_kinds.filter((x) => x !== k))
                            }
                          />
                        ))}
                      </div>
                    </fieldset>
                  </>
                )}
              </div>
            </Row>
            <Row title="Session timeout" text="Idle staff see a countdown warning, then are signed out.">
              <Field label="Idle timeout (minutes)">
                <Input
                  type="number"
                  min={1}
                  max={120}
                  className="inline-number"
                  value={form.idle_timeout_minutes}
                  onChange={(e) => set("idle_timeout_minutes", clamp(Number(e.target.value), 1, 120))}
                />
              </Field>
              <Field label="Warning (seconds)">
                <Input
                  type="number"
                  min={10}
                  max={300}
                  className="inline-number"
                  value={form.idle_warning_seconds}
                  onChange={(e) => set("idle_warning_seconds", clamp(Number(e.target.value), 10, 300))}
                />
              </Field>
              <Button variant="danger-ghost" icon={<LogOut size={14} aria-hidden="true" />} onClick={() => setConfirm("sessions")} style={{ alignSelf: "flex-end" }}>
                End all other sessions now
              </Button>
            </Row>
            <Row title="Maintenance banner" text="A notice shown under the top bar on every screen.">
              <Field label="Banner text" optional hint={`${(form.maintenance_banner ?? "").length} / 200`} className="grow">
                <Input
                  maxLength={200}
                  value={form.maintenance_banner ?? ""}
                  placeholder="e.g. Core processing is unavailable tonight 11:00 PM – 2:00 AM ET."
                  onChange={(e) => set("maintenance_banner", e.target.value || null)}
                  style={{ minWidth: 420 }}
                />
              </Field>
            </Row>
          </div>
        </Panel>
      </form>

      <Modal
        open={confirm === "reset"}
        onClose={() => setConfirm(null)}
        tone="warn"
        icon={<RotateCcw size={16} aria-hidden="true" />}
        title="Reset environment controls?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)} autoFocus>
              Cancel
            </Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
              Reset to defaults
            </Button>
          </>
        }
      >
        Latency, failures, and dialogs turn off; the idle timeout returns to 15 minutes. Staff pick this up within 30 seconds.
      </Modal>

      <Modal
        open={confirm === "sessions"}
        onClose={() => setConfirm(null)}
        tone="bad"
        icon={<LogOut size={16} aria-hidden="true" />}
        title="End every other staff session?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)} autoFocus>
              Cancel
            </Button>
            <Button variant="danger" loading={endSessions.isPending} onClick={() => endSessions.mutate()}>
              End sessions
            </Button>
          </>
        }
      >
        Everyone except you is signed out immediately and sees “Your session has ended” on their next action. Unsaved work on their screens
        is lost.
      </Modal>
    </div>
  );
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function MsField({ label, value, onChange, min = 0, max }: { label: string; value: number; onChange: (v: number) => void; min?: number; max: number }) {
  return (
    <Field label={`${label} (ms)`}>
      <Input type="number" min={min} max={max} step={100} className="inline-number" value={value} onChange={(e) => onChange(clamp(Number(e.target.value), min, max))} />
    </Field>
  );
}

function ScopeField({ label, value, onChange }: { label: string; value: Scope; onChange: (v: Scope) => void }) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value as Scope)} style={{ minWidth: 220 }}>
        {Object.entries(SCOPE_LABEL).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    </Field>
  );
}
