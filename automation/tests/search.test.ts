import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { discover } from "../discover.js";
import { Decision } from "../llm.js";
import { replay } from "../replay.js";
import { loadAppProfile } from "../safety.js";
import { Capability, type Locator, type Target } from "../schema.js";
import { WebSurface } from "../surface.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "cua-search-test-"));
const profile = loadAppProfile("youtube");
const firstLink: Locator = { by: "link", hrefPrefix: "/watch?", position: "first", within: { role: "heading" } };
let origin: string;
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, origin);
  const query = url.searchParams.get("search_query");
  const id = query === "chest exercises" ? "chest" : "news";
  const results = !query ? "" : query === "no matches" ? "<p>No results found</p>" : `
    <h2><a href="/@channel">Channel result</a></h2>
    <h2><a href="/shorts/short">Short video</a></h2>
    <h3 hidden><a href="/watch?v=hidden">Hidden result</a></h3>
    <h3><a href="/watch?v=${id}&amp;feature=search">${id} title changes with the query</a></h3>
    <h3><a href="${origin}/watch?v=second">Second video</a></h3>`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><title>Search fixture</title><form action="/results">
    <input role="combobox" aria-label="Search" name="search_query"><button>Search</button>
    </form><main>${results}</main>`);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile.policy.allowedOrigins.push(origin);
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

test("link selection preserves ambiguity unless first is explicit; href extraction resolves URLs", async () => {
  const surface = await WebSurface.launch(profile);
  try {
    await surface.goto(`${origin}/results?search_query=chest`);
    const target: Target = { description: "video", locators: [{ ...firstLink, position: undefined }] };
    assert.equal((await surface.resolve(target)).status, "ambiguous");
    target.locators = [firstLink];
    const found = await surface.resolve(target);
    assert.equal(found.status, "found");
    if (found.status !== "found") return;
    assert.equal(await surface.act("extract", found.locator, undefined, "href"), `${origin}/watch?v=news&feature=search`);
    assert.equal(await surface.act("extract", found.locator), "news title changes with the query");
    await surface.page.setContent('<base href="https://example.com/videos/"><a href="relative">Relative</a><a href="javascript:void(0)">Unsafe</a><span>No URL</span>');
    assert.equal(await surface.act("extract", surface.page.getByRole("link", { name: "Relative" }), undefined, "href"), "https://example.com/videos/relative");
    await assert.rejects(surface.act("extract", surface.page.getByRole("link", { name: "Unsafe" }), undefined, "href"), /HTTP\(S\)/);
    await assert.rejects(surface.act("extract", surface.page.getByText("No URL"), undefined, "href"), /non-empty link href/);
  } finally {
    await surface.close();
  }
});

test("discovery records first-link and href semantics, replay uses a different search result", async () => {
  const decisions = [
    { reason: "search", action: "fill", target: { by: "role", role: "combobox", name: "Search" }, value: "chest exercises" },
    { reason: "submit", action: "press", target: { by: "label", label: "Search" }, value: "Enter" },
    { reason: "first URL", action: "extract", target: firstLink, extract: "href", output: { name: "first_video_link", type: "text" } },
    {
      reason: "done", action: "done", success: [firstLink],
      capability: {
        id: "fixture.search.first-video-link", name: "First video", description: "First search video URL",
        inputs: [{ name: "search_query", description: "Search phrase", example: "chest exercises" }],
        outputs: [{ name: "first_video_link", type: "text", description: "Video URL" }],
      },
    },
  ].map((d) => Decision.parse(d));
  let index = 0;
  const result = await discover({
    profile, url: origin, goal: "Search chest exercises and return the first video URL", secrets: {},
    outDir: path.join(tmp, "discovery"), runId: "discovery", artifactsDir: path.join(tmp, "artifacts"),
    decide: async () => ({ decision: decisions[index++], model: "scripted-test" }),
  });
  assert.equal(result.status, "success", result.reason);
  assert.equal(result.outputs.first_video_link, `${origin}/watch?v=chest&feature=search`);
  assert.equal(result.capability!.steps[2].extract, "href");
  const replayed = await replay({
    profile, capability: result.capability!, inputs: { search_query: "Donald Trump" }, secrets: {},
    outDir: path.join(tmp, "replay"), runId: "replay",
  });
  assert.equal(replayed.status, "success", JSON.stringify(replayed.error));
  assert.equal(replayed.outputs!.first_video_link, `${origin}/watch?v=news&feature=search`);
});

test("repaired YouTube artifact returns a URL and classifies empty search results", async () => {
  const capability = Capability.parse(JSON.parse(readFileSync("automation/tests/fixtures/youtube-first-video-link.json", "utf8")));
  assert.equal(capability.app.id, profile.id);
  assert.deepEqual(capability.conditions, profile.conditions);
  for (const query of ["Donald Trump", "no matches"]) {
    const result = await replay({
      profile, capability, origin, inputs: { search_query: query }, secrets: {},
      outDir: path.join(tmp, query), runId: query,
    });
    if (query === "no matches") {
      assert.equal(result.status, "business_outcome");
      assert.equal(result.outcome?.id, "no_results");
    } else {
      assert.equal(result.status, "success", JSON.stringify(result.error));
      assert.equal(result.outputs!.first_video_link, `${origin}/watch?v=news&feature=search`);
    }
  }
});
