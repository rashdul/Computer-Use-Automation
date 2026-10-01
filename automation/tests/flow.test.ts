/**
 * End-to-end over the fixture app: scripted discovery -> compiled artifact ->
 * deterministic replay in every result category, including a live handoff.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { discover } from "../discover.js";
import type { DecideFn, Decision } from "../llm.js";
import { replay } from "../replay.js";
import type { Capability } from "../schema.js";
import { fixtureProfile, startFixture, type Fixture } from "./fixture.js";

const SECRETS = { username: "teller01", password: "correct-horse-battery" };
const tmp = mkdtempSync(path.join(os.tmpdir(), "cua-test-"));
let fx: Fixture;
let capability: Capability;

before(async () => {
  fx = await startFixture();
});
after(async () => {
  await fx.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Stands in for the model: the decisions a model would make on this fixture. */
function scripted(decisions: Decision[]): DecideFn {
  let i = 0;
  return async () => ({ decision: decisions[i++], model: "scripted-test" });
}

const DISCOVERY: Decision[] = [
  { reason: "user", action: "fill", target: { by: "label", label: "Username" }, value: "{{secret.username}}" },
  { reason: "pw", action: "fill", target: { by: "label", label: "Password" }, value: "{{secret.password}}" },
  { reason: "go", action: "click", target: { by: "role", role: "button", name: "Sign in" } },
  { reason: "risky, must be blocked", action: "click", target: { by: "role", role: "button", name: "Delete member" } },
  { reason: "find", action: "fill", target: { by: "role", role: "searchbox", name: "Search" }, value: "1000001" },
  { reason: "search", action: "click", target: { by: "role", role: "button", name: "Search" } },
  { reason: "open", action: "click", target: { by: "role", role: "link", name: "1000001" } },
  { reason: "read", action: "extract", target: { by: "field", field: "Current balance" }, output: { name: "balance", type: "money" } },
  {
    reason: "done",
    action: "done",
    capability: {
      id: "fixture.member.balance",
      name: "Member balance",
      description: "Look up a member and read the current balance.",
      inputs: [{ name: "member_id", description: "7-digit member number", example: "1000001", pattern: "^\\d{7}$" }],
      outputs: [{ name: "balance", type: "money", description: "Current balance" }],
    },
    success: [{ by: "role", role: "heading", name: "Member 1000001" }],
  },
];

const run = (name: string, inputs: Record<string, string>, extra: Partial<Parameters<typeof replay>[0]> = {}) =>
  replay({ profile: fixtureProfile(fx.origin), capability, inputs, secrets: SECRETS, outDir: path.join(tmp, name), runId: name, ...extra });

test("discovery compiles a parameterized, secret-free artifact and blocks risky actions", async () => {
  const out = path.join(tmp, "discovery");
  const result = await discover({
    profile: fixtureProfile(fx.origin),
    url: `${fx.origin}/login`,
    goal: "Find member 1000001 and read the balance",
    secrets: SECRETS,
    outDir: out,
    runId: "discovery-test",
    artifactsDir: path.join(tmp, "artifacts"),
    decide: scripted(DISCOVERY),
  });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(result.outputs, { balance: 1234.56 }, "discovery returns what it read to the caller");
  assert.equal(JSON.parse(readFileSync(path.join(out, "result.json"), "utf8")).outputs.balance, "[redacted]");
  capability = result.capability!;
  const json = JSON.stringify(capability);
  assert.ok(!json.includes(SECRETS.password) && !json.includes(SECRETS.username), "no secret values in the artifact");
  assert.ok(!json.includes("1000001"), "example input replaced by {{member_id}}");
  assert.ok(json.includes("{{member_id}}"));
  assert.equal(capability.version, 1);
  assert.equal(capability.steps.length, 7, "the blocked action is not recorded");
  assert.ok(capability.steps.some((s) => s.target.locators.length > 1), "verified fallbacks recorded");
  assert.deepEqual(capability.steps[2].expect, [{ kind: "url", pattern: "/search" }], "SPA/redirect landing captured as checkpoint");
  const events = readFileSync(path.join(out, "events.jsonl"), "utf8");
  assert.match(events, /policy\.blocked/);
  assert.ok(!events.includes(SECRETS.password));
});

test("replay: success returns typed outputs for a different member", async () => {
  const r = await run("success", { member_id: "1000002" });
  assert.equal(r.status, "success", JSON.stringify(r.error));
  assert.deepEqual(r.outputs, { balance: 98765.43 });
  const persisted = JSON.parse(readFileSync(path.join(tmp, "success", "result.json"), "utf8"));
  assert.equal(persisted.outputs.balance, "[redacted]", "evidence keeps output shape only");
});

test("replay: 'no such member' is a business outcome, not a failure", async () => {
  const r = await run("not-found", { member_id: "9999999" });
  assert.equal(r.status, "business_outcome");
  assert.equal(r.outcome?.id, "member_not_found");
});

test("replay: a known interstitial is recovered and recorded", async () => {
  fx.mode = "maintenance";
  try {
    const r = await run("recoverable", { member_id: "1000001" });
    assert.equal(r.status, "success", JSON.stringify(r.error));
    assert.deepEqual(r.recoveries.map((x) => x.condition), ["maintenance_notice"]);
  } finally {
    fx.mode = "none";
  }
});

test("replay: an unknown dialog with no operator ends as needs_human with an intervention request", async () => {
  fx.mode = "survey";
  try {
    const r = await run("needs-human", { member_id: "1000001" });
    assert.equal(r.status, "needs_human");
    assert.match(r.intervention!.reason, /Customer survey/);
    assert.ok(existsSync(path.join(tmp, "needs-human", r.intervention!.screenshot!)));
  } finally {
    fx.mode = "none";
  }
});

test("replay: handoff lets a human act in the SAME live session, then resumes", async () => {
  fx.mode = "survey";
  const outDir = path.join(tmp, "handoff");
  try {
    const human = (async () => {
      const request = path.join(outDir, "intervention-1.json");
      while (!existsSync(request)) await new Promise((r) => setTimeout(r, 200));
      const browser = await chromium.connectOverCDP("http://127.0.0.1:9444");
      const page = browser.contexts()[0].pages()[0];
      await page.getByRole("button", { name: "Close survey" }).click();
      writeFileSync(path.join(outDir, "RESUME"), "test operator");
    })();
    const r = await run("handoff", { member_id: "1000001" }, { operator: true, cdpPort: 9444 });
    await human;
    assert.equal(r.status, "success", JSON.stringify(r.error));
    assert.equal(r.handoffs.length, 1);
    assert.equal(r.handoffs[0].humanActions, 1, "the human's click was recorded");
    assert.equal(JSON.parse(readFileSync(path.join(outDir, "control.json"), "utf8")).controller, "automation");
  } finally {
    fx.mode = "none";
  }
});

test("replay: a missing control is a hard failure with step, expectation, observation and screenshot", async () => {
  const broken: Capability = structuredClone(capability);
  broken.steps[6].target = { description: 'field "Ledger balance"', locators: [{ by: "field", field: "Ledger balance" }] };
  broken.steps[6].timeoutMs = 1_000;
  const r = await replay({ profile: fixtureProfile(fx.origin), capability: broken, inputs: { member_id: "1000001" }, secrets: SECRETS, outDir: path.join(tmp, "hard"), runId: "hard" });
  assert.equal(r.status, "failed");
  assert.equal(r.error?.code, "TARGET_NOT_FOUND");
  assert.equal(r.error?.stepId, "s7");
  assert.ok(existsSync(path.join(tmp, "hard", "failure.png")));
});

test("replay: bad inputs and out-of-policy artifacts are rejected before touching the UI", async () => {
  const bad = await run("bad-input", { member_id: "12AB" });
  assert.equal(bad.error?.code, "INVALID_INPUT");
  const risky: Capability = structuredClone(capability);
  risky.steps[5].target.locators = [{ by: "role", role: "button", name: "Delete member" }];
  const r = await replay({ profile: fixtureProfile(fx.origin), capability: risky, inputs: { member_id: "1000001" }, secrets: SECRETS, outDir: path.join(tmp, "risky"), runId: "risky" });
  assert.equal(r.error?.code, "POLICY_VIOLATION");
  const elsewhere = await run("origin", { member_id: "1000001" }, { origin: "https://other-tenant.example.com" });
  assert.equal(elsewhere.error?.code, "POLICY_VIOLATION");
});

test("name-based lookup: the model picks a name input, derived IDs are rejected, and replay works for other names", async () => {
  const LOGIN = DISCOVERY.slice(0, 3);
  const decisions: Decision[] = [
    ...LOGIN,
    { reason: "find", action: "fill", target: { by: "role", role: "searchbox", name: "Search" }, value: "Ada Lovelace" },
    { reason: "search", action: "click", target: { by: "role", role: "button", name: "Search" } },
    { reason: "read off the screen, must be rejected", action: "click", target: { by: "role", role: "link", name: "1000001" } },
    { reason: "the single result", action: "click", target: { by: "role", role: "link", within: { role: "table", name: "Search results" } } },
    { reason: "a tab whose name carries a count", action: "click", target: { by: "role", role: "link", name: "Accounts 1" } },
    { reason: "read", action: "extract", target: { by: "field", field: "Current balance" }, output: { name: "balance", type: "money" } },
    {
      reason: "done",
      action: "done",
      capability: {
        id: "fixture.member.balance-by-name",
        name: "Member balance by name",
        description: "Find a member by full name and read the current balance.",
        inputs: [{ name: "member_name", description: "Member's full name", example: "Ada Lovelace" }],
        outputs: [{ name: "balance", type: "money", description: "Current balance" }],
      },
      success: [{ by: "text", text: "Current balance" }],
    },
  ];
  const out = path.join(tmp, "discovery-by-name");
  const result = await discover({
    profile: fixtureProfile(fx.origin),
    url: `${fx.origin}/login`,
    goal: "Find Ada Lovelace and read her balance",
    secrets: SECRETS,
    outDir: out,
    runId: "discovery-by-name",
    artifactsDir: path.join(tmp, "artifacts"),
    decide: scripted(decisions),
  });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(result.outputs, { balance: 1234.56 });
  const byName = result.capability!;
  assert.ok(!JSON.stringify(byName).includes("1000001"), "no record ID read off the screen is baked in");
  assert.ok(JSON.stringify(byName.steps).includes('"pattern":"/members/*"'), "derived ID in a URL checkpoint becomes a wildcard");
  assert.match(readFileSync(path.join(out, "events.jsonl"), "utf8"), /read from the screen/);
  assert.equal(result.replay, byName.usage?.replay);
  assert.match(result.replay!, /npm run replay -- --artifact .*fixture\.member\.balance-by-name\.v1\.json --input "member_name=<member_name>"/);

  const replayAs = (name: string) =>
    replay({ profile: fixtureProfile(fx.origin), capability: byName, inputs: { member_name: name }, secrets: SECRETS, outDir: path.join(tmp, `by-name-${name}`), runId: name });
  const turing = await replayAs("Alan Turing");
  assert.equal(turing.status, "success", JSON.stringify(turing.error));
  assert.deepEqual(turing.outputs, { balance: 5555.55 });
  const hopper = await replayAs("Grace Hopper");
  assert.equal(hopper.status, "business_outcome");
  assert.equal(hopper.outcome?.id, "multiple_matches", "a shared name is an answer for the caller, not a guess");
  const nobody = await replayAs("Nobody Here");
  assert.equal(nobody.outcome?.id, "member_not_found");
});

test("steps after the last extract cannot satisfy the contract (no re-typing an input at the end)", async () => {
  const decisions: Decision[] = [
    ...DISCOVERY.slice(0, 3),
    { reason: "read too early", action: "extract", target: { by: "role", role: "heading", name: "Member search" }, output: { name: "title", type: "text" } },
    { reason: "type the input afterwards", action: "fill", target: { by: "role", role: "searchbox", name: "Search" }, value: "1000001" },
    {
      reason: "done",
      action: "done",
      capability: {
        id: "fixture.bad-order",
        name: "bad",
        description: "bad",
        inputs: [{ name: "member_id", description: "id", example: "1000001" }],
        outputs: [{ name: "title", type: "text", description: "t" }],
      },
    },
    { reason: "cannot compile, so ask a person", action: "escalate" },
  ];
  const out = path.join(tmp, "bad-order");
  const r = await discover({
    profile: fixtureProfile(fx.origin),
    url: `${fx.origin}/login`,
    goal: "Find member 1000001",
    secrets: SECRETS,
    outDir: out,
    runId: "bad-order",
    artifactsDir: path.join(tmp, "artifacts"),
    decide: scripted(decisions),
  });
  assert.equal(r.status, "needs_human");
  assert.match(readFileSync(path.join(out, "events.jsonl"), "utf8"), /Actions after the last extract do not count/);
  assert.doesNotMatch(readFileSync(path.join(out, "events.jsonl"), "utf8"), /policy\.blocked/, "an off-origin ad frame is not a policy violation");
});

test("a server redirect off the allow-list is caught, and discovery goes back instead of acting there", async () => {
  const decisions: Decision[] = [
    ...DISCOVERY.slice(0, 3),
    { reason: "follow a link that redirects off-site", action: "click", target: { by: "role", role: "link", name: "Partner site" } },
    { reason: "carry on", action: "fill", target: { by: "role", role: "searchbox", name: "Search" }, value: "1000001" },
    { reason: "stop here", action: "escalate" },
  ];
  const out = path.join(tmp, "redirect");
  const r = await discover({
    profile: fixtureProfile(fx.origin),
    url: `${fx.origin}/login`,
    goal: "Find member 1000001",
    secrets: SECRETS,
    outDir: out,
    runId: "redirect",
    artifactsDir: path.join(tmp, "artifacts"),
    decide: scripted(decisions),
  });
  assert.equal(r.status, "needs_human");
  const events = readFileSync(path.join(out, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const blocked = events.find((e) => e.type === "policy.blocked");
  assert.ok(blocked && String(blocked.error).includes(fx.outsideOrigin), "the redirect target is reported");
  assert.ok(events.some((e) => e.type === "action.done" && e.turn === 5), "after going back, the next action works on the allowed site");

  // Replay: the same redirect ends the run as a policy violation.
  const risky: Capability = structuredClone(capability);
  risky.steps[5] = { ...risky.steps[5], target: { description: 'link "Partner site"', locators: [{ by: "role", role: "link", name: "Partner site" }] }, expect: [] };
  const rr = await replay({ profile: fixtureProfile(fx.origin), capability: risky, inputs: { member_id: "1000001" }, secrets: SECRETS, outDir: path.join(tmp, "redirect-replay"), runId: "redirect-replay" });
  assert.equal(rr.error?.code, "POLICY_VIOLATION");
});
