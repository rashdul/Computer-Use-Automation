import "../config.js";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { settings } from "../config.js";
import { Run } from "../runtime.js";
import { Secrets } from "../secrets.js";
import { Policy } from "../policy.js";
import { GENERAL_ROUTES } from "../rfcu-profile.js";
import { loadCapability, replay } from "../replay.js";
import type { CapabilityStep } from "../schema.js";
import { prepareOpeningFixture } from "./opening-fixture.js";

const fixture = process.argv.includes("--fixture");
const artifact = fixture
  ? undefined
  : await loadCapability("prepare-account-opening");
const secrets = await Secrets.load();
const inputs = {
  member_id: "1030966",
  checked: "true",
  purpose: "Long-term savings",
  expected_deposits: "Under $1,000",
  source_of_funds: "Employment income",
};
const make = (group: string) =>
  new Run(
    "replay",
    { ...inputs },
    secrets,
    new Policy(
      settings.origin,
      { ...inputs },
      GENERAL_ROUTES,
      undefined,
      undefined,
      "general",
    ),
    "Account-opening review verification; no account creation",
    { evidenceGroup: group, interventionEnabled: false },
  );
const run = make(fixture ? "verification" : "replay-success");
const result = artifact
  ? await replay(run, artifact)
  : await (async () => {
      await run.start();
      try {
        await prepareOpeningFixture(run);
        return await run.finish();
      } catch (error) {
        return await run.finish(error);
      }
    })();
assert.equal(result.status, "success");
assert.equal(run.modelCalls, 0);
assert.equal(run.surface.mutationAttempted, false);
console.log(
  fixture
    ? "PASS scripted real-UI review fixture"
    : "PASS different-member review replay",
  run.runId,
);

const denied = make("replay-error");
await denied.start();
await denied.evidence.event("operator_test_provenance", {
  simulatedOperator: true,
  decision: "deny",
  fixture:
    "Attempt Open account after review preparation; no disclosure/signature claims",
});
try {
  if (artifact) {
    for (const step of artifact.steps) await denied.step(step, false);
    for (const cp of artifact.successCondition)
      await denied.surface.checkpoint(cp, denied.outputs);
  } else await prepareOpeningFixture(denied);
  assert.ok(
    new URL(denied.surface.page.url()).pathname.endsWith(
      "/accounts/new/review",
    ),
  );
  assert.equal(
    await denied.surface.page
      .locator('input[name="signature"]:checked,input[type="checkbox"]:checked')
      .count(),
    0,
  );
  const step: CapabilityStep = {
    id: "test-deny-open-account",
    description: "Verify final account creation requires approval",
    action: "click",
    target: {
      description: "Open account",
      locators: [
        { kind: "role", role: "button", name: "Open account", exact: true },
      ],
    },
    risk: "read_only",
    expectedState: { kind: "authenticated" },
    retry: { maxAttempts: 1, safeToRepeat: false },
  };
  const pending = denied.step(step, false).then(
    () => undefined,
    (error) => error,
  );
  const deadline = Date.now() + 15000;
  while (!denied.approvals.request && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(denied.approvals.request);
  assert.equal(denied.control.owner, "paused");
  await denied.approvals.decide(denied.approvals.request.id, false);
  const error = await pending;
  assert.equal(error?.code, "APPROVAL_DENIED");
  assert.equal(denied.surface.mutationAttempted, false);
  await denied.finish(error);
  console.log("PASS account creation denied", denied.runId);
} catch (error) {
  await denied.finish(error);
  throw error;
}
await writeFile(
  "evidence/opening-verification.json",
  JSON.stringify(
    {
      status: "passed",
      operator: "automated-test",
      liveWritesApproved: false,
      scriptedFixture: fixture,
      genuineOpeningDiscovery: !fixture,
      replayRunId: run.runId,
      denialRunId: denied.runId,
      modelCalls: 0,
      checks: [
        "different member and compliance values",
        "final review route and heading",
        "disclosures and signature remain unselected",
        "Open account denial prevents mutation",
      ],
    },
    null,
    2,
  ) + "\n",
);
