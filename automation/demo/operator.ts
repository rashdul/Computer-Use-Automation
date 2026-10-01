/**
 * Demo stand-in for a human operator, used to produce the handoff evidence
 * without someone at the keyboard. It does what a person would do from an
 * operator console: wait for an intervention request, attach to the SAME live
 * browser session over CDP, complete the BSA/AML attestation by hand, and
 * signal resume. A real person would use the headed window instead.
 *
 *   tsx automation/demo/operator.ts --run <run-dir> [--cdp http://127.0.0.1:9333]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

async function main() {
  const { values } = parseArgs({ options: { run: { type: "string" }, cdp: { type: "string", default: "http://127.0.0.1:9333" } } });
  if (!values.run) throw new Error("--run <run-dir> is required");
  const requestFile = path.join(values.run, "intervention-1.json");

  const deadline = Date.now() + 180_000;
  while (!existsSync(requestFile)) {
    if (Date.now() > deadline) throw new Error("no intervention request within 180s");
    await new Promise((r) => setTimeout(r, 500));
  }
  const request = JSON.parse(readFileSync(requestFile, "utf8")) as { id: string; reason: string; url: string };
  console.error(`operator: received ${request.id}: ${request.reason}`);

  // Attach to the running session: same browser, same context, same page.
  const browser = await chromium.connectOverCDP(values.cdp!);
  const page = browser.contexts()[0]?.pages().find((p) => p.url() === request.url);
  if (!page) throw new Error(`live page ${request.url} not found in the attached session`);
  console.error(`operator: attached to live page ${page.url()}`);

  const dialog = page.getByRole("alertdialog", { name: "Annual BSA/AML attestation due" });
  await dialog.getByRole("button", { name: "Attest now" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Confirm your BSA/AML attestation" });
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "Submit attestation" }).click();
  await confirm.waitFor({ state: "hidden" });
  console.error("operator: attestation submitted; handing control back");

  writeFileSync(path.join(values.run, "RESUME"), "scripted operator (demo): completed BSA/AML attestation in the live session\n");
  // Exit without browser.close(): the session belongs to the automation run.
  process.exit(0);
}

main().catch((e) => {
  console.error(`operator error: ${(e as Error).message}`);
  process.exit(1);
});
