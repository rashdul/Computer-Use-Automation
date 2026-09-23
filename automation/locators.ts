import type { Page, Locator } from "playwright";
import type { TargetSpec, InputValues } from "./schema.js";
import { interpolate } from "./policy.js";
import { RuntimeCondition } from "./errors.js";

export async function resolveTarget(
  page: Page,
  target: TargetSpec,
  inputs: InputValues,
  timeout = 8000,
): Promise<{ locator: Locator; strategy: string }> {
  const order = { role: 0, label: 1, text: 2, attribute: 3, css: 4 };
  const candidates = [...target.locators].sort(
    (a, b) => order[a.kind] - order[b.kind],
  );
  const deadline = Date.now() + timeout;
  do {
    for (const spec of candidates) {
      let locator: Locator;
      if (spec.kind === "role")
        locator = page.getByRole(spec.role, {
          name: interpolate(spec.name, inputs),
          exact: spec.exact,
        });
      else if (spec.kind === "label")
        locator = page.getByLabel(interpolate(spec.label, inputs), {
          exact: true,
        });
      else if (spec.kind === "text")
        locator = page.getByText(interpolate(spec.text, inputs), {
          exact: true,
        });
      else if (spec.kind === "attribute")
        locator = page.locator(
          `${spec.tag}[${spec.attribute}=${JSON.stringify(interpolate(spec.value, inputs))}]`,
        );
      else locator = page.locator(interpolate(spec.selector, inputs));
      const count = await locator.count();
      if (count > 1)
        throw new RuntimeCondition(
          "AMBIGUOUS_TARGET",
          "Locator matched multiple elements; refusing arbitrary first match",
          "hard",
          target,
          { strategy: spec.kind, count },
        );
      if (count === 1 && (await locator.isVisible()))
        return { locator, strategy: spec.kind };
    }
    await page.waitForTimeout(150);
  } while (Date.now() < deadline);
  throw new RuntimeCondition(
    "CONTROL_NOT_FOUND",
    "No unique visible control matched the locator strategies",
    "hard",
    target,
    { path: new URL(page.url()).pathname },
  );
}
