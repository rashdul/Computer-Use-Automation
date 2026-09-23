import type { Page } from "playwright";
import { RuntimeCondition } from "./errors.js";

// Only rendered search results are read. No backend requests or application state.
export async function resolveNameSearch(
  page: Page,
  query: string,
): Promise<string | undefined> {
  const url = new URL(page.url());
  if (url.pathname !== "/members" || url.searchParams.get("q") !== query)
    return;
  if (await page.locator('.top-progress[data-active="true"]').count()) return;
  // Some deployed RFCU versions expose the section without a computed region
  // name. Anchor the container to its visible heading in either version.
  const results = page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: /^Results/ }) });
  if ((await results.count()) !== 1) return;
  const count = await results
    .locator(".panel__count")
    .textContent()
    .catch(() => null);
  if (!count || !/\d/.test(count)) return;
  const total = Number(count.replace(/\D/g, ""));
  if (total === 0)
    throw new RuntimeCondition(
      "MEMBER_NOT_FOUND",
      "No member matches the requested name",
      "business",
    );
  if (total > 1)
    throw new RuntimeCondition(
      "MEMBER_AMBIGUOUS",
      "Multiple members match this name. Use a more specific name or restart with a member number.",
      "business",
      { uniqueMatch: true },
      { matchCount: total },
    );
  const table = page.getByRole("table", {
    name: "Members matching the search",
    exact: true,
  });
  const rows = table.locator("tbody tr[data-href]");
  if ((await rows.count()) !== 1) return;
  const row = rows.first();
  const href = await row.getAttribute("data-href");
  const id = href?.match(/^\/members\/(\d{7})$/)?.[1];
  const visibleName = await row.locator("td.col-primary").innerText();
  const normalize = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}]+/gu, " ")
      .trim();
  const nameWords = normalize(visibleName).split(/\s+/);
  if (
    !id ||
    !normalize(query)
      .split(/\s+/)
      .every((word) => nameWords.some((n) => n.startsWith(word)))
  )
    throw new RuntimeCondition(
      "MEMBER_NAME_MISMATCH",
      "The unique result does not match the supplied name; refusing to open it",
    );
  return id;
}
