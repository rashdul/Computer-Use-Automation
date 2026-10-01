import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseOutput, pathWithQuery, urlMatches, validateInputs } from "../replay.js";
import {
  assertActionAllowed,
  classifyRisk,
  derivedIds,
  isAllowedUrl,
  loadAppProfile,
  loadDotEnv,
  loadSecrets,
  modelEnv,
  PolicyViolation,
  Redactor,
  resolveTemplate,
} from "../safety.js";
import { Capability } from "../schema.js";
import { counterPattern } from "../surface.js";
import { mixesInputWithContent, wildcardInputForms } from "../discover.js";

const rfcu = loadAppProfile("rfcu");

test("redactor masks secrets and regulated data in text and JSON", () => {
  const r = new Redactor({ username: "aokafor", password: "s3cret-Pass!" });
  const out = r.text("user aokafor pw s3cret-Pass! ssn 912-21-4298 tel (410) 555-0147 mail a.b@example.net bal $23,693.68 dob 04/16/1965");
  for (const leaked of ["aokafor", "s3cret-Pass!", "912-21-4298", "555-0147", "a.b@example.net", "23,693.68", "04/16/1965"]) {
    assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
  }
  assert.match(out, /\[secret\].*\[secret\].*\[ssn\].*\[phone\].*\[email\].*\[money\].*\[date\]/);
  assert.deepEqual(r.json({ a: ["pw s3cret-Pass!"], n: 5 }), { a: ["pw [secret]"], n: 5 });
});

test("member numbers and account suffixes are not mistaken for sensitive values", () => {
  assert.equal(new Redactor().text("member 1030966 account 1030966-S01"), "member 1030966 account 1030966-S01");
});

test("origin allow-list", () => {
  assert.ok(isAllowedUrl(rfcu, "http://localhost:5173/members/1"));
  assert.ok(!isAllowedUrl(rfcu, "https://evil.example.com/login"));
  assert.ok(!isAllowedUrl(rfcu, "http://localhost:9999/"));
  assert.ok(!isAllowedUrl(rfcu, "not a url"));
});

test("risky and disallowed actions are blocked; read-only navigation is allowed", () => {
  assert.equal(classifyRisk(rfcu, "click", { by: "role", role: "link", name: "Regular Share Savings" }), "navigate");
  assert.equal(classifyRisk(rfcu, "fill", { by: "label", label: "Search" }), "input");
  assert.equal(classifyRisk(rfcu, "extract", { by: "field", field: "Current balance" }), "read");
  for (const name of ["Open sub-account", "Reveal", "Submit attestation", "Sign out", "Add note"]) {
    assert.throws(() => assertActionAllowed(rfcu, "click", { by: "role", role: "button", name }), PolicyViolation, name);
  }
  assert.throws(() => assertActionAllowed({ ...rfcu, policy: { ...rfcu.policy, allowedActions: ["click"] } }, "fill", { by: "label", label: "Search" }), PolicyViolation);
});

test("templates resolve inputs and secrets, and fail loudly on unknown names", () => {
  assert.equal(resolveTemplate("/members/{{member_id}}", { member_id: "1030966" }), "/members/1030966");
  assert.equal(resolveTemplate("{{secret.password}}", {}, { password: "x" }), "x");
  assert.throws(() => resolveTemplate("{{secret.token}}", {}, {}), /No value/);
});

test("URL checkpoints compare decoded paths, so inputs with spaces parameterize", () => {
  assert.equal(pathWithQuery("https://x.test/members?q=Amber+Adams"), "/members?q=Amber Adams");
  assert.equal(pathWithQuery("https://x.test/members?q=Amber%20Adams"), "/members?q=Amber Adams");
  assert.equal(pathWithQuery("https://x.test/members/1030966/accounts"), "/members/1030966/accounts");
});

test("URL checkpoint wildcards match one segment; inputs match literally", () => {
  assert.ok(urlMatches("/members/*/accounts", "https://x.test/members/1080566/accounts", {}));
  assert.ok(!urlMatches("/members/*/accounts", "https://x.test/members/1/2/accounts", {}));
  assert.ok(urlMatches("/members?q={{name}}", "https://x.test/members?q=Amber+Adams", { name: "Amber Adams" }));
  assert.ok(!urlMatches("/members?q={{name}}", "https://x.test/members?q=Amber+Adams", { name: "Amber.Adams" }), "input dots are literal, not regex");
});

test("record IDs read off the screen are flagged; IDs given in the goal are not", () => {
  assert.deepEqual(derivedIds('{"name":"1080566"}', "find Amber Adams"), ["1080566"]);
  assert.deepEqual(derivedIds('{"name":"1030966"}', "find member 1030966"), []);
  assert.deepEqual(derivedIds('{"name":"S01 24-Month"}', "anything"), []);
});

test("names ending in a short counter get an any-count pattern; record IDs do not", () => {
  const p = counterPattern("Accounts 3")!;
  assert.ok(new RegExp(p).test("Accounts 11") && new RegExp(p).test("Accounts 3"));
  assert.ok(!new RegExp(p).test("All accounts") && !new RegExp(p).test("Accounts"));
  assert.equal(counterPattern("1155159"), null);
  assert.equal(counterPattern("Member 1155159"), null, "5+ digits is an ID, not a count");
  assert.equal(counterPattern("Search"), null);
  assert.ok(new RegExp(counterPattern("Notes (beta) 2")!).test("Notes (beta) 7"), "special characters are escaped");
});

test("typed output parsing", () => {
  assert.equal(parseOutput("money", "$23,693.68"), 23693.68);
  assert.equal(parseOutput("money", "($5.00)"), -5);
  assert.equal(parseOutput("money", "-$12.10"), -12.1);
  assert.equal(parseOutput("money", "Current balance"), null);
  assert.equal(parseOutput("money", "—"), null);
  assert.equal(parseOutput("number", "1,204"), 1204);
  assert.equal(parseOutput("text", "  Active "), "Active");
});

test("the committed artifact validates, respects policy, and holds no literal inputs", () => {
  const cap = Capability.parse(JSON.parse(readFileSync("artifacts/rfcu.member.savings-balance.v1.json", "utf8")));
  for (const step of cap.steps) for (const l of step.target.locators) assertActionAllowed(rfcu, step.action, l);
  assert.ok(!JSON.stringify(cap.steps).includes("1030966"), "discovery member number must be parameterized");
  assert.deepEqual(cap.secrets.sort(), ["password", "username"]);
  const input = cap.inputs[0].name;
  assert.equal(validateInputs(cap, { [input]: "1057101" }), null);
  assert.match(validateInputs(cap, {}) ?? "", /missing input/);
  assert.match(validateInputs(cap, { [input]: "1057101", extra: "1" }) ?? "", /unknown input/);
});

test("secrets come from the environment variables the app profile names", () => {
  assert.deepEqual(loadSecrets(rfcu, { CUA_USERNAME: "u1", CUA_PASSWORD: "p1" }), { username: "u1", password: "p1" });
  assert.throws(() => loadSecrets(rfcu, { CUA_USERNAME: "u1" }), /needs CUA_PASSWORD: set it in your environment or in \.env/);
  assert.deepEqual(loadSecrets(loadAppProfile("public-web"), {}), {}, "public sites need no secrets");
});

test(".env fills only variables the shell has not already set", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cua-env-"));
  const file = path.join(dir, ".env");
  writeFileSync(file, "CUA_USERNAME=from-file\nCUA_PASSWORD='p$w%rd'\n");
  const env: NodeJS.ProcessEnv = { CUA_USERNAME: "from-shell" };
  loadDotEnv(file, env);
  assert.equal(env.CUA_USERNAME, "from-shell");
  assert.equal(env.CUA_PASSWORD, "p$w%rd");
  loadDotEnv(path.join(dir, "missing.env"), env); // no file: no error
  rmSync(dir, { recursive: true, force: true });
});

test("model subprocesses never receive secret variables", () => {
  const env = modelEnv({ PATH: "x", CUA_PASSWORD: "p", CUA_USERNAME: "u", DATABASE_PASSWORD: "d", CUA_MODEL: "m" });
  assert.deepEqual(env, { PATH: "x", CUA_MODEL: "m" });
});

test("inputs that a site rewrites in the URL become wildcards; placeholders are untouched", () => {
  const ex = [{ example: "Artificial intelligence" }];
  assert.equal(wildcardInputForms("/wiki/Artificial_intelligence", ex), "/wiki/*");
  assert.equal(wildcardInputForms("/search?q=artificial-intelligence&x=1", ex), "/search?q=*&x=1");
  assert.equal(wildcardInputForms("/wiki/{{search_term}}", ex), "/wiki/{{search_term}}");
  assert.equal(wildcardInputForms("/members/{{member_name}}", [{ example: "member" }]), "/members/{{member_name}}", "never rewrites inside a placeholder");
  assert.ok(urlMatches("/wiki/*", "https://en.wikipedia.org/wiki/Iraq", {}));
});

test("controls named after a typed value plus page text are flagged; plain matches are not", () => {
  assert.equal(mixesInputWithContent("Artificial intelligence Intelligence in machines", ["Artificial intelligence"]), "Artificial intelligence");
  assert.equal(mixesInputWithContent("Arnold, Omar V. 1155159 · Timonium, MD just now", ["1155159"]), "1155159");
  assert.equal(mixesInputWithContent("1030966", ["1030966"]), null);
  assert.equal(mixesInputWithContent("Search", ["Artificial intelligence"]), null);
  assert.equal(mixesInputWithContent("Open 1030966", ["1030966"]), null, "a short verb is not page content");
});
