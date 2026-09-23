import "../config.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { Inputs, Step, Capability, type CapabilityStep } from "../schema.js";
import { Secrets, parameterize, redactPII } from "../secrets.js";
import { Policy } from "../policy.js";
import { classifyText, RuntimeCondition } from "../errors.js";
import { SessionManager } from "../session.js";
import { ControlManager } from "../control.js";
import { resolveTarget } from "../locators.js";
import { parseMoney } from "../surface.js";
import { OpenAIProvider, providerFromEnv } from "../providers.js";
import { allowResource } from "../network.js";

const inputs = { member_id: "1234567" };
const fill: CapabilityStep = {
  id: "username",
  description: "Fill staff identity",
  action: "fill",
  target: {
    description: "Username",
    locators: [{ kind: "label", label: "Username" }],
  },
  value: { source: "secret", key: "RFCU_STAFF_USERNAME" },
  risk: "reversible",
  expectedState: {
    kind: "visible",
    target: {
      description: "Username",
      locators: [{ kind: "label", label: "Username" }],
    },
  },
  retry: { maxAttempts: 1, safeToRepeat: false },
};
test("input validation rejects invalid IDs and extra fields", () => {
  assert.equal(Inputs.parse(inputs).member_id, "1234567");
  for (const value of [
    { member_id: "123456" },
    { member_id: 1234567 },
    { member_id: "../admin" },
    { ...inputs, password: "no" },
  ])
    assert.equal(Inputs.safeParse(value).success, false);
});
test("schema requires typed actions, target, checkpoints and bounded retry", () => {
  assert.ok(Step.safeParse(fill).success);
  for (const bad of [
    { ...fill, target: undefined },
    { ...fill, action: "eval" },
    { ...fill, expectedState: undefined },
    { ...fill, retry: { maxAttempts: 999, safeToRepeat: true } },
    { ...fill, password: "raw" },
  ])
    assert.equal(Step.safeParse(bad).success, false);
});
test("origin, route, query and secret binding restrictions", () => {
  const p = new Policy("http://localhost:5173", inputs);
  assert.equal(
    p.url("/members/1234567"),
    "http://localhost:5173/members/1234567",
  );
  for (const url of [
    "https://evil.example",
    "//evil.example",
    "http://localhost:5173/admin",
    "/members/7654321",
    "/members/1234567/accounts/new",
    "/login?next=/admin",
    "/members?q=7654321",
    "http://u:p@localhost:5173/login",
  ])
    assert.throws(() => p.url(url));
  assert.doesNotThrow(() => p.step(fill, "/login"));
  assert.throws(() => p.step(fill, "/members"));
  assert.throws(() =>
    p.step(
      {
        ...fill,
        target: {
          description: "fake",
          locators: [{ kind: "label", label: "Search" }],
        },
      },
      "/login",
    ),
  );
  assert.throws(() => p.step({ ...fill, risk: "irreversible" }, "/login"));
  assert.throws(() =>
    p.step(
      {
        ...fill,
        action: "click",
        target: {
          description: "Reveal",
          locators: [{ kind: "text", text: "Reveal" }],
        },
      },
      "/login",
    ),
  );
});
test("browser resource allowlist permits target auth/read RPCs and rejects exfiltration/writes", () => {
  const app = "http://localhost:5173",
    backend = "https://test.supabase.co";
  assert.ok(allowResource(app + "/src/App.tsx", app, backend));
  assert.ok(
    allowResource(backend + "/auth/v1/token?grant_type=password", app, backend),
  );
  assert.ok(allowResource(backend + "/rest/v1/rpc/get_member", app, backend));
  assert.equal(
    allowResource("https://evil.example/upload", app, backend),
    false,
  );
  assert.equal(
    allowResource(backend + "/rest/v1/rpc/open_sub_account", app, backend),
    false,
  );
  assert.equal(
    allowResource(backend + "/rest/v1/rpc/reveal_member_ssn", app, backend),
    false,
  );
  assert.equal(
    allowResource(backend + "/rest/v1/members", app, backend),
    false,
  );
});
test("credentials support table and placeholder template, never serialize", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rfcu-test-"));
  try {
    const file = path.join(dir, "credentials.md");
    await writeFile(
      file,
      "| `test_operator` | Test | Member Service Representative | X | `test-pass-unique` |",
    );
    const s = await Secrets.load(file);
    assert.equal(s.get("RFCU_STAFF_PASSWORD"), "test-pass-unique");
    assert.equal(
      s.redact("test_operator:test-pass-unique"),
      "[REDACTED]:[REDACTED]",
    );
    assert.throws(() => s.assertAbsent("test-pass-unique"));
    assert.equal(JSON.stringify(s), '"[SECRET_PROVIDER]"');
    await writeFile(
      file,
      "Username: test_operator\nPassword: test-pass-unique",
    );
    assert.equal(
      (await Secrets.load(file)).get("RFCU_STAFF_USERNAME"),
      "test_operator",
    );
    await writeFile(
      file,
      "Username: YOUR_LOCAL_USERNAME\nPassword: YOUR_LOCAL_PASSWORD",
    );
    await assert.rejects(() => Secrets.load(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("PII redaction and runtime parameterization", () => {
  assert.equal(
    parameterize("/members/1234567/accounts/1234567-S00", inputs),
    "/members/{{member_id}}/accounts/{{member_id}}-S00",
  );
  const redacted = redactPII("999-12-3456 test@example.com 410-555-1234");
  assert.equal(redacted, "[SSN] [EMAIL] [PHONE]");
});
test("business outcomes, transient conditions and hard failures are distinct", () => {
  assert.equal(classifyText("No members match")?.category, "business");
  assert.equal(classifyText("Member not found")?.code, "MEMBER_NOT_FOUND");
  assert.equal(classifyText("Permission denied")?.category, "hard");
  assert.equal(
    classifyText("The username or password is incorrect.")?.code,
    "AUTHENTICATION_REJECTED",
  );
  assert.equal(
    classifyText("Enter your password.")?.code,
    "LOGIN_VALIDATION_FAILED",
  );
  assert.equal(classifyText("The request timed out")?.category, "recoverable");
  assert.equal(classifyText("Current balance $12.34"), undefined);
});
test("authentication lifecycle explicitly fails on expired or redirected session", () => {
  const s = new SessionManager();
  assert.equal(s.observe("/login", false), "unauthenticated");
  s.authenticating();
  assert.equal(s.state, "authenticating");
  assert.equal(s.observe("/members", true), "authenticated");
  assert.throws(
    () => s.observe("/login", false),
    (e: unknown) =>
      e instanceof RuntimeCondition && e.code === "SESSION_EXPIRED",
  );
  assert.equal(s.state, "expired");
  const t = new SessionManager();
  assert.throws(() => t.observe("/session-expired", false));
  t.block();
  assert.equal(t.state, "blocked");
});
test("handoff ownership excludes automation and resume preserves identity", async () => {
  const events: unknown[] = [];
  const c = new ControlManager(async (t, d) => {
    events.push({ t, d });
  });
  const wait = c.pause({
    runId: "r",
    reason: "dialog",
    currentStep: "search",
    goal: "balance",
    contextId: "same-context",
    pageId: "same-page",
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.owner, "paused");
  assert.throws(() => c.assertAutomation());
  await assert.rejects(() => c.resume());
  await c.takeover();
  assert.equal(c.owner, "human");
  await assert.rejects(() => c.takeover());
  await c.resume();
  await wait;
  assert.equal(c.owner, "automation");
  assert.equal(c.intervention?.contextId, "same-context");
  assert.equal(c.intervention?.status, "resolved");
  assert.equal(events.length, 3);
});
test("money extraction preserves cents and rejects ambiguous text", () => {
  assert.deepEqual(parseMoney("$12,345.67"), {
    amount: "12345.67",
    currency: "USD",
  });
  assert.deepEqual(parseMoney("-$0.25"), { amount: "-0.25", currency: "USD" });
  for (const text of [
    "Current balance $1.00 Available $2.00",
    "NaN",
    "€1.00",
    "$1.2",
  ])
    assert.throws(() => parseMoney(text));
});
test("locator priority, label fallback, ambiguity and missing controls in a real DOM", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.RFCU_BROWSER_CHANNEL
      ? { channel: process.env.RFCU_BROWSER_CHANNEL }
      : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<label for="u">Username</label><input id="u"><button>Search</button>',
    );
    const target = {
      description: "username",
      locators: [
        { kind: "css" as const, selector: "#u" },
        {
          kind: "role" as const,
          role: "textbox" as const,
          name: "Username",
          exact: true,
        },
      ],
    };
    assert.equal(
      (await resolveTarget(page, target, inputs, 200)).strategy,
      "role",
    );
    assert.equal(
      (
        await resolveTarget(
          page,
          {
            description: "fallback",
            locators: [
              { kind: "role", role: "textbox", name: "Missing", exact: true },
              { kind: "label", label: "Username" },
            ],
          },
          inputs,
          200,
        )
      ).strategy,
      "label",
    );
    await page.setContent("<button>Search</button><button>Search</button>");
    await assert.rejects(
      () =>
        resolveTarget(
          page,
          {
            description: "duplicate",
            locators: [
              { kind: "role", role: "button", name: "Search", exact: true },
            ],
          },
          inputs,
          200,
        ),
      (e: unknown) =>
        e instanceof RuntimeCondition && e.code === "AMBIGUOUS_TARGET",
    );
    await assert.rejects(
      () =>
        resolveTarget(
          page,
          {
            description: "missing",
            locators: [{ kind: "label", label: "Missing" }],
          },
          inputs,
          200,
        ),
      (e: unknown) =>
        e instanceof RuntimeCondition && e.code === "CONTROL_NOT_FOUND",
    );
  } finally {
    await browser.close();
  }
});
test("replay source has no model provider dependency", async () => {
  const src = await readFile("automation/replay.ts", "utf8");
  assert.doesNotMatch(
    src,
    /from ['"].*(?:providers|discovery)|fetch\(|\.decide\(/,
  );
});
test("artifact schema rejects unsupported version and incomplete artifact", () => {
  assert.equal(Capability.safeParse({ schemaVersion: "2.0" }).success, false);
  assert.equal(
    Capability.safeParse({ schemaVersion: "1.0", steps: [fill] }).success,
    false,
  );
});
test("saved real capability is valid and rejects missing login/search/output contracts", async () => {
  const raw = JSON.parse(
    await readFile("artifacts/get-member-savings-balance.json", "utf8"),
  );
  assert.ok(Capability.safeParse(raw).success);
  assert.doesNotMatch(JSON.stringify(raw), /\b\d{7}\b/);
  assert.doesNotMatch(JSON.stringify(raw), /"source":"literal","value":"[^/]/);
  for (const mutate of [
    (a: any) => {
      a.steps = a.steps.filter(
        (s: any) => s.value?.key !== "RFCU_STAFF_PASSWORD",
      );
    },
    (a: any) => {
      a.steps = a.steps.filter((s: any) => s.value?.source !== "input");
    },
    (a: any) => {
      a.steps[1].id = a.steps[0].id;
    },
    (a: any) => {
      a.successCondition = [
        { kind: "authenticated" },
        { kind: "route", path: "/members" },
      ];
    },
  ]) {
    const changed = structuredClone(raw);
    mutate(changed);
    assert.equal(Capability.safeParse(changed).success, false);
  }
});
test("OpenAI transport contract validates decisions, redacts remote failures and uses store:false", async () => {
  const originalFetch = globalThis.fetch,
    originalKey = process.env.OPENAI_API_KEY,
    originalProvider = process.env.DISCOVERY_PROVIDER;
  process.env.OPENAI_API_KEY = "unit-test-placeholder";
  process.env.DISCOVERY_PROVIDER = "openai";
  try {
    assert.ok(providerFromEnv() instanceof OpenAIProvider);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const body = JSON.parse(init!.body as string);
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    kind: "act",
                    summary: "Fill Username",
                    stepJson: JSON.stringify(fill),
                  }),
                },
              ],
            },
          ],
        }),
      );
    };
    assert.equal(
      (await new OpenAIProvider().decide("sanitized observation")).kind,
      "act",
    );
    globalThis.fetch = async () =>
      new Response("secret remote diagnostics", { status: 401 });
    await assert.rejects(
      () => new OpenAIProvider().decide("x"),
      (e: unknown) =>
        e instanceof RuntimeCondition &&
        e.code === "MODEL_REQUEST_FAILED" &&
        !e.message.includes("secret remote"),
    );
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "{}" }] }],
        }),
      );
    await assert.rejects(
      () => new OpenAIProvider().decide("x"),
      (e: unknown) =>
        e instanceof RuntimeCondition && e.code === "MODEL_OUTPUT_INVALID",
    );
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(
      () => new OpenAIProvider().decide("x"),
      (e: unknown) =>
        e instanceof RuntimeCondition && e.code === "MODEL_NOT_CONFIGURED",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalProvider === undefined) delete process.env.DISCOVERY_PROVIDER;
    else process.env.DISCOVERY_PROVIDER = originalProvider;
  }
});
