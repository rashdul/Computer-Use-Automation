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
import { isAllowedUrl, PolicyViolation, resolveTemplate, SENSITIVE_PATTERNS, type AppProfile } from "./safety.js";
import type { ActionType, Condition, ExtractionSource, Locator, Target } from "./schema.js";

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
    const r = (s: string) => resolveTemplate(s, inputs);
    const root = l.within
      ? this.page.getByRole(l.within.role as AriaRole, { name: l.within.name === undefined ? undefined : r(l.within.name), exact: true })
      : this.page;
    switch (l.by) {
      case "link": {
        const prefix = r(l.hrefPrefix);
        const prefixes = prefix.startsWith("/") && !prefix.startsWith("//")
          ? [prefix, new URL(prefix, this.url()).href]
          : [prefix];
        // Match the published destination, not site-specific classes or IDs.
        const quote = (s: string) => `"${s.replace(/[\\"\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
        const links = root.getByRole("link").and(this.page.locator(prefixes.map((p) => `[href^=${quote(p)}]`).join(","))).filter({ visible: true });
        return l.position === "first" ? links.first() : links;
      }
      case "role":
        if (l.namePattern !== undefined) return root.getByRole(l.role as AriaRole, { name: new RegExp(l.namePattern) });
        return l.name === undefined
          ? root.getByRole(l.role as AriaRole)
          : root.getByRole(l.role as AriaRole, { name: r(l.name), exact: l.exact ?? true });
      case "label":
        return root.getByLabel(r(l.label), { exact: true }).filter({ visible: true });
      case "text":
        return root.getByText(r(l.text)).filter({ visible: true });
      case "field":
        // The caption must be unique; the value is the element that follows it in reading order.
        return root.getByText(r(l.field), { exact: true }).filter({ visible: true }).locator("xpath=following-sibling::*[1]");
      case "cell": {
        // Column index comes from the header text at run time, so a reordered or
        // extra column does not shift the value we read.
        const row = root.getByRole("row", { name: r(l.row), exact: true });
        const headers = await root
          .getByRole("table")
          .filter({ has: row })
          .first()
          .getByRole("columnheader")
          .allInnerTexts();
        const index = headers.map((h) => h.trim()).indexOf(r(l.column));
        return index < 0 ? null : row.getByRole("cell").nth(index);
      }
    }
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
