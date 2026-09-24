import { randomUUID } from "node:crypto";
import { RuntimeCondition } from "./errors.js";
export interface ApprovalRequest {
  id: string;
  stepId: string;
  description: string;
  action: string;
  target: string;
  status: "waiting" | "approved" | "denied" | "expired";
  createdAt: string;
}
export class ApprovalManager {
  request?: ApprovalRequest;
  private settle?: (approved: boolean) => void;
  constructor(
    private event: (type: string, data: unknown) => Promise<void>,
    private timeoutMs = 15 * 60 * 1000,
  ) {}
  async wait(details: Omit<ApprovalRequest, "id" | "status" | "createdAt">) {
    if (this.settle)
      throw new RuntimeCondition(
        "APPROVAL_CONFLICT",
        "Approval already pending",
      );
    this.request = {
      ...details,
      id: randomUUID(),
      status: "waiting",
      createdAt: new Date().toISOString(),
    };
    // Register the resolver before announcing the request so a fast operator cannot race it.
    const decision = new Promise<boolean>((resolve) => {
      this.settle = resolve;
    });
    const timer = setTimeout(() => {
      if (this.request?.status === "waiting") {
        this.request.status = "expired";
        this.settle?.(false);
        this.settle = undefined;
      }
    }, this.timeoutMs);
    try {
      await this.event("approval_requested", { request: this.request });
      if (!(await decision))
        throw new RuntimeCondition(
          this.request.status === "expired"
            ? "APPROVAL_TIMEOUT"
            : "APPROVAL_DENIED",
          "The action was not approved; no change was submitted",
        );
    } finally {
      clearTimeout(timer);
      this.settle = undefined;
    }
  }
  async decide(id: string, approved: boolean) {
    if (
      !this.settle ||
      this.request?.id !== id ||
      this.request.status !== "waiting"
    )
      throw new RuntimeCondition(
        "APPROVAL_CONFLICT",
        "No matching pending approval",
      );
    this.request.status = approved ? "approved" : "denied";
    await this.event("approval_decided", { request: this.request });
    this.settle(approved);
    this.settle = undefined;
  }
}
