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
import { assertActionAllowed, derivedIds, isAllowedUrl, locatorName, PolicyViolation, Redactor, resolveTemplate, type AppProfile, type Secrets } from "./safety.js";
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
  urlBefore: string;
  urlAfter: string;
}

const pathOf = pathWithQuery;

const describeLocator = (l: Locator): string => {
  const scope = l.within ? ` in ${l.within.role}${l.within.name === undefined ? "" : ` "${l.within.name}"`}` : "";
  if (l.by === "link") return `${l.position === "first" ? "first" : "single"} link to ${l.hrefPrefix}*${scope}`;
  if (l.by === "role") return l.namePattern !== undefined ? `${l.role} /${l.namePattern}/` : l.name === undefined ? `the single ${l.role}${scope}` : `${l.role} "${l.name}"`;
  if (l.by === "cell") return `cell [${l.row}] / [${l.column}]`;
  if (l.by === "field") return `value of "${l.field}"`;
  return `${l.by} "${locatorName(l)}"`;
};

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
        const r = await decide({ goal: opts.goal, startUrl: opts.url, url: obs.url, title: obs.title, tree, history, lastResult, secrets: Object.keys(secrets) });
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
          const capability = await compile(opts, decision, recorded, extracted, surface, { llmCalls, model, finalUrl: surface.url(), humanIntervened });
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
        assertActionAllowed(profile, decision.action, decision.target);
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
        const fallbacks = await fallbacksFor(surface, decision.target, res.locator);
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
        recorded.push({ action: decision.action, target: { ...target, locators: [decision.target, ...fallbacks] }, value: decision.value, extract: decision.extract, output: decision.output, urlBefore, urlAfter: surface.url() });
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

/** Replaces each example input value with its {{placeholder}} in every string. */
function parameterize<T>(value: T, inputs: { name: string; example: string }[]): T {
  const swap = (s: string) => inputs.reduce((acc, i) => acc.split(i.example).join(`{{${i.name}}}`), s);
  return JSON.parse(JSON.stringify(value), (_k, v) => (typeof v === "string" ? swap(v) : v));
}

export async function compile(
  opts: Pick<DiscoverOptions, "profile" | "url" | "goal" | "secrets" | "runId" | "artifactsDir">,
  decision: Decision,
  recorded: readonly RecordedStep[],
  extracted: ReadonlyMap<string, unknown>,
  surface: Pick<WebSurface, "resolve">,
  meta: { llmCalls: number; model: string; finalUrl: string; humanIntervened: boolean },
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
  const inputs = decl.inputs.filter((i) => i.example.length >= 3);
  if (inputs.length !== decl.inputs.length) throw new Error("input examples must be at least 3 characters to parameterize safely");

  // Success checkpoints must hold right now, on the live page.
  const success: Checkpoint[] = [];
  for (const l of decision.success ?? []) {
    const target: Target = { description: describeLocator(l), locators: [l] };
    const derived = derivedIds(JSON.stringify(l), opts.goal);
    if (derived.length) throw new Error(`success target ${target.description} contains ${derived.join(", ")}, a value read from the screen; pick one that holds for any record`);
    if ((await surface.resolve(target)).status !== "found") throw new Error(`success target ${target.description} is not uniquely visible`);
    success.push({ kind: "visible", target });
  }
  success.unshift({ kind: "url", pattern: pathOf(meta.finalUrl) });

  const steps: Step[] = recorded.map((r, i) => ({
    id: `s${i + 1}`,
    intent: `${r.action} ${r.target.description}${r.output ? ` -> ${r.output.name}` : ""}`,
    action: r.action,
    target: r.target,
    ...(r.value !== undefined && { value: r.value }),
    ...(r.output && { output: r.output.name }),
    ...(r.extract && { extract: r.extract }),
    expect: r.urlAfter !== r.urlBefore ? [{ kind: "url" as const, pattern: pathOf(r.urlAfter) }] : [],
    timeoutMs: 15_000,
  }));

  const id = decl.id.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  const version = nextVersion(opts.artifactsDir, id);
  const artifactPath = `${opts.artifactsDir.replace(/\\/g, "/")}/${id}.v${version}.json`;
  const replayCommand = [`npm run replay -- --artifact ${artifactPath}`, ...decl.inputs.map((i) => `--input "${i.name}=<${i.name}>"`)].join(" ");
  const secretNames = [...new Set(steps.flatMap((s) => [...(s.value ?? "").matchAll(/\{\{secret\.([a-z_]+)\}\}/g)].map((m) => m[1])))];
  const start = new URL(opts.url);
  const urlForms = (cp: Checkpoint): Checkpoint => (cp.kind === "url" ? { ...cp, pattern: wildcardInputForms(cp.pattern, inputs) } : cp);
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
    steps: parameterize(steps, inputs).map((s) => ({ ...s, expect: s.expect.map((cp) => generalizeUrl(urlForms(cp))) })),
    success: parameterize(success, inputs).map((cp) => generalizeUrl(urlForms(cp))),
    conditions: opts.profile.conditions,
    usage: { replay: replayCommand },
    provenance: { discoveredAt: new Date().toISOString(), runId: opts.runId, goal: parameterize(opts.goal, inputs), model: meta.model, llmCalls: meta.llmCalls },
  };
  const capability = Capability.parse(draft);

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
