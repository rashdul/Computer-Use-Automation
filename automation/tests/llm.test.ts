import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { callOpenAI, dropNulls, pickDecider, STRICT_DECISION_SCHEMA, type DecisionRequest, Decision } from "../llm.js";

const REQ: DecisionRequest = { goal: "g", startUrl: "http://x.test", url: "http://x.test", title: "t", tree: "- button \"Go\"", history: [], lastResult: "(start)", secrets: [] };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
});

test("provider selection", () => {
  for (const name of ["claude", "codex", "openai"]) assert.equal(typeof pickDecider(name), "function");
  assert.throws(() => pickDecider("gemini"), /choose one of: claude, codex, openai/);
});

test("strict schema lists every property as required and makes optional ones nullable", () => {
  const walk = (s: any): void => {
    if (s.anyOf) return s.anyOf.forEach(walk);
    if (s.type === "object" && s.properties) {
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      assert.equal(s.additionalProperties, false);
      Object.values(s.properties).forEach(walk);
    }
    if (s.type === "array") walk(s.items);
  };
  walk(STRICT_DECISION_SCHEMA);
  assert.deepEqual((STRICT_DECISION_SCHEMA as any).properties.target.anyOf[1], { type: "null" });
});

test("a strict-mode reply (nulls for unused fields) validates as a normal decision", () => {
  const reply = {
    reason: "click",
    action: "click",
    target: { by: "role", role: "button", name: "Go", label: null, text: null, row: null, column: null, field: null, within: null },
    value: null,
    output: null,
    capability: null,
    success: null,
  };
  const d = Decision.parse(dropNulls(reply));
  assert.deepEqual(d.target, { by: "role", role: "button", name: "Go" });
});

test("OpenAI transport: strict json_schema request, nothing stored, reply parsed", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let sent: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    const text = JSON.stringify({ reason: "go", action: "click", target: { by: "role", role: "button", name: "Go" }, value: null, output: null, capability: null, success: null });
    return new Response(JSON.stringify({ model: "gpt-test", output: [{ content: [{ type: "output_text", text }] }] }), { status: 200 });
  }) as typeof fetch;
  const { decision, model } = await callOpenAI(REQ);
  assert.equal(decision.action, "click");
  assert.equal(model, "openai:gpt-test");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.deepEqual(sent.text.format.schema, STRICT_DECISION_SCHEMA);
});

test("OpenAI transport fails clearly without a key or on an HTTP error", async () => {
  await assert.rejects(callOpenAI(REQ), /set OPENAI_API_KEY/);
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("bad model", { status: 404 })) as typeof fetch;
  await assert.rejects(callOpenAI(REQ), /HTTP 404/);
});
