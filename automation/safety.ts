/**
 * Guardrails: the app profile (allow-list + known conditions), risk classification,
 * secret loading, template resolution, and redaction of everything we persist or
 * send to the model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ActionType, Condition, type Capability, type Locator } from "./schema.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// App profile: one per vendor application, shared by all its capabilities.
// ---------------------------------------------------------------------------

export const AppProfile = z
  .object({
    id: z.string(),
    policy: z
      .object({
        allowedOrigins: z.array(z.string().url()).min(1),
        allowedActions: z.array(ActionType),
        /** Accessible names of controls that change state irreversibly or disclose protected data. */
        riskyTargetPatterns: z.array(z.string()),
      })
      .strict(),
    /** Secrets this app needs, e.g. ["username", "password"]; each is read from CUA_<NAME>. */
    secrets: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
    conditions: z.array(Condition),
  })
  .strict();
export type AppProfile = z.infer<typeof AppProfile>;

const APPS_DIR = path.join(ROOT, "automation", "apps");

export function loadAppProfile(name: string): AppProfile {
  return AppProfile.parse(JSON.parse(readFileSync(path.join(APPS_DIR, `${name}.json`), "utf8")));
}

/** Picks the app profile by its id (replay) or by the origin it allows (discovery). */
export function findAppProfile(match: { id?: string; url?: string }): AppProfile {
  const origin = match.url && URL.canParse(match.url) ? new URL(match.url).origin : undefined;
  for (const file of readdirSync(APPS_DIR).filter((f) => f.endsWith(".json"))) {
    const profile = loadAppProfile(file.slice(0, -5));
    if (match.id ? profile.id === match.id : origin && profile.policy.allowedOrigins.includes(origin)) return profile;
  }
  throw new Error(
    match.id
      ? `no app profile in automation/apps/ has id "${match.id}"`
      : `no app profile in automation/apps/ allows ${origin ?? match.url}; add the origin to one, or create a new profile`,
  );
}

/**
 * Record IDs (5+ digit numbers) in a target that the goal did not give: values the
 * agent read off the screen. A replay keyed on them would only work for that record.
 */
export function derivedIds(text: string, goal: string): string[] {
  return [...new Set(text.match(/\d{5,}/g) ?? [])].filter((id) => !goal.includes(id));
}

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export function isAllowedUrl(profile: AppProfile, url: string): boolean {
  if (url === "about:blank") return true;
  try {
    return profile.policy.allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

export type Risk = "read" | "input" | "navigate" | "risky";

export function locatorName(l: Locator): string {
  switch (l.by) {
    case "link":
      return l.hrefPrefix;
    case "role":
      return l.name ?? l.namePattern ?? "";
    case "label":
      return l.label;
    case "text":
      return l.text;
    case "field":
      return l.field;
    case "content":
      return `${l.position ?? "single"} ${l.kind}`;
    case "cell":
      return `${l.row ?? (l.rowKey ? `${l.rowKey.column} = ${l.rowKey.value}` : "")} / ${l.column}`;
  }
}

/** Human-readable target, used in logs, step intents and artifacts. */
export function describeLocator(l: Locator): string {
  const scope = l.within ? ` in ${l.within.role}${l.within.name === undefined ? "" : ` "${l.within.name}"`}` : "";
  const ordinal = (p: string | number | undefined) => (p === undefined ? "single" : typeof p === "number" ? `#${p}` : p);
  switch (l.by) {
    case "link":
      return `${ordinal(l.position)} link to ${l.hrefPrefix}*${scope}`;
    case "content":
      return `${ordinal(l.position)} ${l.kind}${scope}`;
    case "role":
      if (l.namePattern !== undefined) return `${l.role} /${l.namePattern}/${scope}`;
      if (l.name !== undefined) return `${l.role} "${l.name}"${scope}`;
      return `${l.position === undefined ? "the single" : ordinal(l.position)} ${l.role}${l.level ? ` (level ${l.level})` : ""}${scope}`;
    case "cell":
      return l.rowKey ? `cell [${l.column}] in the row whose ${l.rowKey.column} is "${l.rowKey.value}"` : `cell [${l.row}] / [${l.column}]`;
    case "field":
      return `value of "${l.field}"`;
    default:
      return `${l.by} "${locatorName(l)}"`;
  }
}

/**
 * Risk is judged from the action and what the control says it does. Read-only
 * capabilities never need a risky action, so risky actions are blocked outright
 * rather than confirmed: if a flow genuinely needs one, a person does it via handoff.
 */
export function classifyRisk(profile: AppProfile, action: string, target: Locator): Risk {
  if (action === "extract") return "read";
  const name = locatorName(target);
  if (profile.policy.riskyTargetPatterns.some((p) => new RegExp(p, "i").test(name))) return "risky";
  if (action === "fill" || action === "select" || action === "press") return "input";
  return "navigate";
}

/** Throws unless the action is on the allow-list and not risky. */
export function assertActionAllowed(profile: AppProfile, action: string, target: Locator, opts: { allowWrites?: boolean } = {}): Risk {
  if (!(profile.policy.allowedActions as string[]).includes(action)) {
    throw new PolicyViolation(`action "${action}" is not on the allow-list`);
  }
  const risk = classifyRisk(profile, action, target);
  // Read-only by default. With --allow-writes a risky action is allowed, but the caller must get
  // a person's approval in the live session before performing it (see Handoff.approve).
  if (risk === "risky" && !opts.allowWrites) {
    throw new PolicyViolation(
      `"${locatorName(target)}" changes data or is irreversible; this run is read-only (writes need --allow-writes --operator, and a person approves each one)`,
    );
  }
  return risk;
}

/** Load-time review of an artifact against the current policy (it may have changed since recording). */
export function assertCapabilityAllowed(profile: AppProfile, cap: Capability, origin: string, opts: { allowWrites?: boolean } = {}): void {
  if (!isAllowedUrl(profile, origin)) throw new PolicyViolation(`origin ${origin} is not on the allow-list`);
  for (const step of cap.steps) {
    for (const l of step.target.locators) {
      const risk = assertActionAllowed(profile, step.action, l, { allowWrites: opts.allowWrites && step.approval === true });
      // A risky step must carry the approval flag, so an edited artifact cannot skip the human.
      if (risk === "risky" && !step.approval) throw new PolicyViolation(`${step.id} changes data but is not marked for approval`);
    }
  }
}

// ---------------------------------------------------------------------------
// Secrets and templates
// ---------------------------------------------------------------------------

export type Secrets = Record<string, string>;

/** The one naming rule for every app: secret "password" is read from CUA_PASSWORD, "api_key" from CUA_API_KEY. */
export const secretVariable = (name: string): string => `CUA_${name.toUpperCase()}`;

/**
 * Values for the secrets an app profile needs, read from the generic CUA_<NAME>
 * environment variables. Nothing here is app-specific: point the same variables at
 * whichever site you are automating. Values stay in memory only.
 */
export function loadSecrets(profile: AppProfile, env: NodeJS.ProcessEnv = process.env): Secrets {
  const missing = profile.secrets.map(secretVariable).filter((v) => !env[v]);
  if (missing.length) {
    throw new Error(`app "${profile.id}" needs ${missing.join(", ")}: set ${missing.length > 1 ? "them" : "it"} in your environment or in .env (see .env.example)`);
  }
  return Object.fromEntries(profile.secrets.map((name) => [name, env[secretVariable(name)]!]));
}

/**
 * Loads KEY=value pairs from the git-ignored .env at the repository root.
 * Variables already set in the shell win, so a one-off `CUA_PASSWORD=... npm run ...` still works.
 */
export function loadDotEnv(file = path.join(ROOT, ".env"), env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (env[key] === undefined) env[key] = value;
  }
}

/** Every CUA_<NAME> variable any app profile reads a secret from. */
export function secretVariables(): string[] {
  return readdirSync(APPS_DIR)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => loadAppProfile(f.slice(0, -5)).secrets.map(secretVariable));
}

/**
 * The environment handed to model subprocesses (claude, codex): without secret
 * variables or anything that looks like a password, so an agentic model cannot read them.
 */
export function modelEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = new Set(secretVariables());
  return Object.fromEntries(Object.entries(env).filter(([k]) => !blocked.has(k) && !/PASSWORD|PASSWD|SECRET/i.test(k)));
}

const TEMPLATE = /\{\{\s*(secret\.)?([a-z][a-z0-9_]*)\s*\}\}/g;

export function resolveTemplate(text: string, inputs: Record<string, string>, secrets: Secrets = {}): string {
  return text.replace(TEMPLATE, (_, isSecret: string | undefined, name: string) => {
    const value = isSecret ? secrets[name] : inputs[name];
    if (value === undefined) throw new Error(`No value for {{${isSecret ?? ""}${name}}}`);
    return value;
  });
}

// ---------------------------------------------------------------------------
// Redaction: applied to model observations, logs, snapshots, and results.
// ---------------------------------------------------------------------------

export const SENSITIVE_PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]"],
  [/\(?\b\d{3}\)?[ .-]?\d{3}-\d{4}\b/g, "[phone]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/-?\(?\$\s?\d[\d,]*(?:\.\d+)?\)?/g, "[money]"],
  [/\b\d{2}\/\d{2}\/\d{4}\b/g, "[date]"],
];

export class Redactor {
  private secrets: string[];
  constructor(secrets: Secrets = {}) {
    // Longest first so a secret that contains another is fully removed.
    this.secrets = Object.values(secrets)
      .filter((s) => s.length >= 4)
      .sort((a, b) => b.length - a.length);
  }
  text(input: string): string {
    let out = input;
    for (const s of this.secrets) out = out.split(s).join("[secret]");
    for (const [re, label] of SENSITIVE_PATTERNS) out = out.replace(re, label);
    return out;
  }
  /** Redacts every string inside a JSON-serialisable value. */
  json<T>(value: T): T {
    return JSON.parse(JSON.stringify(value), (_k, v) => (typeof v === "string" ? this.text(v) : v));
  }
}
