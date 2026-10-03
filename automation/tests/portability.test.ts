import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { compile, discover, type RecordedStep } from "../discover.js";
import { Decision } from "../llm.js";
import { assertCapabilityContract, assertPortableTarget } from "../portability.js";
import { replay } from "../replay.js";
import { loadAppProfile } from "../safety.js";
import { Capability, type Locator } from "../schema.js";
import { WebSurface } from "../surface.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "cua-portability-"));
const profile = loadAppProfile("public-web");
const articles = [
  { query: "donald trump", slug: "person", title: "Donald Trump" },
  { query: "Saudi Arabia", slug: "kingdom", title: "Saudi Arabia" },
  { query: "Iraq", slug: "republic", title: "Iraq" },
  { query: "AI", slug: "intelligence", title: "Artificial intelligence" },
  { query: "Search", slug: "search-topic", title: "Search" },
];
const intro = (title: string) => `${title} has its own changing opening paragraph. This is article prose rather than navigation, a caption or an infobox.`;
let origin: string;
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture.invalid");
  if (url.pathname === "/search") {
    const article = articles.find((a) => a.query.toLowerCase() === url.searchParams.get("q")?.toLowerCase());
    res.writeHead(302, { Location: article ? `/doc/${article.slug}` : "/no-results" });
    res.end();
    return;
  }
  const article = articles.find((a) => url.pathname === `/doc/${a.slug}`);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><title>${article?.title ?? "Library"}</title>
    <form role="search" action="/search"><label>Search<input type="search" name="q"></label><button>Search</button></form>
    <main>${article ? `<h1>${article.title}</h1><nav><p>Navigation noise</p><a href="${url.pathname}">Article</a></nav>
      <table><tr><td><p>Infobox noise</p></td></tr></table><aside><p>Sidebar noise</p></aside>
      <figure><figcaption><p>Caption noise</p></figcaption></figure><p hidden>Hidden noise</p><p> </p>
      <section><p>${intro(article.title)}</p><p>Second prose paragraph for ${article.title}.</p></section>`
      : url.pathname === "/no-results" ? "<h1>No matches</h1><p>No results found</p>" : "<h1>Library search</h1>"}</main>`);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile.policy.allowedOrigins.push(origin);
  profile.conditions.push({ id: "no_results", kind: "business", when: { by: "text", text: "No results found" }, message: "No articles match.", maxRecoveries: 0 });
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

test("literal paragraph discovery compiles structure and replays different text, titles, aliases and input lengths", async () => {
  const done = {
    reason: "done", action: "done", success: [{ by: "text", text: intro("Donald Trump") }],
    capability: {
      id: "fixture.portable.paragraph", name: "Opening paragraph", description: "First article paragraph",
      inputs: [{ name: "query", description: "Search phrase", example: "donald trump" }],
      outputs: [{ name: "paragraph", type: "text", description: "Opening paragraph" }],
    },
  };
  const decisions = [
    { reason: "search", action: "fill", target: { by: "label", label: "Search" }, value: "donald trump" },
    { reason: "submit", action: "click", target: { by: "role", role: "button", name: "Search" } },
    { reason: "read", action: "extract", target: { by: "text", text: intro("Donald Trump") }, output: { name: "paragraph", type: "text" } },
    done,
  ].map((d) => Decision.parse(d));
  let turn = 0;
  const result = await discover({
    profile, url: origin, goal: "Search donald trump and return the first paragraph of the first article", secrets: {},
    artifactsDir: path.join(tmp, "artifacts"), outDir: path.join(tmp, "discovery"), runId: "discovery",
    decide: async () => ({ decision: decisions[turn++], model: "test" }),
  });
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.capability!.steps[2].target.locators, [{ by: "content", kind: "paragraph", position: "first", within: { role: "main" } }]);
  assert.doesNotMatch(JSON.stringify(result.capability), /Donald Trump|opening paragraph\. This|\/doc\/person/);
  assert.match(readFileSync(path.join(tmp, "discovery", "events.jsonl"), "utf8"), /target.generalized/);
  for (const article of articles.slice(1)) {
    const replayed = await replay({ profile, capability: result.capability!, inputs: { query: article.query }, secrets: {}, outDir: path.join(tmp, article.slug), runId: article.slug });
    assert.equal(replayed.status, "success", JSON.stringify(replayed.error));
    assert.equal(replayed.outputs!.paragraph, intro(article.title));
  }
  const empty = await replay({ profile, capability: result.capability!, inputs: { query: "unknown phrase" }, secrets: {}, outDir: path.join(tmp, "empty"), runId: "empty" });
  assert.equal(empty.status, "business_outcome");
  assert.equal(empty.outcome?.id, "no_results");
});

test("paragraph positions exclude chrome and preserve missing or ambiguous regions", async () => {
  const surface = await WebSurface.launch(profile);
  try {
    await surface.goto(`${origin}/doc/person`);
    const target = (position?: "first" | "last" | number) => ({ description: "prose", locators: [{ by: "content", kind: "paragraph", within: { role: "main" }, ...(position !== undefined && { position }) } as Locator] });
    assert.equal((await surface.resolve(target())).status, "ambiguous");
    for (const [position, expected] of [["first", intro("Donald Trump")], ["last", "Second prose paragraph for Donald Trump."], [2, "Second prose paragraph for Donald Trump."]] as const) {
      const found = await surface.resolve(target(position));
      assert.equal(found.status, "found");
      if (found.status === "found") assert.equal(await surface.act("extract", found.locator), expected);
    }
    assert.equal((await surface.resolve(target(3))).status, "missing");
    assert.throws(() => assertPortableTarget(target("first"), "read a paragraph", "extract"), /not requested/);
    assert.throws(() => assertPortableTarget(target("first"), "open the first article and return a paragraph", "extract"), /not requested/);
    await surface.page.setContent("<main><p>One</p></main><main><p>Two</p></main>");
    assert.equal((await surface.resolve(target("first"))).status, "ambiguous");
    await surface.page.setContent("<main><p hidden>Hidden</p><p> </p></main>");
    assert.equal((await surface.resolve(target("first"))).status, "missing");
    await surface.page.setContent('<main><p style="height:10px"><span hidden>Hidden-only paragraph</span></p><p aria-hidden="true">Decoration</p><div role="paragraph">Visible prose</div></main>');
    const visible = await surface.resolve(target("first"));
    assert.equal(visible.status, "found");
    if (visible.status === "found") assert.equal(await surface.act("extract", visible.locator), "Visible prose");
  } finally { await surface.close(); }
});

test("cell recording uses an input key column, survives reordered columns and refuses duplicate rows or tables", async () => {
  const surface = await WebSurface.launch(profile);
  try {
    await surface.goto(origin);
    await surface.page.setContent('<main><table><tr><th>Key</th><th>Balance</th></tr><tr><td>K1</td><td>42</td></tr><tr><td>K2</td><td>77</td></tr></table></main>');
    const original: Locator = { by: "cell", row: "K1 42", column: "Balance" };
    const found = await surface.resolve({ description: "copied row", locators: [original] });
    assert.equal(found.status, "found");
    if (found.status !== "found") return;
    const target = await surface.reusableTarget(original, found.locator, "extract", "Find K1 and return its balance", ["K1"]);
    assert.deepEqual(target.locators, [{ by: "cell", column: "Balance", rowKey: { column: "Key", value: "K1" } }]);
    await surface.page.setContent('<main><table><tr><th>Status</th><th>Balance</th><th>Key</th></tr><tr><td>Active</td><td>99</td><td>K1</td></tr><tr><td>Active</td><td>K1</td><td>K2</td></tr></table></main>');
    const replayed = await surface.resolve(target);
    assert.equal(replayed.status, "found");
    if (replayed.status === "found") assert.equal(await surface.act("extract", replayed.locator), "99");
    await surface.page.setContent('<table><tr><th>Key</th><th>Balance</th></tr><tr><td>K1</td><td>99</td></tr><tr><td>K1</td><td>20</td></tr></table>');
    assert.equal((await surface.resolve(target)).status, "ambiguous");
    await surface.page.setContent('<table><tr><th>Key</th><th>Balance</th></tr><tr><td>K1</td><td>99</td></tr></table><table><tr><th>Key</th><th>Balance</th></tr><tr><td>K1</td><td>20</td></tr></table>');
    assert.equal((await surface.resolve(target)).status, "ambiguous");
  } finally { await surface.close(); }
});

test("fixed controls keep their labels when the input equals Search, and short inputs compile", async () => {
  for (const example of ["Search", "AI"]) {
    const result = await discover({
      profile, url: origin, goal: `Search ${example} and return the main article heading`, secrets: {},
      artifactsDir: path.join(tmp, "artifacts"), outDir: path.join(tmp, `collision-${example}`), runId: example,
      decide: (() => {
        const article = articles.find((a) => a.query === example)!;
        const decisions = [
          { reason: "type", action: "fill", target: { by: "label", label: "Search" }, value: example },
          { reason: "submit", action: "click", target: { by: "role", role: "button", name: "Search" } },
          { reason: "read", action: "extract", target: { by: "role", role: "heading", name: article.title }, output: { name: "title", type: "text" } },
          { reason: "done", action: "done", success: [{ by: "role", role: "heading", name: article.title }], capability: { id: `fixture.heading.${example.toLowerCase()}`, name: "Heading", description: "Heading", inputs: [{ name: "query", description: "Search phrase", example }], outputs: [{ name: "title", type: "text", description: "Title" }] } },
        ].map((d) => Decision.parse(d));
        let turn = 0;
        return async () => ({ decision: decisions[turn++], model: "test" });
      })(),
    });
    assert.equal(result.status, "success", result.reason);
    const cap = result.capability!;
    assert.equal(cap.steps[0].target.locators[0].by, "label");
    assert.deepEqual(cap.steps[0].target.locators[0], { by: "label", label: "Search" });
    assert.equal(cap.steps[0].value, "{{query}}");
    assert.deepEqual(cap.steps[1].target.locators[0], { by: "role", role: "button", name: "Search" });
    const replayed = await replay({ profile, capability: cap, inputs: { query: "Saudi Arabia" }, secrets: {}, outDir: path.join(tmp, `heading-${example}`), runId: `heading-${example}` });
    assert.equal(replayed.status, "success", JSON.stringify(replayed.error));
    assert.equal(replayed.outputs!.title, "Saudi Arabia");
  }
});

test("malformed contracts and unsafe fallbacks fail before a browser is launched", async () => {
  const valid = Capability.parse(JSON.parse(readFileSync("automation/tests/fixtures/youtube-first-video-link.json", "utf8")));
  const mutations: ((cap: Capability) => void)[] = [
    (cap) => { cap.steps[2].output = "missing"; },
    (cap) => { cap.steps[0].value = "{{unknown}}"; },
    (cap) => { cap.inputs[0].pattern = "["; },
    (cap) => { cap.steps[1].id = cap.steps[0].id; },
    (cap) => { cap.steps[2].extract = "href"; cap.outputs[0].type = "number"; },
    (cap) => { cap.steps[0].value = undefined; },
    (cap) => { cap.steps[2].target.locators.push({ by: "text", text: "Copied article output" }); },
    (cap) => { cap.steps[1].expect.push({ kind: "visible", target: { description: "Invalid regex", locators: [{ by: "role", role: "heading", namePattern: "[" }] } }); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const cap = structuredClone(valid);
    mutate(cap);
    const result = await replay({ profile, capability: cap, inputs: { search_query: "Iraq" }, secrets: {}, outDir: path.join(tmp, `invalid-${index}`), runId: `invalid-${index}` });
    assert.equal(result.error?.code, "INVALID_ARTIFACT");
    assert.equal(result.error?.url, "");
  }
  assert.doesNotThrow(() => assertCapabilityContract(valid));
  assert.throws(() => assertPortableTarget({ description: "bad fallback", locators: [{ by: "role", role: "link", name: "Article" }, { by: "text", text: "Copied article output" }] }, "get article URL", "extract"), /literal text/);
});

test("compiler cannot accept a copied output selector even when discovery is bypassed", async () => {
  const text = intro("Donald Trump");
  const recorded: RecordedStep[] = [
    { action: "fill", target: { description: "Search", locators: [{ by: "label", label: "Search" }] }, value: "donald trump", urlBefore: origin, urlAfter: origin },
    { action: "extract", target: { description: "copied content", locators: [{ by: "text", text }] }, output: { name: "paragraph", type: "text" }, urlBefore: origin, urlAfter: origin },
  ];
  await assert.rejects(compile(
    { profile, url: origin, goal: "Search donald trump and return the first paragraph", secrets: {}, artifactsDir: tmp, runId: "bypass" },
    Decision.parse({ reason: "done", action: "done", capability: { id: "fixture.bypass", name: "Bad", description: "Bad", inputs: [{ name: "query", description: "Query", example: "donald trump" }], outputs: [{ name: "paragraph", type: "text", description: "Paragraph" }] } }),
    recorded, new Map([["paragraph", text]]), { resolve: async () => { throw new Error("unused"); } },
    { llmCalls: 1, model: "test", finalUrl: origin, humanIntervened: false },
  ), /literal text|output data/);
});

test("masked values in names match real ones, and total rows with merged cells map columns by colSpan", async () => {
  const surface = await WebSurface.launch(profile);
  try {
    await surface.goto(origin);
    await surface.page.setContent(`<main><table>
      <thead><tr><th scope="col">Account</th><th scope="col">Product</th><th scope="col">Current balance</th><th scope="col">Available</th></tr></thead>
      <tbody><tr><td>1001-S00</td><td>Share</td><td>$1,000.00</td><td>$900.00</td></tr></tbody>
      <tfoot><tr><td colspan="2">Total deposits</td><td>$2,915.86</td><td>$2,800.00</td></tr></tfoot></table></main>`);
    // The model sees "Total deposits [money] [money]"; it must find the real row for any amount.
    const total: Locator = { by: "cell", row: "Total deposits [money] [money]", column: "Current balance" };
    const found = await surface.resolve({ description: "total", locators: [total] });
    assert.equal(found.status, "found");
    if (found.status === "found") assert.equal(await surface.act("extract", found.locator), "$2,915.86");
    // A column inside the merged cell has no single value.
    assert.equal((await surface.resolve({ description: "merged", locators: [{ by: "cell", row: "Total deposits [money] [money]", column: "Product" }] })).status, "missing");
  } finally {
    await surface.close();
  }
});

test("an input pattern that only spells out the example is rejected at compile time", async () => {
  const recorded: RecordedStep[] = [{ action: "fill", target: { description: "Search", locators: [{ by: "label", label: "Search" }] }, value: "Iraq", urlBefore: origin, urlAfter: origin }];
  const done = (pattern: string) =>
    Decision.parse({ reason: "done", action: "done", capability: { id: "fixture.pattern", name: "P", description: "P", inputs: [{ name: "q", description: "Topic", example: "Iraq", pattern }], outputs: [] } });
  const opts = { profile, url: origin, goal: "Search Iraq", secrets: {}, artifactsDir: path.join(tmp, "pattern"), runId: "pattern" };
  const meta = { llmCalls: 1, model: "test", finalUrl: origin, humanIntervened: false };
  const surface = { resolve: async () => { throw new Error("unused"); } };
  await assert.rejects(compile(opts, done("^Iraq$"), recorded, new Map(), surface, meta), /only accepts the example/);
  const ok = await compile(opts, done("^[\p{L} ]+$"), recorded, new Map(), surface, meta);
  assert.equal(ok.inputs[0].pattern, "^[\p{L} ]+$");
});
