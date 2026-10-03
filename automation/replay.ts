/**
 * Deterministic replay: runs a Capability with typed inputs. No model is involved.
 *
 * Every wait is a poll over three things, in priority order:
 *   1. known conditions from the app profile (business / recoverable / escalate / fatal),
 *   2. an unexpected open dialog (-> escalate),
 *   3. the step's target resolving to exactly one element.
 * So a "member not found" screen or a timeout banner is recognised as what it is
 * instead of surfacing as a generic "element not found".
 */
import { Handoff } from "./handoff.js";
import { assertCapabilityContract, assertPortableTarget } from "./portability.js";
import { RunLog } from "./runlog.js";
import {
  assertActionAllowed,
  assertCapabilityAllowed,
  PolicyViolation,
  Redactor,
  resolveTemplate,
  type AppProfile,
  type Secrets,
} from "./safety.js";
import type { Capability, Checkpoint, Condition, OutputType, RunResult, Step, Target } from "./schema.js";
import { WebSurface, type Resolution } from "./surface.js";

export interface ReplayOptions {
  profile: AppProfile;
  capability: Capability;
  inputs: Record<string, string>;
  secrets: Secrets;
  outDir: string;
  runId: string;
  /** Another allow-listed deployment of the same app (e.g. another tenant). */
  origin?: string;
  headed?: boolean;
  operator?: boolean;
  cdpPort?: number;
  /** Allow steps marked for approval; each still needs the operator to approve it in the live session. */
  allowWrites?: boolean;
}

type Outcome = Omit<RunResult, "runId" | "capability" | "recoveries" | "handoffs" | "approvals" | "durationMs">;

/** Ends the run with a classified result. */
class Stop extends Error {
  constructor(readonly result: Outcome) {
    super(result.status);
  }
}

const POLL_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseOutput(type: OutputType, text: string): string | number | null {
  const t = text.trim();
  if (type === "text") return t || null;
  const negative = /^\(.*\)$/.test(t) || t.startsWith("-");
  const digits = t.replace(/[^\d.]/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  if (type === "money" && !/^-?\(?\$/.test(t)) return null;
  const n = Number(digits) * (negative ? -1 : 1);
  return type === "money" ? Math.round(n * 100) / 100 : n;
}

/** Path + decoded query as a person reads it ("?q=Amber Adams", not "?q=Amber+Adams"); used for URL checkpoints. */
export function pathWithQuery(url: string): string {
  const u = new URL(url);
  const query = [...u.searchParams].map(([k, v]) => `${k}=${v}`).join("&");
  return decodeURIComponent(u.pathname) + (query ? `?${query}` : "");
}

/** URL checkpoint match: {{inputs}} are substituted literally and "*" stands for one path or query value. */
export function urlMatches(pattern: string, url: string, inputs: Record<string, string>): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Sites write an input into URLs in their own way ("Machine learning" -> /wiki/Machine_learning),
  // so a placeholder accepts the usual forms: spaces as _, -, + or %20, any letter case.
  const forms = (value: string) => [...new Set(["", "_", "-", "+", "%20"].map((sep) => (sep ? value.replace(/ /g, sep) : value)))].map(escape).join("|");
  const source = pattern
    .split(/(\{\{[^}]+\}\}|\*)/)
    .map((part) => (part === "*" ? "[^/?&=]+" : part.startsWith("{{") ? `(?:${forms(resolveTemplate(part, inputs))})` : escape(part)))
    .join("");
  return new RegExp(`^${source}$`, "i").test(pathWithQuery(url));
}

export function validateInputs(cap: Capability, inputs: Record<string, string>): string | null {
  for (const spec of cap.inputs) {
    const v = inputs[spec.name];
    if (v === undefined || v === "") return `missing input "${spec.name}"`;
    if (spec.pattern && !new RegExp(spec.pattern).test(v)) return `input "${spec.name}" does not match ${spec.pattern}`;
  }
  const unknown = Object.keys(inputs).filter((k) => !cap.inputs.some((s) => s.name === k));
  return unknown.length ? `unknown input(s): ${unknown.join(", ")}` : null;
}

export async function replay(opts: ReplayOptions): Promise<RunResult> {
  const { profile, capability: cap, inputs, secrets } = opts;
  const capId = `${cap.id}@v${cap.version}`;
  const origin = opts.origin ?? cap.app.recordedOrigin;
  const log = new RunLog(opts.runId, opts.outDir, new Redactor(secrets));
  const base = { runId: opts.runId, capability: capId, recoveries: [] as RunResult["recoveries"], handoffs: [] as RunResult["handoffs"], approvals: [] as RunResult["approvals"] };
  const finish = (r: Outcome): RunResult => {
    const result: RunResult = { ...base, ...r, durationMs: Date.now() - log.startedAt };
    // The caller receives outputs; evidence keeps only their shape.
    const persisted = { ...result, outputs: result.outputs && Object.fromEntries(Object.keys(result.outputs).map((k) => [k, "[redacted]"])) };
    log.writeJson("result.json", persisted);
    log.event("run.end", { status: result.status, outcome: result.outcome?.id, error: result.error?.code, durationMs: result.durationMs });
    return result;
  };

  log.event("run.start", { mode: "replay", capability: capId, origin, inputs });

  // Contract checks happen before the UI is touched. A malformed or non-portable artifact
  // (undeclared templates, bad regexes, copied page text as a selector) is rejected outright.
  try {
    assertCapabilityContract(cap);
    const goal = cap.provenance.goal;
    for (const step of cap.steps) {
      assertPortableTarget(step.target, goal, step.action === "extract" ? "extract" : "action");
      for (const cp of step.expect) if (cp.kind === "visible") assertPortableTarget(cp.target, goal, "checkpoint");
    }
    for (const cp of cap.success) if (cp.kind === "visible") assertPortableTarget(cp.target, goal, "checkpoint");
  } catch (e) {
    return finish({ status: "failed", error: { code: "INVALID_ARTIFACT", stepId: null, expected: "a well-formed, portable capability", observed: (e as Error).message, url: "" } });
  }
  const inputError = validateInputs(cap, inputs);
  if (inputError) {
    return finish({ status: "failed", error: { code: "INVALID_INPUT", stepId: null, expected: "inputs matching the capability contract", observed: inputError, url: "" } });
  }
  try {
    assertCapabilityAllowed(profile, cap, origin, { allowWrites: opts.allowWrites });
  } catch (e) {
    return finish({ status: "failed", error: { code: "POLICY_VIOLATION", stepId: null, expected: "artifact within policy", observed: (e as Error).message, url: "" } });
  }

  const surface = await WebSurface.launch(profile, { headed: opts.headed, cdpPort: opts.cdpPort });
  const handoff = await Handoff.install(surface, log, { operator: !!opts.operator, cdpPort: opts.cdpPort });
  const outputs: Record<string, string | number> = {};
  let current: Step | null = null;
  const recoveriesUsed = new Map<string, number>();

  const failure = async (code: string, step: Step | null, expected: string, observed: string): Promise<Stop> => {
    const obs = await surface.observe();
    const screenshot = await surface.screenshot(log.file("failure.png")).catch(() => undefined);
    const snapshot = log.writeText("failure.aria.txt", `${obs.url}\n\n${obs.tree}`);
    return new Stop({
      status: "failed",
      error: { code, stepId: step?.id ?? null, expected, observed, url: obs.url, screenshot: screenshot && log.rel(screenshot), snapshot: log.rel(snapshot) },
    });
  };

  /** Responds to a detected condition. Returns normally when the step may continue. */
  const handle = async (c: Condition, step: Step): Promise<void> => {
    log.event("condition.detected", { stepId: step.id, condition: c.id, kind: c.kind });
    switch (c.kind) {
      case "business":
        throw new Stop({ status: "business_outcome", outcome: { id: c.id, message: c.message } });
      case "fatal":
        throw await failure(`CONDITION_${c.id.toUpperCase()}`, step, step.target.description, c.message);
      case "recoverable": {
        const used = recoveriesUsed.get(c.id) ?? 0;
        if (used >= c.maxRecoveries) {
          throw await failure("RECOVERY_EXHAUSTED", step, `${c.id} cleared within ${c.maxRecoveries} attempts`, `${c.id} still present`);
        }
        recoveriesUsed.set(c.id, used + 1);
        for (const l of c.recover ?? []) {
          assertActionAllowed(profile, "click", l);
          const loc = await surface.build(l, inputs);
          if (!loc || (await loc.count()) !== 1) throw await failure("RECOVERY_FAILED", step, `recovery control for ${c.id}`, "control not found");
          handoff.assertAutomationInControl();
          await surface.act("click", loc);
        }
        // Let it clear (dialogs animate out) before the next poll, so one notice is one recovery.
        const clearBy = Date.now() + 3_000;
        while (Date.now() < clearBy && (await surface.isPresent(c.when, inputs))) await sleep(POLL_MS);
        base.recoveries.push({ stepId: step.id, condition: c.id });
        log.event("recovery", { stepId: step.id, condition: c.id, attempt: used + 1 });
        return;
      }
      case "escalate":
        return escalate(step, `${c.id}: ${c.message}`);
    }
  };

  const escalate = async (step: Step, reason: string): Promise<void> => {
    const h = await handoff.escalate({ capability: capId, stepId: step.id, stepIntent: step.intent, reason });
    if (!h.resumed) throw new Stop({ status: "needs_human", intervention: h.request });
    base.handoffs.push({ requestId: h.request.id, reason, humanActions: h.humanActions, resumedBy: h.resumedBy });
  };

  /** Polls until the target resolves, handling conditions and dialogs on the way. */
  const waitForTarget = async (step: Step, target: Target): Promise<Resolution & { status: "found" }> => {
    let deadline = Date.now() + step.timeoutMs;
    let last: Resolution = { status: "missing", counts: [] };
    // "The single X in Y" matching several (e.g. a name shared by two members) is an answer, not a crash.
    const singleMatch = target.locators.every((l) => l.by === "role" && l.name === undefined && l.namePattern === undefined);
    let ambiguousPolls = 0;
    for (;;) {
      const c = await surface.detect(cap.conditions, inputs);
      if (c) {
        await handle(c, step);
        deadline = Date.now() + step.timeoutMs; // fresh budget after a recovery or handoff
        continue;
      }
      last = await surface.resolve(target, inputs);
      const dialog = await surface.openDialog(last.status === "found" ? last.locator : undefined);
      if (dialog) {
        // The dialog may have opened after the condition check above: classify it first.
        const known = await surface.detect(cap.conditions, inputs);
        if (known) {
          await handle(known, step);
        } else {
          await escalate(step, `unexpected dialog not covered by the app profile: "${dialog.split("\n")[0]}"`);
        }
        deadline = Date.now() + step.timeoutMs;
        continue;
      }
      if (last.status === "found") return last;
      ambiguousPolls = last.status === "ambiguous" ? ambiguousPolls + 1 : 0;
      if (singleMatch && ambiguousPolls >= 4) {
        throw new Stop({ status: "business_outcome", outcome: { id: "multiple_matches", message: `More than one match for ${target.description}; use a more specific input.` } });
      }
      if (Date.now() > deadline) {
        const code = last.status === "ambiguous" ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND";
        throw await failure(code, step, `exactly one ${target.description}`, `matches per strategy: [${last.counts.join(", ")}] on ${surface.url()}`);
      }
      await sleep(POLL_MS);
    }
  };

  const checkpointHolds = async (cp: Checkpoint): Promise<boolean> => {
    if (cp.kind === "visible") return (await surface.resolve(cp.target, inputs)).status === "found";
    return urlMatches(cp.pattern, surface.url(), inputs);
  };
  const describe = (cp: Checkpoint) => (cp.kind === "url" ? `url ${resolveTemplate(cp.pattern, inputs)}` : `visible ${cp.target.description}`);

  const waitForCheckpoint = async (step: Step, cp: Checkpoint): Promise<void> => {
    const deadline = Date.now() + step.timeoutMs;
    for (;;) {
      if (await checkpointHolds(cp)) return;
      const c = await surface.detect(cap.conditions, inputs);
      if (c) {
        await handle(c, step);
        continue;
      }
      if (Date.now() > deadline) throw await failure("CHECKPOINT_FAILED", step, describe(cp), `url ${surface.url()}`);
      await sleep(POLL_MS);
    }
  };

  try {
    await surface.goto(new URL(resolveTemplate(cap.app.entryPath, inputs), origin).toString());
    for (const step of cap.steps) {
      current = step;
      log.event("step.start", { stepId: step.id, intent: step.intent });
      const found = await waitForTarget(step, step.target);
      if (step.approval) {
        // Data-changing step: a person approves it now, with the screen in front of them.
        const approval = await handoff.approve({ capability: capId, stepId: step.id, stepIntent: step.intent, action: step.intent });
        if (approval.decision === "unavailable") throw new Stop({ status: "needs_human", intervention: approval.request });
        base.approvals.push({ stepId: step.id, decision: approval.decision, by: approval.by });
        if (approval.decision === "denied") throw await failure("APPROVAL_DENIED", step, "a person's approval to change data", `denied (${approval.by})`);
      }
      handoff.assertAutomationInControl();
      const value = step.value === undefined ? undefined : resolveTemplate(step.value, inputs, secrets);
      // Log the template ({{member_id}}, {{secret.password}}), never the resolved value.
      log.event("step.action", { stepId: step.id, action: step.action, strategy: found.strategy, value: step.value });
      const text = await surface.act(step.action, found.locator, value, step.extract);
      if (surface.blockedNavigations.length) {
        throw await failure("POLICY_VIOLATION", step, "navigation within allowed origins", `blocked: ${surface.blockedNavigations.join(", ")}`);
      }
      if (step.action === "extract" && step.output) {
        const spec = cap.outputs.find((o) => o.name === step.output)!;
        const parsed = parseOutput(spec.type, text ?? "");
        if (parsed === null) throw await failure("OUTPUT_UNPARSEABLE", step, `a ${spec.type} value`, `"${text}"`);
        outputs[step.output] = parsed;
      }
      for (const cp of step.expect) await waitForCheckpoint(step, cp);
      log.event("step.done", { stepId: step.id, url: surface.url() });
    }
    current = null;
    for (const cp of cap.success) {
      if (!(await checkpointHolds(cp))) throw await failure("SUCCESS_CHECK_FAILED", null, describe(cp), `url ${surface.url()}`);
    }
    const missing = cap.outputs.filter((o) => outputs[o.name] === undefined).map((o) => o.name);
    if (missing.length) throw await failure("OUTPUT_MISSING", null, `outputs ${cap.outputs.map((o) => o.name).join(", ")}`, `missing ${missing.join(", ")}`);
    log.event("success.verified", { checkpoints: cap.success.length, outputs: Object.keys(outputs) });
    return finish({ status: "success", outputs });
  } catch (e) {
    if (e instanceof Stop) {
      if (e.result.status === "business_outcome" || e.result.status === "needs_human") {
        await surface.screenshot(log.file(`${e.result.status}.png`)).catch(() => {});
      }
      return finish(e.result);
    }
    const code = e instanceof PolicyViolation ? "POLICY_VIOLATION" : "UNEXPECTED_ERROR";
    const stop = await failure(code, current, "no runtime exception", (e as Error).message.split("\n")[0]).catch(
      () => new Stop({ status: "failed", error: { code, stepId: current?.id ?? null, expected: "", observed: String(e), url: "" } }),
    );
    return finish(stop.result);
  } finally {
    await surface.close();
  }
}
