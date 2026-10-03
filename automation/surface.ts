/**
 * The web surface: the only module that knows about Playwright.
 *
 * Discovery and replay talk to it in surface-neutral terms (observe an
 * accessibility tree, resolve a Target, act, read, detect). A legacy-web or
 * desktop surface (UI Automation / AT-SPI accessibility trees, or screenshots +
 * OCR) would implement the same operations; the artifact would not change.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Locator as PwLocator, type Page } from "playwright";
import { assertRequestedPosition } from "./portability.js";
import { describeLocator, isAllowedUrl, PolicyViolation, resolveTemplate, SENSITIVE_PATTERNS, type AppProfile } from "./safety.js";
import type { ActionType, Condition, ExtractionSource, Locator, Position, Target } from "./schema.js";

type AriaRole = Parameters<Page["getByRole"]>[0];
type Inputs = Record<string, string>;

export interface Observation {
  url: string;
  title: string;
  tree: string;
}

export type Resolution =
  | { status: "found"; locator: PwLocator; strategy: number }
  | { status: "missing" | "ambiguous"; counts: number[] };

export interface LaunchOptions {
  headed?: boolean;
  /** Exposes the live session on 127.0.0.1 so an operator console can attach (handoff). */
  cdpPort?: number;
}

export class WebSurface {
  readonly blockedNavigations: string[] = [];
  private marks = 0;

  /** A run-unique attribute value for elements a locator resolved in the page. */
  private nextMark(): string {
    return `m${Date.now().toString(36)}${++this.marks}`;
  }

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly profile: AppProfile,
    private readonly userDataDir: string,
  ) {}

  static async launch(profile: AppProfile, opts: LaunchOptions = {}): Promise<WebSurface> {
    // A persistent context is the browser's default context, so an operator
    // attaching over CDP sees the exact same pages, cookies, and storage.
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), "cua-session-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: !opts.headed,
      viewport: { width: 1440, height: 900 },
      args: opts.cdpPort ? [`--remote-debugging-port=${opts.cdpPort}`] : [],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const surface = new WebSurface(context, page, profile, userDataDir);
    // Origin allow-list, two layers:
    // 1. Every navigation request is intercepted and aborted if its URL is outside the list
    //    (link clicks, form posts, scripts), not only the ones we initiate.
    // 2. Server redirects are followed inside one request and never reach the route handler,
    //    so every committed main-frame URL is checked too; act() refuses to touch such a page.
    page.on("framenavigated", (frame) => {
      const url = frame.url();
      if (frame === page.mainFrame() && !url.startsWith("chrome-error:") && !isAllowedUrl(profile, url)) surface.blockedNavigations.push(url);
    });
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && !isAllowedUrl(profile, req.url())) {
        // The page leaving the allow-list is a policy violation; a third-party
        // frame inside it (ads, trackers) is simply not loaded.
        if (!req.frame().parentFrame()) surface.blockedNavigations.push(req.url());
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    return surface;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    // Best effort: on Windows, Chromium can hold files in its profile (e.g. chrome_debug.log) for a
    // moment after closing. A leftover temp folder must never replace the run's real result.
    try {
      rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }

  url(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<void> {
    if (!isAllowedUrl(this.profile, url)) throw new Error(`navigation to ${url} is outside the allow-list`);
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.settle();
  }

  /**
   * Accessibility tree as the model and the evidence log see it, taken once the
   * screen has stopped changing (same tree twice, nothing aria-busy) or after 8s.
   */
  async observe(): Promise<Observation> {
    const snap = () =>
      this.page
        .locator("body")
        .ariaSnapshot({ timeout: 5_000 })
        .catch(() => "(page not readable yet)");
    const deadline = Date.now() + 8_000;
    let tree = await snap();
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(400);
      const next = await snap();
      const busy = await this.page.locator("[aria-busy=true]").count().catch(() => 0);
      if (next === tree && busy === 0) break;
      tree = next;
    }
    return { url: this.url(), title: await this.page.title().catch(() => ""), tree };
  }

  /** Waits briefly for the SPA to finish the requests an action started. */
  async settle(): Promise<void> {
    await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  }

  async build(l: Locator, inputs: Inputs = {}): Promise<PwLocator | null> {
    // Names may contain redaction tokens copied from the masked tree ("Total deposits [money]");
    // those match the real value, whatever it is.
    const t = (s: string) => resolveTemplate(s, inputs);
    const r = (s: string) => redactedMatcher(t(s), true);
    const root = l.within
      ? this.page.getByRole(l.within.role as AriaRole, { name: l.within.name === undefined ? undefined : r(l.within.name), exact: true })
      : this.page;
    switch (l.by) {
      case "link": {
        const prefix = t(l.hrefPrefix);
        const prefixes = prefix.startsWith("/") && !prefix.startsWith("//")
          ? [prefix, new URL(prefix, this.url()).href]
          : [prefix];
        // Match the published destination, not site-specific classes or IDs.
        const quote = (s: string) => `"${s.replace(/[\\"\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
        const links = root.getByRole("link").and(this.page.locator(prefixes.map((p) => `[href^=${quote(p)}]`).join(","))).filter({ visible: true });
        return atPosition(links, l.position);
      }
      case "content": {
        // Never guess the region: two <main>s (or none) stay ambiguous (or missing).
        const region = l.within ? (root as PwLocator) : this.page.locator("body");
        if ((await region.count()) !== 1) return region;
        const token = this.nextMark();
        await region.evaluate(
          (scope, mark) => {
            const chrome = "nav,header,footer,aside,table,figure,figcaption,form,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=search],[aria-hidden=true]";
            for (const el of Array.from(scope.querySelectorAll<HTMLElement>("p,[role=paragraph]"))) {
              if (el.closest(chrome)) continue; // navigation, infoboxes, sidebars, captions
              if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
              if (!el.innerText.trim()) continue; // empty, or only hidden text
              el.setAttribute("data-cua-mark", mark);
            }
          },
          token,
        );
        return atPosition(this.page.locator(`[data-cua-mark="${token}"]`), l.position);
      }
      case "role": {
        const level = l.level !== undefined ? { level: l.level } : {};
        const byRole =
          l.namePattern !== undefined
            ? root.getByRole(l.role as AriaRole, { name: new RegExp(l.namePattern), ...level })
            : l.name === undefined
              ? root.getByRole(l.role as AriaRole, level)
              : root.getByRole(l.role as AriaRole, { name: redactedMatcher(t(l.name), l.exact ?? true), exact: l.exact ?? true, ...level });
        return atPosition(byRole, l.position);
      }
      case "label":
        return root.getByLabel(r(l.label), { exact: true }).filter({ visible: true });
      case "text":
        return root.getByText(redactedMatcher(t(l.text), false)).filter({ visible: true });
      case "field":
        // The caption must be unique; the value is the element that follows it in reading order.
        return root.getByText(r(l.field), { exact: true }).filter({ visible: true }).locator("xpath=following-sibling::*[1]");
      case "cell": {
        if (l.rowKey) {
          // The row whose KEY column holds the value (usually an input), then the value column.
          // Both are found by header text, so reordered or extra columns do not matter;
          // duplicate keys or several matching tables stay ambiguous.
          const region = l.within ? (root as PwLocator) : this.page.locator("body");
          if ((await region.count()) !== 1) return region;
          const token = this.nextMark();
          await region.evaluate(
            (scope, a) => {
              for (const table of Array.from(scope.querySelectorAll("table"))) {
                const rows = Array.from(table.rows);
                const header = rows.find((row) => row.querySelector("th"));
                if (!header) continue;
                let position = 0;
                let keyAt = -1;
                let valueAt = -1;
                for (const th of Array.from(header.cells)) {
                  const text = th.innerText.trim();
                  if (text === a.key) keyAt = position;
                  if (text === a.column) valueAt = position;
                  position += th.colSpan || 1;
                }
                if (keyAt < 0 || valueAt < 0) continue;
                for (const row of rows) {
                  if (row === header) continue;
                  let at = 0;
                  let keyCell: HTMLTableCellElement | null = null;
                  let valueCell: HTMLTableCellElement | null = null;
                  for (const cell of Array.from(row.cells)) {
                    const span = cell.colSpan || 1;
                    if (at === keyAt && span === 1) keyCell = cell;
                    if (at === valueAt && span === 1) valueCell = cell;
                    at += span;
                  }
                  if (keyCell && valueCell && keyCell.innerText.trim() === a.value) valueCell.setAttribute("data-cua-mark", a.mark);
                }
              }
            },
            { key: t(l.rowKey.column), value: t(l.rowKey.value), column: t(l.column), mark: token },
          );
          return this.page.locator(`[data-cua-mark="${token}"]`);
        }
        if (l.row === undefined) return null;
        const row = root.getByRole("row", { name: r(l.row), exact: true });
        if ((await row.count()) !== 1) return row; // 0 = missing, 2+ = ambiguous: never pick one
        // Column position comes from the table's header row (by text) at run time, so reordered or
        // extra columns do not shift the value. Read from the table itself: plain tables often
        // expose no "columnheader" role. Totals and subtotal rows merge leading cells ("Total
        // deposits" spanning six columns), so the position is mapped onto cells by colSpan.
        const column = r(l.column);
        const cellIndex = await row.evaluate(
          (tr, c) => {
            const table = tr.closest("table");
            const header = table ? Array.from(table.rows).find((h) => h.querySelector("th")) : undefined;
            if (!header || header === tr) return -1;
            const pattern = c.pattern ? new RegExp(c.pattern) : null;
            let position = 0;
            let col = -1;
            for (const th of Array.from(header.cells)) {
              const text = th.innerText.trim();
              if (pattern ? pattern.test(text) : text === c.text) {
                col = position;
                break;
              }
              position += th.colSpan || 1;
            }
            if (col < 0) return -1;
            let at = 0;
            const cells = Array.from((tr as HTMLTableRowElement).cells);
            for (let i = 0; i < cells.length; i++) {
              const span = cells[i].colSpan || 1;
              if (col < at + span) return at === col && span === 1 ? i : -1; // inside a merged cell: no single value
              at += span;
            }
            return -1;
          },
          typeof column === "string" ? { text: column, pattern: "" } : { text: "", pattern: column.source },
        );
        return cellIndex < 0 ? null : row.locator(":scope > *").nth(cellIndex);
      }
    }
  }

  /**
   * Turns a target the model copied from the page into one that holds for every record, when the
   * element allows it:
   *   - literal paragraph text -> the prose paragraph at the position the goal asked for;
   *   - a named heading / paragraph / list item / row -> the same role, unnamed, in the same scope;
   *   - a table row named after its values -> the row whose key column holds an input.
   * A candidate is used only if it resolves to the SAME single element; otherwise the original
   * target is kept (and the portability checks decide whether it is acceptable).
   */
  async reusableTarget(
    original: Locator,
    element: PwLocator,
    context: "extract" | "checkpoint" | "action",
    goal: string,
    inputValues: string[],
  ): Promise<Target> {
    const keep: Target = { description: describeLocator(original), locators: [original] };
    if (context === "action") return keep;
    const handle = await element.elementHandle().catch(() => null);
    if (!handle) return keep;
    const sameElement = async (candidate: Locator): Promise<boolean> => {
      const loc = await this.build(candidate).catch(() => null);
      if (!loc || (await loc.count()) !== 1) return false;
      return loc.evaluate((el, h) => el === h, handle).catch(() => false);
    };
    const use = (candidate: Locator): Target => ({ description: describeLocator(candidate), locators: [candidate] });
    try {
      const info = await element.evaluate((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role") ?? "" }));

      // 1. Paragraph text -> its position among the prose paragraphs, if the goal names that position.
      const isParagraph = info.tag === "p" || info.role === "paragraph";
      if (isParagraph && (original.by === "text" || (original.by === "role" && original.role === "paragraph"))) {
        const within = (await this.page.getByRole("main").count()) === 1 ? { role: "main" } : undefined;
        const all = await this.build({ by: "content", kind: "paragraph", ...(within && { within }) });
        const count = all ? await all.count() : 0;
        const index = all ? await all.evaluateAll((els, h) => (els as Element[]).indexOf(h as unknown as Element), handle) : -1;
        if (index >= 0) {
          const positions: Position[] = [...(index === 0 ? (["first"] as const) : []), ...(index === count - 1 ? (["last"] as const) : []), index + 1];
          for (const position of positions) {
            const candidate: Locator = { by: "content", kind: "paragraph", position, ...(within && { within }) };
            try {
              assertRequestedPosition(candidate, goal);
            } catch {
              continue; // the goal did not ask for this position
            }
            if (await sameElement(candidate)) return use(candidate);
          }
        }
      }

      // 2. A named page-data role (its name is the data) -> the same role, unnamed, in the same scope.
      if (original.by === "role" && (original.name !== undefined || original.namePattern !== undefined) && DATA_ROLES.includes(original.role)) {
        const level = await element.evaluate((el) => Number(el.getAttribute("aria-level") ?? el.tagName.match(/^H([1-6])$/)?.[1] ?? 0));
        const candidates: Locator[] = [{ by: "role", role: original.role, ...(original.within && { within: original.within }) }];
        if (level) candidates.push({ by: "role", role: original.role, level, ...(original.within && { within: original.within }) });
        for (const candidate of candidates) if (await sameElement(candidate)) return use(candidate);
      }

      // 3. A row named after its values -> the row whose key column holds one of the inputs.
      if (original.by === "cell" && original.row !== undefined && inputValues.length) {
        const keys = await element.evaluate(
          (cell, values) => {
            const row = cell.closest("tr");
            const table = row?.closest("table");
            const header = table ? Array.from(table.rows).find((r) => r.querySelector("th")) : undefined;
            if (!row || !header || header === row) return [];
            const headers: string[] = [];
            for (const th of Array.from(header.cells)) for (let i = 0; i < (th.colSpan || 1); i++) headers.push(th.innerText.trim());
            const found: { column: string; value: string }[] = [];
            let at = 0;
            for (const c of Array.from(row.cells)) {
              const text = c.innerText.trim();
              if ((c.colSpan || 1) === 1 && values.includes(text) && headers[at]) found.push({ column: headers[at], value: text });
              at += c.colSpan || 1;
            }
            return found;
          },
          inputValues,
        );
        for (const rowKey of keys) {
          const candidate: Locator = { by: "cell", column: original.column, rowKey, ...(original.within && { within: original.within }) };
          if (await sameElement(candidate)) return use(candidate);
        }
      }
    } finally {
      await handle.dispose().catch(() => {});
    }
    return keep;
  }

  /** First strategy that identifies exactly one element wins. Never guesses between several. */
  async resolve(target: Target, inputs: Inputs = {}): Promise<Resolution> {
    const counts: number[] = [];
    for (const [strategy, l] of target.locators.entries()) {
      const loc = await this.build(l, inputs);
      const n = loc ? await loc.count() : 0;
      counts.push(n);
      if (n === 1 && loc) return { status: "found", locator: loc, strategy };
    }
    return { status: counts.some((n) => n > 1) ? "ambiguous" : "missing", counts };
  }

  async act(action: ActionType, loc: PwLocator, value?: string, extract: ExtractionSource = "text"): Promise<string | undefined> {
    if (!isAllowedUrl(this.profile, this.url())) throw new PolicyViolation(`refusing to act on ${this.url()}: outside the allow-list`);
    const timeout = 10_000;
    switch (action) {
      case "click":
        await loc.click({ timeout });
        break;
      case "fill":
        await loc.fill(value ?? "", { timeout });
        break;
      case "select":
        await loc.selectOption({ label: value ?? "" }, { timeout });
        break;
      case "press":
        await loc.press(value ?? "Enter", { timeout });
        break;
      case "extract":
        if (extract === "href") {
          const href = await loc.getAttribute("href", { timeout });
          if (!href?.trim()) throw new Error("URL extraction requires a non-empty link href");
          const url = await loc.evaluate((el) => new URL(el.getAttribute("href")!, el.baseURI).href);
          if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("URL extraction requires an HTTP(S) link");
          return url;
        }
        return (await loc.innerText({ timeout })).trim();
    }
    await this.settle();
    return undefined;
  }

  async isPresent(l: Locator, inputs: Inputs = {}): Promise<boolean> {
    const loc = await this.build(l, inputs).catch(() => null);
    return loc ? (await loc.count()) > 0 : false;
  }

  /** First known condition currently on screen, if any. */
  async detect(conditions: Condition[], inputs: Inputs = {}): Promise<Condition | null> {
    for (const c of conditions) if (await this.isPresent(c.when, inputs)) return c;
    return null;
  }

  /** Text of an open modal the flow does not account for (null if none). */
  async openDialog(except?: PwLocator): Promise<string | null> {
    const dialogs = this.page.getByRole("dialog").or(this.page.getByRole("alertdialog"));
    if ((await dialogs.count()) === 0) return null;
    if (except && (await except.evaluate((el) => !!el.closest("[role=dialog],[role=alertdialog],dialog")).catch(() => false))) {
      return null; // the step's own target lives in the dialog, so the flow expects it
    }
    return (await dialogs.first().innerText().catch(() => "dialog")).slice(0, 200);
  }

  /**
   * Screenshot with sensitive values blurred: any text matching the redaction
   * patterns (amounts, SSNs, phones, emails, dates), plus table cells, definition
   * values and inputs. CSS blur respects stacking, so dialogs stay readable.
   */
  async screenshot(file: string): Promise<string> {
    await this.page
      .evaluate((sources) => {
        const patterns = sources.map((s) => new RegExp(s));
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (patterns.some((p) => p.test(n!.textContent ?? ""))) n.parentElement?.setAttribute("data-cua-redact", "");
        }
      }, SENSITIVE_PATTERNS.map(([re]) => re.source))
      .catch(() => {});
    await this.page.screenshot({ path: file, style: "[data-cua-redact], td, dd, input { filter: blur(7px) !important; }" });
    return file;
  }
}

/** Roles whose accessible name is page data (a title, a row's values), not a fixed control label. */
const DATA_ROLES = ["heading", "paragraph", "listitem", "cell", "row", "article", "main"];

/** Applies an ordinal the goal asked for; without one the locator must match exactly one element. */
function atPosition(loc: PwLocator, position: Position | undefined): PwLocator {
  if (position === undefined) return loc;
  if (position === "first") return loc.first();
  if (position === "last") return loc.last();
  return loc.nth(position - 1);
}

const REDACTION_TOKEN = new RegExp(`(${SENSITIVE_PATTERNS.map(([, label]) => label.replace(/[[\]]/g, "\\$&")).join("|")})`);

/**
 * The model sees amounts, dates, SSNs, phones and emails masked ("[money]"). When it copies such
 * a token into a target, match it against the real value's pattern, so "Total deposits [money]"
 * finds "Total deposits $2,915.86" and keeps working for every record. Text without tokens is
 * returned unchanged (Playwright's normal string matching).
 */
export function redactedMatcher(text: string, exact: boolean): string | RegExp {
  if (!REDACTION_TOKEN.test(text)) return text;
  const source = text
    .split(REDACTION_TOKEN)
    .map((part) => {
      const pattern = SENSITIVE_PATTERNS.find(([, label]) => label === part)?.[0];
      return pattern ? `(?:${pattern.source})` : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(exact ? `^${source}$` : source);
}

/**
 * A name ending in a short counter ("Accounts 3", "Inbox 12") differs per record, so it gets a
 * pattern that accepts any count. 5+ digit numbers are record IDs and are left alone.
 */
export function counterPattern(name: string): string | null {
  const m = name.match(/^(.*[^\d\s])\s+\d{1,4}$/);
  return m ? `^${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\d+$` : null;
}

/** Extra strategies for a control, kept only if each identifies the same single element. */
export async function fallbacksFor(surface: WebSurface, primary: Locator, element: PwLocator): Promise<Locator[]> {
  const candidates: Locator[] = [];
  if (primary.by === "label") {
    for (const role of ["textbox", "searchbox", "combobox"]) candidates.push({ by: "role", role, name: primary.label, ...(primary.within && { within: primary.within }) });
  }
  if (primary.by === "role" && primary.name !== undefined) {
    const counter = counterPattern(primary.name);
    if (counter) candidates.push({ by: "role", role: primary.role, namePattern: counter, ...(primary.within && { within: primary.within }) });
    if (["textbox", "searchbox", "combobox", "checkbox", "radio", "spinbutton"].includes(primary.role)) {
      candidates.push({ by: "label", label: primary.name, ...(primary.within && { within: primary.within }) });
    } else if (primary.role !== "row" && primary.role !== "cell") {
      candidates.push({ by: "role", role: primary.role, name: primary.name, exact: false, ...(primary.within && { within: primary.within }) });
      candidates.push({ by: "text", text: primary.name, ...(primary.within && { within: primary.within }) });
    }
  }
  const handle = await element.elementHandle();
  const kept: Locator[] = [];
  for (const c of candidates) {
    const loc = await surface.build(c).catch(() => null);
    if (!loc || (await loc.count()) !== 1) continue;
    const same = await loc.evaluate((el, h) => el === h, handle).catch(() => false);
    if (same) kept.push(c);
  }
  await handle?.dispose();
  return kept;
}
