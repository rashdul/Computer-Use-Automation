/**
 * Discovery: an LLM-driven observe -> decide -> act loop against the live UI,
 * then compilation of the successful run into a versioned Capability artifact.
 *
 * The model sees only a redacted accessibility tree and chooses one action per
 * turn. The runtime (not the model) resolves the target, enforces policy, acts,
 * reads values, and records what worked. The artifact is compiled from those
 * verified actions, never from the model's transcript.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Handoff } from "./handoff.js";
import { pickDecider, type DecideFn, type Decision } from "./llm.js";
import { parseOutput, pathWithQuery } from "./replay.js";
import { RunLog } from "./runlog.js";
import { assertActionAllowed, derivedIds, describeLocator, isAllowedUrl, locatorName, PolicyViolation, Redactor, resolveTemplate, type AppProfile, type Secrets } from "./safety.js";
import { assertCapabilityContract, assertPortableLocator, assertPortableTarget } from "./portability.js";
import { Capability, type Checkpoint, type Locator, type Step, type Target } from "./schema.js";
import { fallbacksFor, WebSurface } from "./surface.js";

export interface DiscoverOptions {
  profile: AppProfile;
  url: string;
  goal: string;
  secrets: Secrets;
  outDir: string;
  runId: string;
  artifactsDir: string;
  decide?: DecideFn;
  maxSteps?: number;
  maxDurationMs?: number;
  headed?: boolean;
  operator?: boolean;
  cdpPort?: number;
  /** Allow data-changing actions; each one still needs the operator's approval in the live session. */
  allowWrites?: boolean;
}

export interface DiscoverResult {
  runId: string;
  status: "success" | "needs_human" | "failed";
  artifact?: string;
  /** Ready-to-run replay command (also saved in the artifact as usage.replay). */
  replay?: string;
  capability?: Capability;
  reason?: string;
  /** Values read during the run (also partial ones on needs_human/failed). Caller channel only; never persisted. */
  outputs: Record<string, string | number>;
  steps: number;
  llmCalls: number;
  durationMs: number;
}

/** One action the runtime executed and verified during discovery. */
export interface RecordedStep {
  action: Step["action"];
  target: Target;
  value?: string;
  extract?: Step["extract"];
  output?: { name: string; type: "money" | "number" | "text" };
  /** A person approved this data-changing step; replay asks again every time. */
  approval?: boolean;
  urlBefore: string;
  urlAfter: string;
}

const pathOf = pathWithQuery;


/** A form control and its accessible name in the accessibility tree: `- button "Search"`. */
const FIXED_CONTROL = /^\s*- (?:button|tab|menuitem|checkbox|radio|switch|option|textbox|searchbox|combobox|spinbutton|slider) "((?:[^"\\]|\\.)*)"/gm;

/** True if a (fallback) locator passes the portability checks; non-portable fallbacks are dropped. */
function isPortable(l: Locator, goal: string, context: "extract" | "checkpoint" | "action"): boolean {
  try {
    assertPortableLocator(l, goal, context);
    return true;
  } catch {
    return false;
  }
}

/**
 * A control named after a value you typed PLUS other page text (e.g. an autocomplete
 * suggestion "Artificial intelligence Intelligence in machines") only exists for that value.
 * Returns the typed value it contains, or null. A name equal to the value (link "1030966") is fine.
 */
export function mixesInputWithContent(name: string, typed: string[]): string | null {
  for (const value of typed.filter((v) => v.trim().length >= 3)) {
    const at = name.toLowerCase().indexOf(value.toLowerCase());
    if (at < 0) continue;
    const rest = (name.slice(0, at) + name.slice(at + value.length)).replace(/[^\p{L}]/gu, "");
    if (rest.length >= 10) return value;
  }
  return null;
}

/** Record IDs that survive parameterization in a URL were read off the screen: match any value there. */
const generalizeUrl = (cp: Checkpoint): Checkpoint => (cp.kind === "url" ? { ...cp, pattern: cp.pattern.replace(/\d{5,}/g, "*") } : cp);

/**
 * Sites often put an input into the URL in another form ("Artificial intelligence" ->
 * /wiki/Artificial_intelligence). Those forms cannot be substituted back literally, so
 * they become "*": the checkpoint still proves which kind of page opened.
 */
export function wildcardInputForms(pattern: string, inputs: { example: string }[]): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = pattern;
  for (const { example } of inputs) {
    const forms = new Set<string>();
    for (const base of [example, example.toLowerCase()]) {
      for (const sep of ["_", "-", "+", "%20"]) forms.add(base.replace(/ /g, sep));
      forms.add(base);
    }
    forms.delete(example); // the literal form is already a {{placeholder}}
    for (const form of [...forms].filter((f) => f.length >= 3).sort((a, b) => b.length - a.length)) {
      const re = new RegExp(escape(form), "gi");
      // Only outside existing {{placeholders}}.
      out = out
        .split(/(\{\{[^}]+\}\})/)
        .map((part) => (part.startsWith("{{") ? part : part.replace(re, "*")))
        .join("");
    }
  }
  return out;
}

export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const { profile, secrets } = opts;
  const decide = opts.decide ?? pickDecider();
  const maxSteps = opts.maxSteps ?? 20;
  const maxDurationMs = opts.maxDurationMs ?? 8 * 60_000;
  const redactor = new Redactor(secrets);
  const log = new RunLog(opts.runId, opts.outDir, redactor);
  const recorded: RecordedStep[] = [];
  const extracted = new Map<string, string | number>();
  const typed: string[] = []; // literal values typed so far (inputs), never secrets
  // Control names already on screen before each value was typed (e.g. a "Search" button):
  // fixed labels, so they are never turned into {{input}} placeholders, even if equal to it.
  const fixedNames: Record<string, string[]> = {};
  const history: string[] = [];
  let lastResult = "(start)";
  let llmCalls = 0;
  let consecutiveErrors = 0;
  let model = "unknown";
  let humanIntervened = false;

  const end = (status: DiscoverResult["status"], extra: Partial<DiscoverResult> = {}): DiscoverResult => {
    const outputs = Object.fromEntries(extracted);
    const result: DiscoverResult = { runId: opts.runId, status, outputs, steps: recorded.length, llmCalls, durationMs: Date.now() - log.startedAt, ...extra };
    // Evidence keeps output names only, as in replay.
    const masked = Object.fromEntries(Object.keys(outputs).map((k) => [k, "[redacted]"]));
    log.writeJson("result.json", { ...result, outputs: masked, capability: undefined });
    log.event("run.end", { status, reason: extra.reason, artifact: extra.artifact, llmCalls });
    return result;
  };

  log.event("run.start", { mode: "discovery", url: opts.url, goal: opts.goal });
  const surface = await WebSurface.launch(profile, { headed: opts.headed, cdpPort: opts.cdpPort });
  const handoff = await Handoff.install(surface, log, { operator: !!opts.operator, cdpPort: opts.cdpPort });

  const escalate = async (reason: string, turn: number) => {
    const h = await handoff.escalate({ capability: `discovery: ${opts.goal}`, stepId: `turn-${turn}`, stepIntent: null, reason });
    if (!h.resumed) return false;
    humanIntervened = true;
    lastResult = `A human operator intervened (${h.humanActions} actions) and handed control back. Re-read the page.`;
    history.push(`${turn}. [human operator took over: ${reason}]`);
    return true;
  };

  try {
    await surface.goto(opts.url);
    for (let turn = 1; turn <= maxSteps; turn++) {
      if (Date.now() - log.startedAt > maxDurationMs) return end("failed", { reason: `timeout after ${maxDurationMs / 1000}s` });

      // OBSERVE
      const obs = await surface.observe();
      // SPA navigations can land after the action returns; the stable observation is the truth.
      if (recorded.length) recorded[recorded.length - 1].urlAfter = obs.url;
      const tree = redactor.text(obs.tree);
      log.writeText(`observations/${String(turn).padStart(2, "0")}.txt`, `${obs.url}\n${obs.title}\n\n${tree}`);

      // DECIDE
      let decision: Decision;
      try {
        const r = await decide({ goal: opts.goal, startUrl: opts.url, url: obs.url, title: obs.title, tree, history, lastResult, secrets: Object.keys(secrets), writesAllowed: !!opts.allowWrites });
        decision = r.decision;
        model = r.model;
        llmCalls++;
      } catch (e) {
        llmCalls++;
        log.event("llm.error", { turn, error: (e as Error).message });
        lastResult = `ERROR: your previous reply was invalid (${(e as Error).message.slice(0, 200)}).`;
        if (++consecutiveErrors >= 3) return end("failed", { reason: "model produced 3 invalid replies in a row" });
        continue;
      }
      log.event("llm.decision", {
        turn,
        reason: decision.reason,
        action: decision.action,
        target: decision.target && describeLocator(decision.target),
        value: decision.value,
        output: decision.output,
      });

      if (decision.action === "escalate") {
        if (await escalate(decision.reason, turn)) continue;
        return end("needs_human", { reason: decision.reason });
      }

      if (decision.action === "wait") {
        await new Promise((r) => setTimeout(r, 1_500));
        history.push(`${turn}. wait`);
        lastResult = "waited 1.5s";
        continue;
      }

      if (decision.action === "done") {
        try {
          const capability = await compile(opts, decision, recorded, extracted, surface, { llmCalls, model, finalUrl: surface.url(), humanIntervened, fixedNames });
          const file = saveArtifact(opts.artifactsDir, capability);
          log.writeJson("capability.json", capability);
          log.event("artifact.saved", { file: path.relative(process.cwd(), file), id: capability.id, version: capability.version });
          return end("success", { artifact: file, replay: capability.usage?.replay, capability });
        } catch (e) {
          lastResult = `ERROR: cannot finish yet: ${(e as Error).message}`;
          log.event("done.rejected", { turn, error: (e as Error).message });
          if (++consecutiveErrors >= 3) return end("failed", { reason: `could not compile artifact: ${(e as Error).message}` });
          continue;
        }
      }

      // ACT (runtime-verified)
      const label = `${decision.action} ${decision.target ? describeLocator(decision.target) : "(no target)"}`;
      try {
        handoff.assertAutomationInControl();
        if (!decision.target) throw new Error(`${decision.action} needs a target`);
        const risk = assertActionAllowed(profile, decision.action, decision.target, { allowWrites: opts.allowWrites });
        const mixed = decision.action !== "extract" ? mixesInputWithContent(locatorName(decision.target), typed) : null;
        if (mixed) {
          throw new Error(
            `"${locatorName(decision.target)}" combines the typed value "${mixed}" with other page text (like a suggestion's description), so it will not exist for other inputs. ` +
              `Submit instead: click the search/submit button or press Enter in the field`,
          );
        }
        const derived = derivedIds(JSON.stringify(decision.target), opts.goal);
        if (derived.length) {
          throw new Error(
            `target contains ${derived.join(", ")}, which was read from the screen rather than given in the goal, so a replay would only work for this record. ` +
              `Target the control without it, e.g. {"by":"role","role":"link","within":{"role":"table","name":"<the results table>"}} for the single match in a container`,
          );
        }
        const target: Target = { description: describeLocator(decision.target), locators: [decision.target] };
        const res = await surface.resolve(target);
        if (res.status !== "found") throw new Error(`target matched ${res.counts[0] ?? 0} elements; it must match exactly one`);
        if (decision.action === "extract" && !decision.output) throw new Error("extract needs output {name, type}");
        if (["fill", "select", "press"].includes(decision.action) && decision.value === undefined) throw new Error(`${decision.action} needs a value`);
        // Only secret references may be templates at discovery time; everything else is literal.
        const value = decision.value === undefined ? undefined : resolveTemplate(decision.value, {}, secrets);
        // Make the target hold for every record when the element allows it (paragraph text ->
        // "first paragraph in main", a named heading -> the heading, ...), then check it.
        const context = decision.action === "extract" ? "extract" : "action";
        const reusable = await surface.reusableTarget(decision.target, res.locator, context, opts.goal, typed);
        const primary = reusable.locators[0];
        const generalized = JSON.stringify(primary) !== JSON.stringify(decision.target);
        assertPortableTarget({ ...reusable, locators: [primary] }, opts.goal, context, [...extracted.values()]);
        if (generalized) log.event("target.generalized", { turn, from: describeLocator(decision.target), to: describeLocator(primary) });
        const fallbacks = generalized ? [] : (await fallbacksFor(surface, decision.target, res.locator)).filter((l) => isPortable(l, opts.goal, context));
        if (decision.action === "fill" && decision.value && !decision.value.includes("{{secret.")) {
          // Only form controls (buttons, fields, tabs...): page text and links named after the
          // value are data (a search tip, a result) and must still become {{placeholders}}.
          fixedNames[decision.value] ??= [...obs.tree.matchAll(FIXED_CONTROL)].map((m) => m[1]);
        }
        if (risk === "risky") {
          // Data-changing step: a person approves it in the live session, or it does not happen.
          const approval = await handoff.approve({ capability: `discovery: ${opts.goal}`, stepId: `turn-${turn}`, stepIntent: null, action: label });
          if (approval.decision !== "approved") {
            throw new PolicyViolation(approval.decision === "denied" ? `the operator denied: ${label}` : `${label} needs a person's approval, but no operator is attached`);
          }
        }
        const urlBefore = surface.url();
        const text = await surface.act(decision.action, res.locator, value, decision.extract);
        if (surface.blockedNavigations.length) throw new PolicyViolation(`navigation blocked: ${surface.blockedNavigations.join(", ")}`);

        let note = "ok";
        if (decision.action === "extract" && decision.output) {
          const parsed = parseOutput(decision.output.type, text ?? "");
          if (parsed === null) throw new Error(`the target's text is not a ${decision.output.type} value`);
          extracted.set(decision.output.name, parsed);
          note = `ok, read "${decision.output.name}" as ${decision.output.type} (value withheld from the model)`;
        }
        if (decision.action === "fill" && decision.value && !decision.value.includes("{{secret.")) typed.push(decision.value);
        recorded.push({ action: decision.action, target: { description: describeLocator(primary), locators: [primary, ...fallbacks] }, value: decision.value, extract: decision.extract, output: decision.output, ...(risk === "risky" && { approval: true }), urlBefore, urlAfter: surface.url() });
        log.event("action.done", { turn, action: decision.action, target: target.description, fallbacks: fallbacks.length, url: surface.url() });
        history.push(`${turn}. ${label}${decision.value !== undefined ? ` value=${JSON.stringify(decision.value)}` : ""} -> ${note}; now at ${pathOf(surface.url())}`);
        lastResult = note;
        consecutiveErrors = 0;
      } catch (e) {
        const blocked = e instanceof PolicyViolation;
        const msg = (e as Error).message.split("\n")[0];
        log.event(blocked ? "policy.blocked" : "action.error", { turn, action: label, error: msg });
        history.push(`${turn}. ${label} -> ${blocked ? "BLOCKED BY POLICY" : "ERROR"}: ${msg}`);
        lastResult = `${blocked ? "BLOCKED BY POLICY" : "ERROR"}: ${msg}`;
        surface.blockedNavigations.length = 0;
        // Never leave the model on a disallowed site or a blocked-navigation error page.
        if (!isAllowedUrl(profile, surface.url())) {
          await surface.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          surface.blockedNavigations.length = 0;
          lastResult += `. Went back to ${surface.url()}.`;
        }
        if (++consecutiveErrors >= 3) {
          // Dead end: ask a person rather than flailing.
          if (await escalate(`dead end after 3 failed actions; last: ${msg}`, turn)) {
            consecutiveErrors = 0;
            continue;
          }
          return end("needs_human", { reason: `dead end: ${msg}` });
        }
      }
    }
    return end("failed", { reason: `goal not reached within ${maxSteps} steps` });
  } catch (e) {
    const shot = await surface.screenshot(log.file("failure.png")).catch(() => null);
    log.event("run.error", { error: (e as Error).message.split("\n")[0], screenshot: shot && log.rel(shot) });
    return end("failed", { reason: (e as Error).message.split("\n")[0] });
  } finally {
    await surface.close();
  }
}

/**
 * Replaces each example input value with its {{placeholder}}.
 * - Typed values ("value" fields) are always replaced.
 * - A string equal to a control name that was on screen BEFORE the value was typed (a "Search"
 *   button when the input is "Search") is a fixed label and is left alone.
 * - Examples shorter than 3 characters ("AI") replace whole strings only, never substrings.
 */
function parameterize<T>(value: T, inputs: { name: string; example: string }[], fixed: Record<string, string[]> = {}): T {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (typeof v !== "string") return v;
    let out = v;
    for (const i of inputs) {
      if (key !== "value" && fixed[i.example]?.includes(v)) continue;
      out = i.example.length < 3 ? (out === i.example ? `{{${i.name}}}` : out) : out.split(i.example).join(`{{${i.name}}}`);
    }
    return out;
  });
}

/**
 * A page reached after an input was submitted whose URL does not contain that input (a search that
 * redirects to /doc/person) is result-specific: its last path segment becomes "*". Segments that are
 * only partly wildcarded (/doc/*-topic) are widened the same way.
 */
function resultPageUrl(cp: Checkpoint): Checkpoint {
  if (cp.kind !== "url" || cp.pattern.includes("{{")) return cp;
  const q = cp.pattern.indexOf("?");
  const pathPart = q < 0 ? cp.pattern : cp.pattern.slice(0, q);
  const query = q < 0 ? "" : cp.pattern.slice(q);
  const segments = pathPart.split("/");
  const last = segments[segments.length - 1];
  if (segments.filter(Boolean).length < 2 || last === "*" || last === "") return cp;
  if (last.includes("*") || !cp.pattern.includes("*")) segments[segments.length - 1] = "*";
  return { ...cp, pattern: segments.join("/") + query };
}

export async function compile(
  opts: Pick<DiscoverOptions, "profile" | "url" | "goal" | "secrets" | "runId" | "artifactsDir">,
  decision: Decision,
  recorded: readonly RecordedStep[],
  extracted: ReadonlyMap<string, unknown>,
  surface: Pick<WebSurface, "resolve"> & Partial<Pick<WebSurface, "reusableTarget">>,
  meta: { llmCalls: number; model: string; finalUrl: string; humanIntervened: boolean; fixedNames?: Record<string, string[]> },
): Promise<Capability> {
  const decl = decision.capability;
  if (!decl) throw new Error("done needs a capability description");
  if (!recorded.length) throw new Error("no actions were recorded");
  // A capability ends when its outputs have been read. Later steps cannot affect them, so they are
  // dropped, and cannot be used after the fact to satisfy the contract (e.g. re-typing an input).
  const lastExtract = recorded.map((r) => r.action).lastIndexOf("extract");
  if (decl.outputs.length && lastExtract >= 0) recorded = recorded.slice(0, lastExtract + 1);
  if (meta.humanIntervened) throw new Error("a human performed part of this flow; it cannot be compiled into an unattended capability");
  for (const o of decl.outputs) if (!extracted.has(o.name)) throw new Error(`output "${o.name}" was declared but never extracted`);
  const inputs = decl.inputs;
  if (inputs.some((i) => !i.example.trim())) throw new Error("every input needs the non-empty example value you typed");
  for (const i of inputs) {
    if (!i.pattern || i.example.length < 3) continue;
    // A pattern must describe the FORMAT of any valid value (^\d{7}$), not spell out this example (^Iraq$).
    const literal = i.example.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (i.pattern.toLowerCase().includes(i.example.toLowerCase()) || i.pattern.toLowerCase().includes(literal.toLowerCase())) {
      throw new Error(`input "${i.name}" pattern ${i.pattern} only accepts the example "${i.example}"; give a pattern for the format of any valid value, or omit it`);
    }
  }

  // Enforced here too, so a recording that bypassed discovery's checks still cannot persist
  // copied page data (output text, titles) as a selector.
  const outputsSeen = [...extracted.values()];
  for (const r of recorded) assertPortableTarget(r.target, opts.goal, r.action === "extract" ? "extract" : "action", outputsSeen);

  // Success checkpoints must hold right now, on the live page, and hold for any record.
  const success: Checkpoint[] = [];
  for (const l of decision.success ?? []) {
    let target: Target = { description: describeLocator(l), locators: [l] };
    const derived = derivedIds(JSON.stringify(l), opts.goal);
    if (derived.length) throw new Error(`success target ${target.description} contains ${derived.join(", ")}, a value read from the screen; pick one that holds for any record`);
    const res = await surface.resolve(target);
    if (res.status !== "found") throw new Error(`success target ${target.description} is not uniquely visible`);
    if (surface.reusableTarget) target = await surface.reusableTarget(l, res.locator, "checkpoint", opts.goal, inputs.map((i) => i.example));
    assertPortableTarget(target, opts.goal, "checkpoint", outputsSeen);
    success.push({ kind: "visible", target });
  }
  success.unshift({ kind: "url", pattern: pathOf(meta.finalUrl) });

  const steps: Step[] = recorded.map((r, i) => ({
    id: `s${i + 1}`,
    intent: "",
    action: r.action,
    target: r.target,
    ...(r.value !== undefined && { value: r.value }),
    ...(r.output && { output: r.output.name }),
    ...(r.extract && { extract: r.extract }),
    ...(r.approval && { approval: true }),
    expect: r.urlAfter !== r.urlBefore ? [{ kind: "url" as const, pattern: pathOf(r.urlAfter) }] : [],
    timeoutMs: 15_000,
  }));
  // Steps at or after the one that typed an input see input-dependent pages.
  const firstInputStep = recorded.findIndex((r) => r.action === "fill" && inputs.some((i) => r.value === i.example));

  const id = decl.id.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  const version = nextVersion(opts.artifactsDir, id);
  const artifactPath = `${opts.artifactsDir.replace(/\\/g, "/")}/${id}.v${version}.json`;
  const writes = recorded.some((r) => r.approval) ? ["--allow-writes --operator --headed"] : [];
  const replayCommand = [`npm run replay -- --artifact ${artifactPath}`, ...decl.inputs.map((i) => `--input "${i.name}=<${i.name}>"`), ...writes].join(" ");
  const secretNames = [...new Set(steps.flatMap((s) => [...(s.value ?? "").matchAll(/\{\{secret\.([a-z_]+)\}\}/g)].map((m) => m[1])))];
  const start = new URL(opts.url);
  const fixed = meta.fixedNames ?? {};
  const urlCheck = (cp: Checkpoint, afterInput: boolean): Checkpoint => {
    const general = generalizeUrl(cp.kind === "url" ? { ...cp, pattern: wildcardInputForms(cp.pattern, inputs) } : cp);
    return afterInput ? resultPageUrl(general) : general;
  };
  const finalSteps = parameterize(steps, inputs, fixed).map((s, i) => {
    const description = describeLocator(s.target.locators[0]);
    return {
      ...s,
      intent: `${s.action} ${description}${s.output ? ` -> ${s.output}` : ""}`,
      target: { ...s.target, description },
      expect: s.expect.map((cp) => urlCheck(cp, firstInputStep >= 0 && i >= firstInputStep)),
    };
  });
  const finalSuccess = parameterize(success, inputs, fixed).map((cp) =>
    cp.kind === "visible" ? { ...cp, target: { ...cp.target, description: describeLocator(cp.target.locators[0]) } } : urlCheck(cp, firstInputStep >= 0),
  );
  const draft = {
    schemaVersion: "1.0" as const,
    id,
    version,
    name: decl.name,
    description: decl.description,
    app: { id: opts.profile.id, surface: "web" as const, recordedOrigin: start.origin, entryPath: pathOf(opts.url) },
    inputs: decl.inputs.map((i) => ({ name: i.name, type: "string" as const, description: i.description, ...(i.pattern && { pattern: i.pattern }) })),
    secrets: secretNames,
    outputs: decl.outputs.map((o) => ({ ...o, ...(o.type === "money" && { currency: "USD" }) })),
    steps: finalSteps,
    success: finalSuccess,
    conditions: opts.profile.conditions,
    usage: { replay: replayCommand },
    provenance: { discoveredAt: new Date().toISOString(), runId: opts.runId, goal: parameterize(opts.goal, inputs), model: meta.model, llmCalls: meta.llmCalls },
  };
  const capability = Capability.parse(draft);
  assertCapabilityContract(capability);

  const serialized = JSON.stringify(capability);
  for (const [name, value] of Object.entries(opts.secrets)) {
    if (value.length >= 4 && serialized.includes(value)) throw new Error(`secret "${name}" would be persisted in the artifact`);
  }
  for (const i of decl.inputs) {
    if (!JSON.stringify(capability.steps).includes(`{{${i.name}}}`)) {
      throw new Error(
        `input "${i.name}" (example "${i.example}") is not used by any recorded step before the outputs were read. ` +
          `Actions after the last extract do not count. If the action that typed it was not recorded, this flow cannot be compiled: escalate instead`,
      );
    }
  }
  return capability;
}

function nextVersion(dir: string, id: string): number {
  if (!existsSync(dir)) return 1;
  const versions = readdirSync(dir)
    .map((f) => f.match(new RegExp(`^${id.replace(/[.]/g, "\\.")}\\.v(\\d+)\\.json$`))?.[1])
    .filter(Boolean)
    .map(Number);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

function saveArtifact(dir: string, cap: Capability): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cap.id}.v${cap.version}.json`);
  writeFileSync(file, JSON.stringify(cap, null, 2) + "\n");
  return file;
}
