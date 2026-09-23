import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
const raw = await readFile("target-app/STAFF_CREDENTIALS.local.md", "utf8");
const sensitive: string[] = [];
const usernames: string[] = [];
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\| `([^`]+)` \|.*\| `([^`]+)` \|\s*$/);
  if (m) {
    sensitive.push(m[2]);
    usernames.push(m[1]);
  }
}
const simple = raw.match(/^Password:\s*(.+)$/m);
if (simple) sensitive.push(simple[1].trim());
const simpleUsername = raw.match(/^Username:\s*(.+)$/m);
if (simpleUsername) usernames.push(simpleUsername[1].trim());
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : Promise.resolve([path.join(dir, e.name)]),
      ),
    )
  ).flat();
}
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/);
if (tracked.some((f) => /STAFF_CREDENTIALS\.local\.md$/.test(f)))
  throw Error("Credential file is tracked");
execFileSync("git", ["check-ignore", "target-app/STAFF_CREDENTIALS.local.md"]);
const files = [
  ...new Set([
    ...tracked,
    ...(await walk("automation")),
    ...(await walk("artifacts")),
    ...(await walk("evidence")),
    ...(await walk("docs")),
    "README.md",
    "REPORT.md",
    "automation.env.example",
    "target-app/STAFF_CREDENTIALS.example.md",
  ]),
];
let scanned = 0;
const violations: string[] = [];
for (const file of files) {
  if (!file || /\.pdf$|\.png$/.test(file)) continue;
  const content = await readFile(file, "utf8").catch(() => null);
  if (content === null) continue;
  scanned++;
  if (sensitive.some((secret) => content.includes(secret)))
    violations.push(file);
  if (
    /^(artifacts|evidence)[/\\]/.test(file) &&
    usernames.some((username) => content.includes(username))
  )
    violations.push(file);
}
if (violations.length) {
  console.error("Secret audit FAILED in files:", violations);
  process.exitCode = 1;
} else
  console.log(
    `Secret audit passed: ${scanned} text files; local staff passwords absent; usernames absent from artifacts/evidence; credential file ignored and untracked. PNGs require visual mask verification.`,
  );
