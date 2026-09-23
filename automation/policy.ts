import type { CapabilityStep, InputValues } from "./schema.js";
import { RuntimeCondition } from "./errors.js";

export const ROUTES = [
  "/login",
  "/session-expired",
  "/members",
  "/members/{{member_id}}",
  "/members/{{member_id}}/accounts",
  "/members/{{member_id}}/accounts/{{member_id}}-S00",
];
export function interpolate(text: string, inputs: InputValues) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key !== "member_id")
      throw new RuntimeCondition(
        "INVALID_PARAMETER",
        "Unknown parameter reference",
      );
    return inputs.member_id;
  });
}
export class Policy {
  readonly origins: string[];
  constructor(
    public origin: string,
    public inputs: InputValues,
    public routes = ROUTES,
    public actions = ["click", "fill", "select", "navigate", "wait", "extract"],
  ) {
    const u = new URL(origin);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      !["http:", "https:"].includes(u.protocol)
    )
      throw new RuntimeCondition(
        "POLICY_DENIED",
        "This demo only supports local RFCU origins",
      );
    this.origin = u.origin;
    this.origins = [u.origin];
  }
  url(value: string) {
    const u = new URL(value, this.origin);
    const path = decodeURIComponent(u.pathname);
    if (
      u.origin !== this.origin ||
      u.username ||
      u.password ||
      !this.routes.some((p) => interpolate(p, this.inputs) === path)
    )
      throw new RuntimeCondition(
        "POLICY_DENIED",
        "Origin or route is outside the configured scope",
      );
    for (const [key, val] of u.searchParams) {
      if (key !== "q" || val !== this.inputs.member_id || path !== "/members")
        throw new RuntimeCondition(
          "POLICY_DENIED",
          "Unexpected query parameters",
        );
    }
    return u.href;
  }
  step(step: CapabilityStep, pathname: string) {
    if (!this.actions.includes(step.action))
      throw new RuntimeCondition("POLICY_DENIED", "Action class not allowed");
    if (["sensitive", "irreversible"].includes(step.risk))
      throw new RuntimeCondition(
        "HUMAN_APPROVAL_REQUIRED",
        "Risky actions are stopped before execution",
      );
    const t = JSON.stringify(step.target ?? {});
    if (
      /Reveal|Show password|Open sub-account|Add note|Submit|Transfer|Delete|Attest|Sign out/i.test(
        t,
      )
    )
      throw new RuntimeCondition(
        "HUMAN_APPROVAL_REQUIRED",
        "Control is outside the read-only savings capability",
      );
    if (step.value?.source === "secret") {
      const label =
        step.value.key === "RFCU_STAFF_PASSWORD" ? "Password" : "Username";
      if (
        pathname !== "/login" ||
        step.action !== "fill" ||
        !step.target?.locators.every((l) =>
          l.kind === "label"
            ? l.label === label
            : l.kind === "role"
              ? l.role === "textbox" && l.name === label
              : l.kind === "attribute"
                ? l.tag === "input" &&
                  l.attribute === "name" &&
                  l.value === label.toLowerCase()
                : false,
        )
      )
        throw new RuntimeCondition(
          "POLICY_DENIED",
          "Secret reference is not bound to its login field",
        );
    }
    if (
      step.action === "fill" &&
      step.value?.source !== "secret" &&
      !(
        step.value?.source === "input" &&
        step.target?.locators.every((l) =>
          l.kind === "label"
            ? l.label === "Search"
            : l.kind === "role"
              ? l.role === "searchbox" && l.name === "Search"
              : l.kind === "attribute" &&
                l.tag === "input" &&
                l.attribute === "name" &&
                l.value === "q",
        )
      )
    )
      throw new RuntimeCondition(
        "POLICY_DENIED",
        "Only parameterized member search is writable",
      );
    if (step.action === "select")
      throw new RuntimeCondition(
        "POLICY_DENIED",
        "No selection controls are needed by this capability",
      );
    if (step.action === "navigate")
      this.url(
        interpolate(
          step.value?.source === "literal" ? step.value.value : "",
          this.inputs,
        ),
      );
  }
}
