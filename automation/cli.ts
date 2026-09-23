import { parseArgs } from "node:util";
import { settings } from "./config.js";
const mode = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    goal: { type: "string" },
    "member-id": { type: "string" },
    "member-name": { type: "string" },
    capability: { type: "string" },
    "start-url": { type: "string" },
    headed: { type: "boolean" },
    "handoff-demo": { type: "boolean" },
    "evidence-group": { type: "string" },
  },
  strict: true,
});
const member_name = values["member-name"];
const member_id =
  values["member-id"] ??
  (!member_name ? values.goal?.match(/\b\d{7}\b/)?.[0] : undefined);
if (!["discovery", "replay"].includes(mode) || (!member_id && !member_name)) {
  console.error(
    'Usage: npm run discovery -- --goal "Return savings balance" --member-id 1030966 (or --member-name "Full Name") | npm run replay -- --capability CAPABILITY_ID --member-id 1000021 (or --member-name "Full Name")',
  );
  process.exit(2);
}
try {
  const base = `http://127.0.0.1:${settings.port}`;
  const response = await fetch(base + "/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-RFCU-Client": "operator",
    },
    body: JSON.stringify({
      mode,
      goal: values.goal,
      inputs: { member_id, member_name },
      capabilityId: values.capability,
      startUrl: values["start-url"],
      headed: values.headed,
      handoffDemo: values["handoff-demo"],
      evidenceGroup: values["evidence-group"],
    }),
  });
  const start = (await response.json()) as any;
  if (!response.ok) {
    console.error(JSON.stringify(start, null, 2));
    process.exit(2);
  }
  console.log(`Run ${start.runId}; operator console ${start.operatorUrl}`);
  let last = "";
  while (true) {
    const run = (await (
      await fetch(base + "/api/runs/" + start.runId)
    ).json()) as any;
    const status = `${run.currentStep}: ${run.owner} (${run.session ?? "starting"})`;
    if (status !== last) {
      console.log(status);
      last = status;
    }
    if (run.result) {
      console.log(JSON.stringify(run.result, null, 2));
      process.exitCode = run.result.status === "failure" ? 1 : 0;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch {
  console.error(
    "Operator server unavailable. Start npm run dev in another terminal.",
  );
  process.exitCode = 2;
}
