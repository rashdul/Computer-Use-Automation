import { randomUUID } from "node:crypto";
import type { ControlOwner } from "./schema.js";
import { RuntimeCondition } from "./errors.js";
export interface InterventionRequest {
  id: string;
  runId: string;
  reason: string;
  currentStep: string;
  goal: string;
  contextId: string;
  pageId: string;
  status: "waiting" | "human_control" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  screenshotPath?: string;
}
export class ControlManager {
  owner: ControlOwner = "automation";
  intervention?: InterventionRequest;
  count = 0;
  private release?: () => void;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor(private event: (type: string, data: unknown) => Promise<void>) {}
  async pause(
    request: Omit<InterventionRequest, "id" | "status" | "createdAt">,
  ) {
    if (this.owner !== "automation")
      throw new RuntimeCondition("CONTROL_CONFLICT", "Already paused");
    this.owner = "paused";
    this.count++;
    this.intervention = {
      ...request,
      id: randomUUID(),
      status: "waiting",
      createdAt: new Date().toISOString(),
    };
    await this.event("intervention_requested", {
      intervention: this.intervention,
      owner: this.owner,
    });
    return new Promise<void>((resolve, reject) => {
      this.release = resolve;
      this.timeout = setTimeout(
        () => {
          this.release = undefined;
          reject(
            new RuntimeCondition(
              "HANDOFF_TIMEOUT",
              "Operator did not resume within 15 minutes",
            ),
          );
        },
        15 * 60 * 1000,
      );
    });
  }
  async takeover() {
    if (this.owner !== "paused" || !this.intervention)
      throw new RuntimeCondition("CONTROL_CONFLICT", "No waiting intervention");
    this.owner = "human";
    this.intervention.status = "human_control";
    await this.event("control_transferred", {
      owner: this.owner,
      interventionId: this.intervention.id,
    });
  }
  async resume() {
    if (this.owner !== "human" || !this.intervention || !this.release)
      throw new RuntimeCondition(
        "CONTROL_CONFLICT",
        "Human control must be acquired before resume",
      );
    this.owner = "automation";
    this.intervention.status = "resolved";
    this.intervention.resolvedAt = new Date().toISOString();
    await this.event("control_transferred", {
      owner: this.owner,
      intervention: this.intervention,
    });
    clearTimeout(this.timeout);
    const release = this.release;
    this.release = undefined;
    release();
  }
  assertAutomation() {
    if (this.owner !== "automation")
      throw new RuntimeCondition(
        "CONTROL_CONFLICT",
        "Automation does not own this page",
      );
  }
}
