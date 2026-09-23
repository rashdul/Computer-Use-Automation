import "../config.js";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { settings } from "../config.js";

// This is explicitly a simulated operator, exercising the real console/browser seam.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1200 },
  extraHTTPHeaders: { "X-RFCU-Operator": "automated-test" },
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.name));
try {
  await page.goto(`http://localhost:${settings.port}`);
  await page.getByLabel("Execution mode").selectOption("replay");
  await page.getByLabel("Member number", { exact: true }).fill("1000021");
  await page.getByLabel("Simulate operator interruption").check();
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await page
    .getByRole("button", { name: "Take control", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.locator("#frame.human").waitFor();
  // The demonstration fixture has a fixed 1440x900 remote viewport. This point is
  // the center of its visible Resolve button, projected into the responsive image.
  const frame = page.locator("#frame");
  await frame.scrollIntoViewIfNeeded();
  const box = await frame.boundingBox();
  assert.ok(box);
  await frame.click({
    position: { x: (640 / 1440) * box.width, y: (485 / 900) * box.height },
  });
  await page.waitForTimeout(500);
  await page
    .getByRole("button", { name: "Resume automation", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .getElementById("result")
        ?.textContent?.includes('"status": "success"'),
    undefined,
    { timeout: 30000 },
  );
  const result = JSON.parse(await page.locator("#result").innerText());
  assert.equal(result.humanInterventions, 1);
  assert.equal(errors.length, 0);
  const response = await page.request.get(
    `http://localhost:${settings.port}/api/runs/${result.runId}`,
  );
  const run = await response.json();
  assert.equal(run.modelCalls, 0);
  assert.ok(
    run.events.some(
      (e: any) =>
        e.type === "operator_test_provenance" && e.simulatedOperator === true,
    ),
  );
  assert.ok(run.events.some((e: any) => e.type === "human_action"));
  await writeFile(
    "evidence/operator-ui-verification.json",
    JSON.stringify(
      {
        runId: run.runId,
        status: "passed",
        operator: "automated-ui-test",
        sameSession: true,
        modelCalls: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS operator UI start, takeover, remote click, resume, successful result; simulated operator; run " +
      run.runId,
  );
} finally {
  await browser.close();
}
