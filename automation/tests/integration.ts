import "../config.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { settings } from "../config.js";
import { Secrets } from "../secrets.js";
import { Policy } from "../policy.js";
import { Run } from "../runtime.js";
import { replay, loadCapability } from "../replay.js";
import { RuntimeCondition } from "../errors.js";

const artifact = await loadCapability("get-member-savings-balance");
const secrets = await Secrets.load();
const results: { test: string; passed: boolean; runId?: string }[] = [];
function make(member_id: string, source = secrets) {
  return new Run(
    "replay",
    { member_id },
    source,
    new Policy(settings.origin, { member_id }),
    "Integration verification",
    { evidenceGroup: "verification" },
  );
}
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const id = await fn();
    results.push({ test: name, passed: true, ...(id ? { runId: id } : {}) });
    console.log("PASS", name);
  } catch (e) {
    results.push({ test: name, passed: false });
    console.log(
      "FAIL",
      name,
      e instanceof RuntimeCondition
        ? e.code
        : e instanceof Error
          ? e.name
          : "unknown",
    );
  }
}

await check(
  "real UI replay uses a fresh authenticated session and zero LLM calls",
  async () => {
    const run = make("1000021");
    const result = await replay(run, artifact);
    assert.equal(result.status, "success");
    assert.equal(run.modelCalls, 0);
    assert.ok(run.surface.session.everAuthenticated);
    return run.runId;
  },
);
await check("missing member is a business outcome", async () => {
  const run = make("9999999");
  const result = await replay(run, artifact);
  assert.equal(result.status, "business_outcome");
  if (result.status === "business_outcome")
    assert.equal(result.code, "MEMBER_NOT_FOUND");
  return run.runId;
});
await check("restricted member is a hard permission failure", async () => {
  const run = make("1000672");
  const result = await replay(run, artifact);
  assert.equal(result.status, "failure");
  if (result.status === "failure")
    assert.equal(result.errorType, "PERMISSION_DENIED");
  return run.runId;
});
await check("empty login form reports UI validation failure", async () => {
  const run = make("1000021");
  await run.start();
  try {
    await run.step(
      artifact.steps.find((s) => s.expectedState.kind === "authenticated")!,
    );
    throw Error("unexpected-success");
  } catch (e) {
    assert.ok(e instanceof RuntimeCondition);
    assert.equal(e.code, "LOGIN_VALIDATION_FAILED");
    await run.finish(e);
  }
  return run.runId;
});
await check(
  "invalid credentials are rejected through actual login UI",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rfcu-invalid-login-"));
    try {
      // Deliberately fictitious credentials; no real secret is copied to a test file.
      const file = path.join(dir, "invalid.md");
      await writeFile(
        file,
        "Username: invalid_test_operator\nPassword: intentionally-invalid-password",
      );
      const run = make("1000021", await Secrets.load(file));
      const result = await replay(run, artifact);
      assert.equal(result.status, "failure");
      if (result.status === "failure")
        assert.equal(result.errorType, "AUTHENTICATION_REJECTED");
      return run.runId;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
await check(
  "session ends through Sign out UI and is not silently reauthenticated",
  async () => {
    const run = make("1000021");
    await run.start();
    try {
      for (const step of artifact.steps) {
        await run.step(step);
        if (run.surface.session.state === "authenticated") break;
      }
      await run.surface.page.locator(".user-menu__button").click();
      await run.surface.page
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
      await run.surface.page.waitForURL("**/login?signed_out=1");
      await assert.rejects(
        () => run.surface.condition(),
        (e: unknown) =>
          e instanceof RuntimeCondition && e.code === "SESSION_EXPIRED",
      );
      assert.equal(run.surface.session.state, "expired");
      await run.finish(
        new RuntimeCondition(
          "SESSION_EXPIRED",
          "Integration test: UI sign-out ended session",
        ),
      );
      return run.runId;
    } catch (e) {
      await run.finish(e);
      throw e;
    }
  },
);
await check(
  "bounded recovery retries a simulated transient UI error once",
  async () => {
    const run = make("1000021");
    await run.start();
    try {
      for (const step of artifact.steps) {
        await run.step(step);
        if (run.surface.session.state === "authenticated") break;
      }
      await run.surface.page.evaluate(() => {
        const panel = document.createElement("section");
        const text = document.createElement("p");
        text.textContent = "The request timed out";
        const button = document.createElement("button");
        button.textContent = "Try again";
        button.onclick = () => panel.remove();
        panel.append(text, button);
        document.body.append(panel);
      });
      await run.evidence.event("test_fault_injected", {
        simulatedCondition: true,
        kind: "transient-ui-error",
      });
      for (const step of artifact.steps.slice(3)) await run.step(step);
      const result = await run.finish();
      assert.equal(result.status, "success");
      assert.equal(
        run.evidence.events.filter((e: any) => e.type === "bounded_recovery")
          .length,
        1,
      );
      return run.runId;
    } catch (e) {
      await run.finish(e);
      throw e;
    }
  },
);
await check(
  "same-session takeover and resume (explicitly simulated operator)",
  async () => {
    const inputs = { member_id: "1000021" };
    const run = new Run(
      "replay",
      inputs,
      secrets,
      new Policy(settings.origin, inputs),
      "Verify same-session handoff",
      { handoffDemo: true, evidenceGroup: "handoff" },
    );
    const pending = replay(run, artifact);
    const deadline = Date.now() + 30000;
    while (
      run.control.owner !== "paused" &&
      !run.result &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(run.control.owner, "paused");
    const context = run.surface.context,
      page = run.surface.page;
    await run.evidence.event("operator_test_provenance", {
      operator: "automated-integration-test",
      simulatedOperator: true,
      simulatedCondition: true,
    });
    await run.control.takeover();
    await page
      .getByRole("button", { name: "Resolve demonstration block", exact: true })
      .click();
    await run.control.resume();
    const result = await pending;
    assert.equal(result.status, "success");
    assert.equal(run.surface.context, context);
    assert.equal(run.surface.page, page);
    assert.equal(run.modelCalls, 0);
    assert.equal(run.control.count, 1);
    assert.ok(
      run.evidence.events.some(
        (e: any) =>
          e.type === "human_action" &&
          e.control === "Resolve demonstration block",
      ),
    );
    return run.runId;
  },
);
await writeFile(
  "evidence/verification-results.json",
  JSON.stringify({ completedAt: new Date().toISOString(), results }, null, 2) +
    "\n",
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
