import "../config.js";
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { GeneralInputs, Capability, type CapabilityStep } from "../schema.js";
import { Policy } from "../policy.js";
import { GENERAL_ROUTES } from "../rfcu-profile.js";
import { ApprovalManager } from "../approval.js";
import { RuntimeCondition } from "../errors.js";
import { Secrets, parameterize } from "../secrets.js";
import { PlaywrightSurface } from "../surface.js";
import {
  extractGeneral,
  outputMatches,
  observeGeneral,
} from "../general-surface.js";
import { allowResource } from "../network.js";
import { resolveTarget } from "../locators.js";
import { SAFE_BUTTON } from "../rfcu-profile.js";

test("opening controls omit address hints and identity fields, while preserving usable radio locators", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://rfcu.example/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<label><input type="radio" name="statements"><span>Paper</span><span class="check__hint">Mailed to 77 Hidden Road</span></label><dl><dt>Member</dt><dd>Private Identity</dd></dl><div class="joint-list"><label><input type="checkbox">Private Related Person</label></div>',
      }),
    );
    await page.goto("https://rfcu.example/members/1234567/accounts/new");
    const inputs = { member_id: "1234567" };
    const secrets = await Secrets.load();
    const policy = new Policy(
      "https://rfcu.example",
      inputs,
      GENERAL_ROUTES,
      undefined,
      undefined,
      "general",
    );
    const observation = await observeGeneral(page, policy, inputs, secrets);
    assert.ok(
      !/Hidden Road|Private Identity|Private Related Person/.test(
        JSON.stringify(observation),
      ),
    );
    const paper = observation.controls.find((c) => c.name === "Paper")!;
    await (await resolveTarget(page, paper.target, inputs)).locator.check();
    assert.equal(await page.locator('input[type="radio"]').isChecked(), true);
    assert.ok(!observation.readables.some((r) => r.name === "Member"));
    assert.ok(SAFE_BUTTON.test("Continue to review"));
    assert.equal(SAFE_BUTTON.test("Open account"), false);
  } finally {
    await browser.close();
  }
});

test("operator approval buttons send the exact pending approval ID and chosen decision (API fixture)", async () => {
  const browser = await chromium.launch({ headless: true });
  const html = await readFile("automation/operator.html", "utf8");
  try {
    for (const approved of [true, false]) {
      const page = await browser.newPage();
      const requests: unknown[] = [];
      let waiting = true;
      await page.route("http://localhost:4444/**", async (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path === "/")
          return r.fulfill({ contentType: "text/html", body: html });
        if (path === "/api/config")
          return r.fulfill({
            json: { origin: "https://rfcu.example", provider: "fixture" },
          });
        if (path === "/api/capabilities") return r.fulfill({ json: [] });
        if (path === "/api/runs")
          return r.fulfill({ json: [{ runId: "fixture-run" }] });
        if (path.endsWith("/approval")) {
          assert.equal(r.request().headers()["x-rfcu-client"], "operator");
          requests.push(r.request().postDataJSON());
          waiting = false;
          return r.fulfill({
            json: { status: approved ? "approved" : "denied" },
          });
        }
        if (path === "/api/runs/fixture-run")
          return r.fulfill({
            json: {
              runId: "fixture-run",
              owner: "paused",
              currentStep: "fixture-save",
              modelCalls: 0,
              events: [],
              approval: {
                id: "fixture-approval",
                status: waiting ? "waiting" : "resolved",
                description: "Fixture only",
                action: "click",
                target: "Save note",
              },
            },
          });
        return r.fulfill({ body: "" });
      });
      await page.goto("http://localhost:4444");
      await page
        .getByRole("button", {
          name: approved ? "Approve once" : "Deny and stop",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () => document.getElementById("approval")?.hidden,
      );
      assert.deepEqual(requests, [{ id: "fixture-approval", approved }]);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("general inputs support memberless goals, arbitrary named fields and preserve JSON primitives during redaction", () => {
  assert.deepEqual(GeneralInputs.parse({}), {});
  assert.ok(
    GeneralInputs.safeParse({
      category: "Service",
      note_body: 'A "quoted" note',
      flag: "true",
      amount: "1",
    }).success,
  );
  for (const x of [
    { member_id: "123" },
    { member_id: "1234567", member_name: "Jane" },
    { account_suffix: "../../" },
    { constructor: "bad" },
  ])
    assert.equal(GeneralInputs.safeParse(x).success, false);
  const result = JSON.parse(
    parameterize(
      JSON.stringify({
        flag: true,
        n: 1,
        value: 'A "quoted" note',
        input: "1",
      }),
      { note_body: 'A "quoted" note', flag: "true", amount: "1" },
    ),
  );
  assert.deepEqual(result, {
    flag: true,
    n: 1,
    value: "{{note_body}}",
    input: "{{amount}}",
  });
  const contract = JSON.parse(
    parameterize(
      JSON.stringify({
        application: "RFCU Member Services",
        action: "click",
        type: "table",
        description: "Choose Service",
      }),
      { category: "Service", action_name: "click", output_name: "table" },
    ),
  );
  assert.deepEqual(contract, {
    application: "RFCU Member Services",
    action: "click",
    type: "table",
    description: "Choose {{category}}",
  });
  assert.ok(outputMatches(false, "boolean"));
  assert.ok(outputMatches(0, "number"));
  assert.ok(outputMatches([], "table"));
});
test("general routes cover RFCU workflows and remain member-bound and origin-bound", () => {
  const p = new Policy(
    "https://rfcu.example",
    { member_id: "1234567" },
    GENERAL_ROUTES,
    undefined,
    undefined,
    "general",
  );
  for (const path of [
    "/products",
    "/activity",
    "/admin/permissions",
    "/members/1234567/notes?compose=1",
    "/members/1234567/accounts/1234567-C01",
    "/members/1234567/accounts/new/review",
  ])
    assert.doesNotThrow(() => p.url(path));
  for (const path of [
    "/members/7654321",
    "/members/1234567/accounts/7654321-S00",
    "https://elsewhere.example/products",
    "/admin/unknown",
    "/products?redirect=evil",
  ])
    assert.throws(() => p.url(path));
  assert.ok(
    allowResource(
      "https://backend.example/rest/v1/rpc/get_products",
      p.origin,
      "https://backend.example",
      true,
    ),
  );
  assert.equal(
    allowResource(
      "https://backend.example/rest/v1/rpc/add_member_note",
      p.origin,
      "https://backend.example",
      true,
    ),
    false,
  );
});
test("approval is explicit, single-use, denyable and bounded", async () => {
  const events: unknown[] = [];
  const a = new ApprovalManager(async (t, d) => {
    events.push({ t, d });
  }, 1000);
  const details = {
    stepId: "save",
    action: "click",
    target: "Save note",
    description: "Submit prepared note",
  };
  const wait = a.wait(details);
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(() => a.decide("wrong", true));
  await a.decide(a.request!.id, true);
  await wait;
  await assert.rejects(() => a.decide(a.request!.id, true));
  const denied = a.wait(details);
  const rejection = assert.rejects(
    () => denied,
    (e: unknown) =>
      e instanceof RuntimeCondition && e.code === "APPROVAL_DENIED",
  );
  await new Promise((r) => setTimeout(r, 0));
  await a.decide(a.request!.id, false);
  await rejection;
  const timeout = new ApprovalManager(async () => {}, 10);
  await assert.rejects(
    () => timeout.wait(details),
    (e: unknown) =>
      e instanceof RuntimeCondition && e.code === "APPROVAL_TIMEOUT",
  );
  assert.equal(events.length, 4);
});
test("real DOM form approval cannot be bypassed by a read_only model label or reused after edits", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("https://rfcu.example/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<div class="shell"><label for="note">Note</label><textarea id="note">Test fixture only</textarea><button onclick="document.querySelector(\'h1\').textContent=\'Submitted fixture\'">Save note</button><h1>Notes</h1></div>',
      }),
    );
    await page.goto("https://rfcu.example/members/1234567/notes");
    const inputs = { member_id: "1234567" };
    const policy = new Policy(
      "https://rfcu.example",
      inputs,
      GENERAL_ROUTES,
      undefined,
      undefined,
      "general",
    );
    const surface = new PlaywrightSurface(
      browser,
      context,
      page,
      policy,
      await Secrets.load(),
      inputs,
    );
    const step: CapabilityStep = {
      id: "save",
      description: "Submit fixture",
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
    const request = await surface.approvalDetails(step);
    assert.ok(request);
    await assert.rejects(
      () => surface.execute(step),
      (e: unknown) =>
        e instanceof RuntimeCondition && e.code === "HUMAN_APPROVAL_REQUIRED",
    );
    assert.equal(await page.locator("h1").innerText(), "Notes");
    await page.getByLabel("Note").fill("Changed fixture");
    await assert.rejects(
      () => surface.approve(step, request.fingerprint),
      (e: unknown) =>
        e instanceof RuntimeCondition && e.code === "APPROVAL_STALE",
    );
    const fresh = await surface.approvalDetails(step);
    await surface.approve(step, fresh!.fingerprint);
    await surface.execute(step);
    surface.endAction();
    assert.equal(await page.locator("h1").innerText(), "Submitted fixture");
    await assert.rejects(() => surface.execute(step));
  } finally {
    await browser.close();
  }
});
test("table extraction validates visible headers, rejects private columns and handles general observations", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://rfcu.example/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<section class="panel"><h2>Rate sheet</h2><table><caption>Rates</caption><thead><tr><th>Code</th><th>Rate</th><th>Name</th></tr></thead><tbody><tr><td>S01</td><td>2.00%</td><td>Private person</td></tr></tbody></table></section>',
      }),
    );
    await page.goto("https://rfcu.example/products");
    const secrets = await Secrets.load();
    const p = new Policy(
      "https://rfcu.example",
      {},
      GENERAL_ROUTES,
      undefined,
      undefined,
      "general",
    );
    const observation = await observeGeneral(page, p, {}, secrets);
    assert.ok(observation.readables.some((r) => r.type === "table"));
    assert.ok(!JSON.stringify(observation).includes("Private person"));
    const step: CapabilityStep = {
      id: "rates",
      description: "Read rates",
      action: "extract",
      target: {
        description: "Rates",
        locators: [{ kind: "role", role: "table", name: "Rates", exact: true }],
      },
      output: "rates",
      outputType: "table",
      columns: ["Code", "Rate"],
      risk: "read_only",
      expectedState: { kind: "output", key: "rates", type: "table" },
      retry: { maxAttempts: 1, safeToRepeat: false },
    };
    assert.deepEqual((await extractGeneral(page, step, {}, secrets)).output, [
      { Code: "S01", Rate: "2.00%" },
    ]);
    await assert.rejects(() =>
      extractGeneral(page, { ...step, columns: ["Name"] }, {}, secrets),
    );
    await assert.rejects(() =>
      extractGeneral(page, { ...step, columns: ["Missing"] }, {}, secrets),
    );
  } finally {
    await browser.close();
  }
});
test("general schema requires real UI success checks and declared typed outputs", async () => {
  const legacy = JSON.parse(
    await readFile("artifacts/get-member-savings-balance.json", "utf8"),
  );
  const a = {
    ...legacy,
    schemaVersion: "2.0",
    inputs: [],
    outputs: [],
    steps: legacy.steps.slice(0, 3),
    successCondition: [
      { kind: "authenticated" },
      { kind: "route", path: "/members" },
    ],
  };
  assert.ok(Capability.safeParse(a).success);
  assert.equal(
    Capability.safeParse({
      ...a,
      successCondition: [{ kind: "authenticated" }],
    }).success,
    false,
  );
  assert.equal(
    Capability.safeParse({ ...a, steps: legacy.steps }).success,
    false,
  );
});

test("general checkpoints resolve ID search, query routes and prepared fields through the DOM", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("https://rfcu.example/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<div class="shell"><nav aria-label="Member record"><a href="/members/1234567/notes">Notes</a></nav><a href="/members/1234567/notes">All notes</a><table><tbody><tr data-href="/members/1234567"><td>1234567</td></tr></tbody></table><label for="note">Note</label><textarea id="note">Prepared fixture</textarea></div>',
      }),
    );
    const inputs = { member_id: "1234567", note_body: "Prepared fixture" };
    const policy = new Policy(
      "https://rfcu.example",
      inputs,
      GENERAL_ROUTES,
      undefined,
      undefined,
      "general",
    );
    const surface = new PlaywrightSurface(
      browser,
      context,
      page,
      policy,
      await Secrets.load(),
      inputs,
    );
    await page.goto("https://rfcu.example/members?q=1234567");
    await surface.checkpoint({ kind: "member_resolved" }, {});
    const observed = await observeGeneral(
      page,
      policy,
      inputs,
      await Secrets.load(),
    );
    const navTarget = observed.controls.find(
      (c) => c.target.within?.name === "Member record",
    )!.target;
    assert.equal(
      (await resolveTarget(page, navTarget, inputs)).strategy,
      "attribute",
    );
    await page.goto("https://rfcu.example/members/1234567/notes?compose=1");
    await surface.checkpoint(
      { kind: "route", path: "/members/{{member_id}}/notes?compose=1" },
      {},
    );
    await surface.checkpoint(
      {
        kind: "field_value",
        target: {
          description: "Note",
          locators: [{ kind: "label", label: "Note" }],
        },
        value: { source: "input", key: "note_body" },
      },
      {},
    );
  } finally {
    await browser.close();
  }
});
