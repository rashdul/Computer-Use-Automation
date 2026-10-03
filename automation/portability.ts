/** Invariants for reusable artifacts, independent of the vendor website. */
import type { Capability, Locator, Target } from "./schema.js";

export function assertRequestedPosition(l: Locator, goal: string): void {
  if (!("position" in l) || l.position === undefined) return;
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const position = l.position;
  let allowed = typeof position === "number"
    ? new RegExp(`\\b(?:${words[position - 1] ?? "(?!)"}|${position}(?:st|nd|rd|th)?|number\\s+${position})\\b`, "i").test(goal)
    : new RegExp(`\\b${position}\\b|${position === "first" ? "\\b(?:opening|introductory|lead)\\b" : "\\bfinal\\b"}`, "i").test(goal);
  if (l.by === "content") {
    const ordinal = typeof position === "number" ? `(?:${words[position - 1] ?? "(?!)"}|${position}(?:st|nd|rd|th)?|number\\s+${position})`
      : position === "first" ? "(?:first|opening|introductory|lead)" : "(?:last|final)";
    // "First article" does not authorize picking among several paragraphs.
    allowed = new RegExp(`\\b${ordinal}\\s+(?:(?:visible|prose|body|non-empty|main)\\s+)*paragraphs?\\b|\\bparagraph\\s+${ordinal}\\b`, "i").test(goal);
  }
  if (!allowed) throw new Error(`position ${position} was not requested by the goal; an ordinal cannot resolve an ambiguous target implicitly`);
}

export function assertPortableLocator(l: Locator, goal: string, context: "extract" | "checkpoint" | "action", outputs: readonly unknown[] = []): void {
  assertRequestedPosition(l, goal);
  if (context === "extract" && l.by === "text") {
    throw new Error("literal text is output data, not an extraction locator. Use a structural content/role target, a field caption, or a table column");
  }
  if (l.by === "role" && l.namePattern !== undefined) {
    try { new RegExp(l.namePattern); } catch { throw new Error("invalid locator namePattern regex"); }
  }
  if (context === "extract" && l.by === "role" && (l.name !== undefined || l.namePattern !== undefined) && ["heading", "paragraph", "listitem", "cell", "row", "article", "main"].includes(l.role)) {
    throw new Error(`a named ${l.role} is page data, not a reusable ${context} target. Use its unnamed role, level and semantic scope instead`);
  }
  if (l.within?.role === "heading" && l.within.name !== undefined) {
    throw new Error("a heading's current title cannot be used as a scope; use its role or a stable semantic region");
  }
  if (l.by === "link" && l.position !== undefined && !l.hrefPrefix.includes("{{") && !/[/?=]$/.test(l.hrefPrefix)) {
    throw new Error("an ordered result link requires a destination family, not an individual result URL; use a stable prefix ending in /, ? or =");
  }
  const strings = Object.values(l).filter((v): v is string => typeof v === "string").concat(l.within?.name ?? [], l.by === "cell" ? l.rowKey?.value ?? [] : []);
  for (const value of outputs) {
    const output = String(value ?? "").trim();
    if (output.length < 16) continue;
    if (strings.some((s) => s === output || (s.length >= 24 && output.includes(s)))) {
      throw new Error("a target or fallback contains a value extracted from the page; output data must not be persisted as a selector");
    }
  }
}

export function assertPortableTarget(target: Target, goal: string, context: "extract" | "checkpoint" | "action", outputs: readonly unknown[] = []): void {
  for (const l of target.locators) assertPortableLocator(l, goal, context, outputs);
}

/** Reject malformed contracts before replay touches a browser. */
export function assertCapabilityContract(cap: Capability): void {
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new Error(`duplicate ${label} names or IDs in capability`);
  };
  unique(cap.inputs.map((i) => i.name), "input");
  unique(cap.outputs.map((o) => o.name), "output");
  unique(cap.steps.map((s) => s.id), "step");
  for (const input of cap.inputs) {
    if (input.pattern !== undefined) {
      try { new RegExp(input.pattern); } catch { throw new Error(`invalid regex for input "${input.name}"`); }
    }
  }
  const available = new Set([...cap.inputs.map((i) => i.name), ...cap.secrets.map((s) => `secret.${s}`)]);
  const serialized = JSON.stringify({ entryPath: cap.app.entryPath, steps: cap.steps, success: cap.success, conditions: cap.conditions });
  for (const match of serialized.matchAll(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g)) {
    if (!available.has(match[1])) throw new Error(`undeclared template input "${match[1]}"`);
  }
  for (const step of cap.steps) {
    if (["fill", "select", "press"].includes(step.action) && step.value === undefined) throw new Error(`${step.id}: ${step.action} requires a value`);
    if (step.action === "extract") {
      const output = cap.outputs.find((o) => o.name === step.output);
      if (!output) throw new Error(`${step.id}: extraction references an undeclared output`);
      if (step.extract === "href" && output.type !== "text") throw new Error(`${step.id}: href extraction requires a text output`);
    } else if (step.output !== undefined || step.extract !== undefined) {
      throw new Error(`${step.id}: only extract actions may declare output or extraction source`);
    }
  }
  for (const output of cap.outputs) {
    if (!cap.steps.some((s) => s.action === "extract" && s.output === output.name)) throw new Error(`output "${output.name}" is never extracted`);
  }
}
