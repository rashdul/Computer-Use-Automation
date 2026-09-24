// Explicit scripted test of the real UI. This is never saved as a discovered capability.
import assert from "node:assert/strict";
import type { Run } from "../runtime.js";
import { loadCapability } from "../replay.js";
import { observeGeneral } from "../general-surface.js";
import type { CapabilityStep, TargetSpec } from "../schema.js";

export async function prepareOpeningFixture(run: Run) {
  await run.evidence.event("test_fixture_provenance", {
    scripted: true,
    llmDiscovery: false,
    description:
      "Real UI account-opening preparation using scripted test decisions; no artifact generated",
  });
  const notes = await loadCapability("prepare-member-note");
  const end = notes.steps.findIndex(
    (s) =>
      s.expectedState.kind === "route" &&
      s.expectedState.path === "/members/{{member_id}}",
  );
  assert.ok(end >= 0);
  for (const step of notes.steps.slice(0, end + 1)) await run.step(step, false);
  async function act(
    name: string,
    action: CapabilityStep["action"],
    key?: string,
  ) {
    const o = await observeGeneral(
      run.surface.page,
      run.policy,
      run.inputs,
      run.secrets,
    );
    const c = o.controls.filter(
      (c) =>
        c.name === name &&
        (action !== "click" ||
          c.target.locators.some(
            (l) => l.kind === "role" && l.role === "button",
          )),
    );
    assert.equal(c.length, 1, "Fixture needs one observed control: " + name);
    const target: TargetSpec = c[0].target;
    await run.step(
      {
        id: "fixture-" + name.toLowerCase().replace(/[^a-z]+/g, "-"),
        description: "Scripted test: " + name,
        action,
        target,
        ...(key ? { value: { source: "input" as const, key } } : {}),
        risk: "reversible",
        expectedState: key
          ? { kind: "field_value", target, value: { source: "input", key } }
          : { kind: "authenticated" },
        retry: { maxAttempts: 1, safeToRepeat: false },
      },
      false,
    );
  }
  await act("Open sub-account", "click");
  await run.surface.checkpoint(
    { kind: "route", path: "/members/{{member_id}}/accounts/new" },
    run.outputs,
  );
  await act("Regular Share Savings", "check", "checked");
  await act("Individual", "check", "checked");
  await act("No opening deposit", "check", "checked");
  await act("Paper", "check", "checked");
  await act("Purpose of the account", "select", "purpose");
  await act("Expected monthly deposits", "select", "expected_deposits");
  await act("Source of funds", "select", "source_of_funds");
  await act("Continue to review", "click");
  await run.surface.checkpoint(
    { kind: "route", path: "/members/{{member_id}}/accounts/new/review" },
    run.outputs,
  );
  await run.surface.checkpoint(
    {
      kind: "visible",
      target: {
        description: "Review and open",
        locators: [
          {
            kind: "role",
            role: "heading",
            name: "Review and open",
            exact: true,
          },
        ],
      },
    },
    run.outputs,
  );
}
