/**
 * Human-in-the-loop control transfer on the SAME live browser session.
 *
 * Control model: exactly one controller at a time, "automation" or "human",
 * persisted to control.json in the run directory. Automation checks it before
 * every action. On escalation the runner:
 *   1. writes an intervention request (goal/capability, step, reason, URL,
 *      masked screenshot, redacted accessibility snapshot),
 *   2. flips control to "human" and waits,
 *   3. records what the human does in the page (control + redacted value sizes),
 *   4. resumes when the operator signals (Enter in the terminal, or a RESUME
 *      file in the run directory written by an operator console), flips control
 *      back, and re-checks the screen before continuing.
 * The human uses the headed browser window, or attaches to the same session over
 * CDP (127.0.0.1:<cdpPort>) from an operator tool.
 */
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";
import type { InterventionRequest } from "./schema.js";
import type { RunLog } from "./runlog.js";
import type { WebSurface } from "./surface.js";

export type Controller = "automation" | "human";

/** In-page recorder: which control a person used, never what they typed (only its length). */
const RECORDER_SCRIPT = `(() => {
  function describe(node) {
    var el = node && node.closest ? node.closest("button,a,input,select,textarea,[role]") : null;
    if (!el) return { role: "unknown", name: "", path: location.pathname };
    var label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    var name = el.getAttribute("aria-label") || label || el.innerText || el.placeholder || "";
    return { role: el.getAttribute("role") || el.tagName.toLowerCase(), name: name.trim().slice(0, 80), path: location.pathname };
  }
  function send(action) { if (window.__cuaHumanAction) window.__cuaHumanAction(action); }
  document.addEventListener("click", function (e) { send(Object.assign({ type: "click" }, describe(e.target))); }, true);
  document.addEventListener("change", function (e) {
    var el = e.target;
    var value = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : "[" + String(el.value || "").length + " chars]";
    send(Object.assign({ type: "change", value: value }, describe(el)));
  }, true);
})();`;

export interface HumanAction {
  type: string;
  role: string;
  name: string;
  path: string;
  value?: string;
}

export interface HandoffOptions {
  /** false = no operator available: escalations end the run as needs_human. */
  operator: boolean;
  cdpPort?: number;
  timeoutMs?: number;
}

export type HandoffOutcome =
  | { resumed: true; request: InterventionRequest; humanActions: number; resumedBy: string }
  | { resumed: false; request: InterventionRequest };

export class Handoff {
  controller: Controller = "automation";
  private actions: HumanAction[] = [];
  private count = 0;

  private constructor(
    private readonly surface: WebSurface,
    private readonly log: RunLog,
    private readonly opts: HandoffOptions,
  ) {}

  /** Must run before the first navigation so the recorder is in every document. */
  static async install(surface: WebSurface, log: RunLog, opts: HandoffOptions): Promise<Handoff> {
    const h = new Handoff(surface, log, opts);
    await surface.context.exposeBinding("__cuaHumanAction", (_src, action: HumanAction) => {
      if (h.controller !== "human") return; // automation's own clicks are logged elsewhere
      h.actions.push(action);
      log.event("human.action", { ...action });
    });
    // Plain script string: runs in the page as-is, untouched by the TS transpiler.
    await surface.context.addInitScript({ content: RECORDER_SCRIPT });
    h.writeControl(null);
    return h;
  }

  assertAutomationInControl(): void {
    if (this.controller !== "automation") throw new Error("automation attempted to act while a human is in control");
  }

  async escalate(ctx: { capability: string; stepId: string | null; stepIntent: string | null; reason: string }): Promise<HandoffOutcome> {
    this.count += 1;
    const n = this.count;
    const obs = await this.surface.observe();
    const shot = await this.surface.screenshot(this.log.file(`handoff-${n}.png`)).catch(() => null);
    const snap = this.log.writeText(`handoff-${n}.aria.txt`, obs.tree);
    const request: InterventionRequest = {
      id: `${this.log.runId}-handoff-${n}`,
      capability: ctx.capability,
      stepId: ctx.stepId,
      stepIntent: ctx.stepIntent,
      reason: ctx.reason,
      url: obs.url,
      screenshot: shot ? this.log.rel(shot) : null,
      snapshot: this.log.rel(snap),
      requestedAt: new Date().toISOString(),
    };
    this.log.writeJson(`intervention-${n}.json`, {
      ...request,
      session: {
        attach: this.opts.cdpPort ? `http://127.0.0.1:${this.opts.cdpPort}` : "headed browser window",
        resume: `create ${this.log.rel(this.log.file("RESUME"))} in the run directory, or press Enter in the terminal`,
      },
    });
    this.log.event("handoff.requested", { requestId: request.id, stepId: ctx.stepId, reason: ctx.reason, url: obs.url });
    if (!this.opts.operator) return { resumed: false, request };

    const before = this.actions.length;
    this.controller = "human";
    this.writeControl(request);
    this.surface.page.on("framenavigated", this.onNavigate);
    console.error(
      `\n=== HUMAN INTERVENTION REQUIRED (${request.id}) ===\n${ctx.reason}\n` +
        `Take over the ${this.opts.cdpPort ? `session at http://127.0.0.1:${this.opts.cdpPort} or the ` : ""}browser window.\n` +
        `When done: press Enter here, or create ${this.log.file("RESUME")}\n`,
    );
    const resumedBy = await this.waitForResume(this.opts.timeoutMs ?? 15 * 60_000);
    this.surface.page.off("framenavigated", this.onNavigate);
    this.controller = "automation";
    this.writeControl(null);
    await this.surface.settle();
    const humanActions = this.actions.length - before;
    this.log.event("handoff.resumed", { requestId: request.id, resumedBy, humanActions, url: this.surface.url() });
    return { resumed: true, request, humanActions, resumedBy };
  }

  private onNavigate = (frame: import("playwright").Frame) => {
    if (frame === this.surface.page.mainFrame()) this.log.event("human.navigate", { url: frame.url() });
  };

  private writeControl(request: InterventionRequest | null): void {
    this.log.writeJson("control.json", {
      controller: this.controller,
      since: new Date().toISOString(),
      requestId: request?.id ?? null,
      reason: request?.reason ?? null,
    });
  }

  private waitForResume(timeoutMs: number): Promise<string> {
    const file = this.log.file("RESUME");
    return new Promise((resolve, reject) => {
      const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin }) : null;
      const done = (by: string | Error) => {
        clearInterval(poll);
        clearTimeout(timer);
        rl?.close();
        by instanceof Error ? reject(by) : resolve(by);
      };
      rl?.once("line", () => done("terminal"));
      const poll = setInterval(() => {
        if (!existsSync(file)) return;
        const note = readFileSync(file, "utf8").trim();
        done(note ? `resume-file: ${note.slice(0, 120)}` : "resume-file");
      }, 500);
      const timer = setTimeout(() => done(new Error(`no operator response within ${timeoutMs / 1000}s`)), timeoutMs);
    });
  }
}
