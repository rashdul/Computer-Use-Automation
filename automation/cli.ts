/**
 * Usage:
 *   tsx automation/cli.ts discover --url <url> --goal "<goal>" [--llm claude|codex|openai] [--out dir] [--headed] [--operator] [--cdp-port 9333]
 *   tsx automation/cli.ts replay --artifact <file> --input name=value ... [--origin url] [--out dir] [--headed] [--operator] [--cdp-port 9333]
 *
 * The result JSON goes to stdout (the caller channel, with real outputs); the
 * progress log goes to stderr; evidence goes to --out (default runs/<run-id>).
 * Exit codes: 0 success, 2 business outcome, 3 needs human, 1 failed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { discover } from "./discover.js";
import { pickDecider } from "./llm.js";
import { replay } from "./replay.js";
import { RunLog } from "./runlog.js";
import { findAppProfile, loadAppProfile, loadDotEnv, loadSecrets } from "./safety.js";
import { Capability } from "./schema.js";

const EXIT = { success: 0, business_outcome: 2, needs_human: 3, failed: 1 } as const;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: "string" },
      goal: { type: "string" },
      artifact: { type: "string" },
      input: { type: "string", multiple: true, default: [] },
      origin: { type: "string" },
      app: { type: "string" },
      out: { type: "string" },
      headed: { type: "boolean", default: false },
      operator: { type: "boolean", default: false },
      "cdp-port": { type: "string" },
      "max-steps": { type: "string" },
      llm: { type: "string" },
    },
  });
  loadDotEnv();
  // A run only ever holds the secrets its app profile declares (none for public sites).
  const secretsFor = loadSecrets;
  const cdpPort = values["cdp-port"] ? Number(values["cdp-port"]) : undefined;

  if (command === "discover") {
    if (!values.url || !values.goal) throw new Error("discover needs --url and --goal");
    if (!URL.canParse(values.url)) throw new Error(`--url must be a full URL such as https://www.example.com, got "${values.url}"`);
    // The app profile is chosen by the URL's origin unless --app names one.
    const profile = values.app ? loadAppProfile(values.app) : findAppProfile({ url: values.url });
    const secrets = secretsFor(profile);
    const decide = pickDecider(values.llm); // --llm, else CUA_LLM, else claude
    const runId = RunLog.id("discovery");
    const result = await discover({
      profile,
      url: values.url,
      goal: values.goal,
      secrets,
      decide,
      runId,
      outDir: values.out ?? path.join("runs", runId),
      artifactsDir: "artifacts",
      headed: values.headed,
      operator: values.operator,
      cdpPort,
      maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
    });
    const { capability: _omit, ...summary } = result;
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = result.status === "success" ? 0 : result.status === "needs_human" ? 3 : 1;
    return;
  }

  if (command === "replay") {
    if (!values.artifact) throw new Error("replay needs --artifact");
    const capability = Capability.parse(JSON.parse(readFileSync(values.artifact, "utf8")));
    const profile = values.app ? loadAppProfile(values.app) : findAppProfile({ id: capability.app.id });
    const secrets = secretsFor(profile);
    const inputs = Object.fromEntries(
      values.input!.map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw new Error(`--input must be name=value, got "${pair}"`);
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    );
    const runId = RunLog.id("replay");
    const result = await replay({
      profile,
      capability,
      inputs,
      secrets,
      runId,
      outDir: values.out ?? path.join("runs", runId),
      origin: values.origin,
      headed: values.headed,
      operator: values.operator,
      cdpPort,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = EXIT[result.status];
    return;
  }

  throw new Error(`unknown command "${command ?? ""}"; use discover or replay`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
