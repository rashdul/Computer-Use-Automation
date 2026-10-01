/**
 * Evidence for one run: a structured event log plus richer signals (redacted
 * accessibility snapshots, masked screenshots). Everything written here passes
 * through the Redactor first; nothing unredacted reaches disk.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Redactor } from "./safety.js";

export class RunLog {
  readonly startedAt = Date.now();

  constructor(
    readonly runId: string,
    readonly dir: string,
    private readonly redactor: Redactor,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  static id(kind: string): string {
    return `${kind}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const entry = this.redactor.json({ t: new Date().toISOString(), type, ...data });
    appendFileSync(path.join(this.dir, "events.jsonl"), JSON.stringify(entry) + "\n");
    const summary = Object.entries(entry)
      .filter(([k]) => k !== "t" && k !== "type")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    console.error(`[${type}] ${summary.slice(0, 240)}`);
  }

  file(name: string): string {
    return path.join(this.dir, name);
  }

  writeText(name: string, text: string): string {
    const file = this.file(name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, this.redactor.text(text));
    return file;
  }

  writeJson(name: string, value: unknown): string {
    const file = this.file(name);
    writeFileSync(file, JSON.stringify(this.redactor.json(value), null, 2) + "\n");
    return file;
  }

  /** Path relative to the run directory, for references inside the log. */
  rel(file: string): string {
    return path.relative(this.dir, file).replace(/\\/g, "/");
  }
}
