import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CapabilityStep,
  InputValues,
  Money,
  RunResult,
} from "./schema.js";
import { Secrets } from "./secrets.js";
import { Evidence } from "./evidence.js";
import { Policy } from "./policy.js";
import { PlaywrightSurface } from "./surface.js";
import { RuntimeCondition } from "./errors.js";
import { ControlManager } from "./control.js";

export class Run {
  readonly runId = randomUUID();
  readonly outputs: Record<string, Money> = {};
  readonly control: ControlManager;
  readonly evidence: Evidence;
  surface!: PlaywrightSurface;
  currentStep = "start";
  result?: RunResult;
  modelCalls = 0;
  busy = false;
  private demoInjected = false;
  constructor(
    readonly mode: "discovery" | "replay",
    readonly inputs: InputValues,
    readonly secrets: Secrets,
    readonly policy: Policy,
    readonly goal: string,
    readonly options: {
      headed?: boolean;
      handoffDemo?: boolean;
      evidenceGroup?: string;
    } = {},
  ) {
    this.evidence = new Evidence(
      this.runId,
      path.join("evidence", options.evidenceGroup ?? mode, this.runId),
      secrets,
      inputs,
    );
    this.control = new ControlManager((t, d) => this.evidence.event(t, d));
  }
  async start() {
    await this.evidence.init();
    await this.evidence.event("run_started", {
      mode: this.mode,
      goal: this.goal,
      startUrl: this.policy.origin + "/login",
      inputs: this.inputs,
      cleanContext: true,
    });
    this.surface = await PlaywrightSurface.create(
      this.policy,
      this.secrets,
      this.inputs,
      this.options.headed,
    );
    await this.surface.page.exposeBinding(
      "__rfcuOperatorEvent",
      async (_source, event) => {
        if (this.control.owner === "human")
          await this.evidence.event("human_action", {
            ...event,
            contextId: this.surface.contextId,
            pageId: this.surface.pageId,
          });
      },
    );
    await this.surface.page.addInitScript(() => {
      document.addEventListener(
        "click",
        (e) => {
          const t = (e.target as Element).closest("button,a,input");
          const label = (
            t?.getAttribute("aria-label") ??
            t?.textContent ??
            ""
          ).trim();
          const allowed =
            /^(Resolve demonstration block|Acknowledge|Dismiss|OK, got it|Remind me later|Search|Try again)$/;
          void (window as any).__rfcuOperatorEvent({
            action: "click",
            control: allowed.test(label) ? label : "[CONTROL]",
            trusted: e.isTrusted,
          });
        },
        true,
      );
      document.addEventListener(
        "input",
        (e) =>
          void (window as any).__rfcuOperatorEvent({
            action: "input",
            value: "[REDACTED]",
            trusted: e.isTrusted,
          }),
        true,
      );
    });
    // addInitScript is also installed on the already-loaded login document.
    await this.surface.page.evaluate(() => {
      document.addEventListener(
        "click",
        (e) => {
          const t = (e.target as Element).closest("button,a,input");
          const label = (
            t?.getAttribute("aria-label") ??
            t?.textContent ??
            ""
          ).trim();
          void (window as any).__rfcuOperatorEvent({
            action: "click",
            control:
              /^(Resolve demonstration block|Acknowledge|Dismiss|OK, got it|Remind me later|Search|Try again)$/.test(
                label,
              )
                ? label
                : "[CONTROL]",
            trusted: e.isTrusted,
          });
        },
        true,
      );
      document.addEventListener(
        "input",
        (e) =>
          void (window as any).__rfcuOperatorEvent({
            action: "input",
            value: "[REDACTED]",
            trusted: e.isTrusted,
          }),
        true,
      );
    });
    await this.evidence.event("session_created", {
      contextId: this.surface.contextId,
      pageId: this.surface.pageId,
      session: "unauthenticated",
    });
  }
  async diagnostic(label: string) {
    let observation: unknown;
    try {
      observation = await this.surface.observe();
    } catch (e) {
      observation = {
        condition:
          e instanceof RuntimeCondition ? e.code : "OBSERVATION_UNAVAILABLE",
        session: this.surface?.session.state,
      };
    }
    await this.evidence.save(`${label}.snapshot.json`, {
      observation,
      currentStep: this.currentStep,
      session: this.surface?.session.state,
      owner: this.control.owner,
      contextId: this.surface?.contextId,
      pageId: this.surface?.pageId,
    });
    const demoDialog = this.surface?.page.locator(
      '[role="alertdialog"][aria-label="Demonstration: operator review required"] > section',
    );
    if (demoDialog && (await demoDialog.count().catch(() => 0))) {
      await demoDialog
        .screenshot({
          path: path.join(this.evidence.directory, `${label}.png`),
        })
        .catch(() => undefined);
      return;
    }
    if (this.surface)
      await this.surface.page
        .screenshot({
          path: path.join(this.evidence.directory, `${label}.png`),
          mask: [
            this.surface.page.locator(
              "input,.topbar,.sidebar__foot,.member-band,.crumbs,.recent-list,.tips,.grid-12,tbody,.account-head__number,.account-head__title .muted,.alert-strip,.user-menu,.stats,.empty-state",
            ),
          ],
          maskColor: "#c9d6e6",
        })
        .catch(() => undefined);
  }
  async handoff(reason: string) {
    await this.diagnostic("handoff");
    await this.control.pause({
      runId: this.runId,
      reason,
      currentStep: this.currentStep,
      goal: this.goal,
      contextId: this.surface.contextId,
      pageId: this.surface.pageId,
      screenshotPath: path.join(this.evidence.directory, "handoff.png"),
    });
    await this.surface.condition();
    if (
      await this.surface.page
        .locator('[role="alertdialog"],[role="dialog"]')
        .count()
    )
      throw new RuntimeCondition(
        "RESUME_BLOCKED",
        "Dialog remains open; resume checkpoint failed",
      );
    await this.evidence.event("resume_checkpoint", {
      session: this.surface.session.state,
      contextId: this.surface.contextId,
      pageId: this.surface.pageId,
    });
  }
  async injectDemo() {
    if (
      !this.options.handoffDemo ||
      this.demoInjected ||
      this.surface.session.state !== "authenticated"
    )
      return;
    this.demoInjected = true;
    await this.surface.page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", "alertdialog");
      overlay.setAttribute(
        "aria-label",
        "Demonstration: operator review required",
      );
      overlay.style.cssText =
        "position:fixed;inset:0;background:#0b1b30aa;z-index:99999;display:grid;place-items:center";
      const panel = document.createElement("section");
      panel.style.cssText =
        "display:block;position:relative;visibility:visible;opacity:1;background:white;color:#151c26;padding:32px;border-radius:5px;width:450px;font:16px Segoe UI;z-index:100000";
      const title = document.createElement("h2");
      title.textContent = "Demonstration: operator review";
      const p = document.createElement("p");
      p.textContent =
        "This is an explicitly simulated interruption. Take control in the operator console, resolve this block, then resume the same run.";
      const button = document.createElement("button");
      button.textContent = "Resolve demonstration block";
      button.style.cssText =
        "padding:12px;background:#173a63;color:white;border:0;cursor:pointer";
      button.onclick = () => overlay.remove();
      panel.append(title, p, button);
      overlay.append(panel);
      document.body.append(overlay);
    });
    await this.surface.page
      .getByRole("button", { name: "Resolve demonstration block", exact: true })
      .waitFor({ state: "visible" });
    await this.evidence.event("demo_interruption_injected", {
      simulatedCondition: true,
    });
    await this.handoff(
      "Demonstration interruption: operator must dismiss the visible dialog",
    );
  }
  async step(step: CapabilityStep, allowHandoff = true): Promise<void> {
    this.currentStep = step.id;
    this.control.assertAutomation();
    await this.injectDemo();
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt++) {
      const started = Date.now();
      this.busy = true;
      try {
        this.control.assertAutomation();
        if (step.precondition)
          await this.surface.checkpoint(step.precondition, this.outputs);
        await this.evidence.event("action_started", {
          stepId: step.id,
          action: step.action,
          value: step.value?.source === "secret" ? "[REDACTED]" : step.value,
          attempt,
        });
        const result = await this.surface.execute(step);
        if (result.output && step.output)
          this.outputs[step.output] = result.output;
        await this.surface.checkpoint(step.expectedState, this.outputs);
        await this.evidence.event("action_completed", {
          stepId: step.id,
          action: step.action,
          locatorResolution: result.strategy,
          checkpoint: step.expectedState,
          checkpointResult: "passed",
          durationMs: Date.now() - started,
          session: this.surface.session.state,
        });
        this.busy = false;
        return;
      } catch (error) {
        this.busy = false;
        let e =
          error instanceof RuntimeCondition
            ? error
            : new RuntimeCondition(
                error instanceof Error && error.name === "TimeoutError"
                  ? "TRANSIENT_BROWSER_TIMEOUT"
                  : "ACTION_FAILED",
                "Browser action did not complete within its bounds",
                error instanceof Error && error.name === "TimeoutError"
                  ? "recoverable"
                  : "hard",
                step.expectedState,
              );
        try {
          await this.surface.condition();
        } catch (condition) {
          if (condition instanceof RuntimeCondition) e = condition;
        }
        e.expected ??= step.expectedState;
        e.observed ??= {
          session: this.surface.session.state,
          path: (
            await this.surface.observe().catch(() => ({ path: "unavailable" }))
          ).path,
        };
        await this.evidence.event("action_error", {
          stepId: step.id,
          errorType: e.code,
          category: e.category,
          message: e.message,
          expected: e.expected,
          observed: e.observed,
          attempt,
          durationMs: Date.now() - started,
        });
        if (
          e.category === "recoverable" &&
          step.retry.safeToRepeat &&
          attempt < step.retry.maxAttempts
        ) {
          await this.evidence.event("bounded_recovery", {
            stepId: step.id,
            attempt,
            method: "UI Try again + recheck",
          });
          const retry = this.surface.page.getByRole("button", {
            name: "Try again",
            exact: true,
          });
          if ((await retry.count()) === 1) await retry.click();
          await this.surface.page.waitForTimeout(500 * attempt);
          continue;
        }
        if (
          allowHandoff &&
          [
            "CONTROL_NOT_FOUND",
            "INTERSTITIAL_BLOCKED",
            "AMBIGUOUS_TARGET",
          ].includes(e.code)
        ) {
          await this.handoff(e.message);
          // One post-intervention attempt, with all original checks; no unbounded retry.
          return this.step(step, false);
        }
        throw e;
      }
    }
    throw new RuntimeCondition("RETRY_EXHAUSTED", "Bounded recovery exhausted");
  }
  async finish(error?: unknown) {
    if (error) {
      if (error instanceof Error && !(error instanceof RuntimeCondition))
        await this.evidence.event("internal_error", {
          name: error.name,
          frames: error.stack
            ?.split("\n")
            .slice(1, 5)
            .map((s) => s.trim()),
        });
      const e =
        error instanceof RuntimeCondition
          ? error
          : new RuntimeCondition(
              "INTERNAL_ERROR",
              "Runtime failed; see the sanitized run events",
            );
      this.result =
        e.category === "business"
          ? {
              status: "business_outcome",
              code: e.code,
              message: e.message,
              runId: this.runId,
            }
          : {
              status: "failure",
              errorType: e.code,
              stepId: this.currentStep,
              expected: e.expected,
              observed: e.observed,
              message: e.message,
              runId: this.runId,
            };
      await this.diagnostic("failure");
    } else {
      this.result = {
        status: "success",
        outputs: this.outputs,
        runId: this.runId,
        humanInterventions: this.control.count,
      };
      await this.evidence.save("success.snapshot.json", {
        observation: await this.surface.observe(),
        contextId: this.surface.contextId,
        pageId: this.surface.pageId,
        outputs: this.outputs,
      });
    }
    await this.evidence.event("run_finished", {
      result: this.result,
      modelCalls: this.modelCalls,
    });
    await this.evidence.save("result.json", this.result);
    await this.evidence.save("manifest.json", {
      runId: this.runId,
      mode: this.mode,
      modelCalls: this.modelCalls,
      contextId: this.surface?.contextId,
      pageId: this.surface?.pageId,
      humanInterventions: this.control.count,
      completedAt: new Date().toISOString(),
    });
    await this.surface?.close();
    return this.result;
  }
}
