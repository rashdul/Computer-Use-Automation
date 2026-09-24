import "../config.js";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { settings } from "../config.js";
import { Run } from "../runtime.js";
import { Secrets } from "../secrets.js";
import { Policy } from "../policy.js";
import { GENERAL_ROUTES } from "../rfcu-profile.js";
import { replay, loadCapability } from "../replay.js";
import type { InputValues, CapabilityStep } from "../schema.js";

const secrets = await Secrets.load();
const results: { test: string; runId: string; passed: boolean }[] = [];
function make(inputs: InputValues, group = "replay-success") {
  return new Run(
    "replay",
    inputs,
    secrets,
    new Policy(
      settings.origin,
      inputs,
      GENERAL_ROUTES,
      undefined,
      undefined,
      "general",
    ),
    "General workflow integration verification",
    { evidenceGroup: group, interventionEnabled: false },
  );
}
const products = await loadCapability("read-product-rates");
const notes = await loadCapability("prepare-member-note");
const productRun = make({});
const productResult = await replay(productRun, products);
assert.equal(productResult.status, "success");
assert.equal(productRun.modelCalls, 0);
assert.ok(
  Object.values(productRun.outputs).some(
    (v) => Array.isArray(v) && v.length > 0,
  ),
);
results.push({
  test: "Typed product table replay without LLM",
  runId: productRun.runId,
  passed: true,
});
console.log("PASS product table replay", productRun.runId);

const inputs = {
  member_id: "1030966",
  category: "Service",
  note_body: "Different synthetic verification note; must not be saved.",
};
const noteRun = make({ ...inputs });
const noteResult = await replay(noteRun, notes);
assert.equal(noteResult.status, "success");
assert.equal(noteRun.modelCalls, 0);
assert.equal(noteRun.surface.mutationAttempted, false);
assert.ok(
  notes.successCondition.some(
    (cp) => cp.kind === "field_value" && cp.value.key === "note_body",
  ),
);
results.push({
  test: "Prepared note replay with different member and note, no save",
  runId: noteRun.runId,
  passed: true,
});
console.log("PASS note preparation replay", noteRun.runId);

// This operator is deliberately an automated denial. No live data write is approved.
const denyRun = make({ ...inputs }, "replay-error");
await denyRun.start();
await denyRun.evidence.event("operator_test_provenance", {
  simulatedOperator: true,
  decision: "deny",
  fixture:
    "Append a Save note attempt after replaying the genuine preparation artifact",
});
try {
  for (const step of notes.steps) await denyRun.step(step, false);
  const save: CapabilityStep = {
    id: "test-deny-save",
    description: "Verify real Save note is stopped by denial",
    action: "click",
    target: {
      description: "Save note",
      locators: [
        { kind: "role", role: "button", name: "Save note", exact: true },
      ],
    },
    risk: "read_only",
    expectedState: { kind: "authenticated" },
    retry: { maxAttempts: 1, safeToRepeat: false },
  };
  const pending = denyRun.step(save, false).then(
    () => undefined,
    (error) => error,
  );
  const deadline = Date.now() + 15000;
  while (!denyRun.approvals.request && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(denyRun.control.owner, "paused");
  assert.ok(denyRun.approvals.request);
  await denyRun.approvals.decide(denyRun.approvals.request.id, false);
  const error = await pending;
  assert.equal(error?.code, "APPROVAL_DENIED");
  assert.equal(denyRun.surface.mutationAttempted, false);
  assert.equal(
    await denyRun.surface.page.getByLabel("Note", { exact: true }).inputValue(),
    inputs.note_body,
  );
  const result = await denyRun.finish(error);
  assert.equal(result.status, "failure");
  results.push({
    test: "Real Save note denied without mutation; automated operator",
    runId: denyRun.runId,
    passed: true,
  });
  console.log("PASS real submission denied", denyRun.runId);
} catch (error) {
  await denyRun.finish(error);
  throw error;
}
await writeFile(
  "evidence/general-verification.json",
  JSON.stringify(
    { operator: "automated-test", liveWritesApproved: false, results },
    null,
    2,
  ) + "\n",
);
