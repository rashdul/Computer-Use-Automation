import "../config.js";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { settings } from "../config.js";
import { Policy } from "../policy.js";
import { Run } from "../runtime.js";
import { Secrets } from "../secrets.js";
import { loadCapability, replay } from "../replay.js";

const secrets = await Secrets.load();
const idArtifact = await loadCapability("get-member-savings-balance");
const checks: object[] = [];
// Obtain fixture names from the actual rendered UI; retain them only in memory.
// The existing ID steps are exercised against the explicitly configured deployment.
async function fixture(member_id: string) {
  const inputs = { member_id };
  const run = new Run(
    "replay",
    inputs,
    secrets,
    new Policy(settings.origin, inputs),
    "UI fixture lookup and ID workflow verification",
    { evidenceGroup: "verification" },
  );
  let name = "";
  try {
    await run.start();
    for (const step of idArtifact.steps) {
      await run.step(step, false);
      const url = new URL(run.surface.page.url());
      if (
        url.pathname === "/members" &&
        url.searchParams.get("q") === member_id &&
        step.action === "click"
      )
        name = (
          await run.surface.page
            .locator(`tr[data-href="/members/${member_id}"] td.col-primary`)
            .innerText()
        ).trim();
    }
    assert.ok(name);
    await run.finish();
    checks.push({
      case: "existing ID steps through real UI",
      runId: run.runId,
      status: run.result?.status,
    });
    return { name, balance: run.outputs.savings_balance };
  } catch (e) {
    await run.finish(e);
    throw new Error(
      "Fixture UI lookup failed; inspect sanitized verification evidence",
    );
  }
}
const first = await fixture("1030966");
const second = await fixture("1000021");
if (process.argv.includes("--discover")) {
  const { discover } = await import("../discovery.js");
  const { providerFromEnv } = await import("../providers.js");
  const inputs = { member_name: first.name };
  const run = new Run(
    "discovery",
    inputs,
    secrets,
    new Policy(settings.origin, inputs),
    "Log in to RFCU, look up member {{member_name}}, and return their current savings balance.",
    { evidenceGroup: "discovery" },
  );
  const result = await discover(
    run,
    providerFromEnv(),
    "get-member-savings-balance-by-name",
  );
  console.log("Name discovery:", result.status, "run", run.runId);
  assert.equal(result.status, "success");
  checks.push({
    case: "genuine name discovery",
    runId: run.runId,
    status: result.status,
    modelCalls: run.modelCalls,
  });
}
const artifact = await loadCapability("get-member-savings-balance-by-name");
for (const item of [
  { name: second.name, expected: "success", code: undefined },
  { name: "Smith", expected: "business_outcome", code: "MEMBER_AMBIGUOUS" },
  {
    name: "Zzznonexistentmember Zzz",
    expected: "business_outcome",
    code: "MEMBER_NOT_FOUND",
  },
]) {
  const inputs = { member_name: item.name };
  const run = new Run(
    "replay",
    inputs,
    secrets,
    new Policy(settings.origin, inputs),
    "Name lookup verification",
    { evidenceGroup: "verification" },
  );
  const result = await replay(run, artifact);
  assert.equal(result.status, item.expected);
  if (result.status === "business_outcome")
    assert.equal(result.code, item.code);
  if (result.status === "success")
    assert.deepEqual(result.outputs.savings_balance, second.balance);
  assert.equal(run.modelCalls, 0);
  const log = await readFile(run.evidence.directory + "/events.jsonl", "utf8");
  assert.ok(!log.includes(item.name));
  checks.push({
    case: item.code ?? "different name replay",
    status: result.status,
    runId: run.runId,
    modelCalls: 0,
  });
  console.log("PASS", item.code ?? "different name replay", run.runId);
}
const serialized = JSON.stringify(artifact);
assert.ok(
  !serialized.includes(first.name) && !serialized.includes(second.name),
);
await writeFile(
  "evidence/name-lookup-verification.json",
  JSON.stringify({ origin: settings.origin, discoveryRunId: artifact.metadata.discoveryRunId, checks }, null, 2) + "\n",
);
