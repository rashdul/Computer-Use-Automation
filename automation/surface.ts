import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { randomUUID } from "node:crypto";
import type {
  CapabilityStep,
  CheckpointSpec,
  InputValues,
  Money,
  TargetSpec,
} from "./schema.js";
import { Policy, interpolate } from "./policy.js";
import { Secrets, parameterize } from "./secrets.js";
import { resolveTarget } from "./locators.js";
import { SessionManager } from "./session.js";
import { RuntimeCondition, classifyText } from "./errors.js";
import { allowResource, targetBackendOrigin } from "./network.js";
import { resolveNameSearch } from "./member-search.js";

export interface Observation {
  path: string;
  session: string;
  controls: { name: string; target: TargetSpec }[];
  signals: string[];
  accountSummary?: string;
}
export interface SurfaceAdapter {
  readonly session: SessionManager;
  observe(): Promise<Observation>;
  execute(step: CapabilityStep): Promise<{ strategy?: string; output?: Money }>;
  checkpoint(
    checkpoint: CheckpointSpec,
    outputs: Record<string, Money>,
  ): Promise<void>;
  close(): Promise<void>;
}
export function parseMoney(text: string): Money {
  const match = text.trim().match(/^(-?)\$([\d,]+\.\d{2})$/);
  if (!match)
    throw new RuntimeCondition(
      "OUTPUT_VALIDATION_FAILED",
      "Expected a single USD current balance",
    );
  return { amount: match[1] + match[2].replace(/,/g, ""), currency: "USD" };
}
export class PlaywrightSurface implements SurfaceAdapter {
  readonly session = new SessionManager();
  readonly contextId = randomUUID();
  readonly pageId = randomUUID();
  private blockedNavigation = false;
  constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly policy: Policy,
    private secrets: Secrets,
    readonly inputs: InputValues,
  ) {}
  static async create(
    policy: Policy,
    secrets: Secrets,
    inputs: InputValues,
    headed = false,
  ) {
    const browser = await chromium
      .launch({
        headless: !headed,
        ...(process.env.RFCU_BROWSER_CHANNEL
          ? { channel: process.env.RFCU_BROWSER_CHANNEL }
          : {}),
      })
      .catch(() => {
        throw new RuntimeCondition(
          "BROWSER_UNAVAILABLE",
          "Install Chromium with npx playwright install chromium, or configure an installed RFCU_BROWSER_CHANNEL",
        );
      });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const surface = new PlaywrightSurface(
      browser,
      context,
      page,
      policy,
      secrets,
      inputs,
    );
    const backendOrigin = await targetBackendOrigin();
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        try {
          policy.url(request.url());
        } catch {
          surface.blockedNavigation = true;
          await route.abort();
          return;
        }
      } else if (!allowResource(request.url(), policy.origin, backendOrigin)) {
        surface.blockedNavigation = true;
        await route.abort();
        return;
      }
      await route.continue();
    });
    context.on("page", (p) => {
      if (p !== page) void p.close();
    });
    page.on("download", (d) => void d.cancel());
    page.on("dialog", (d) => void d.dismiss());
    try {
      await page.goto(policy.url("/login"), {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .getByLabel("Username", { exact: true })
        .waitFor({ timeout: 30000 });
    } catch {
      await browser.close();
      throw new RuntimeCondition(
        "START_FAILED",
        "RFCU login page could not be opened",
      );
    }
    return surface;
  }
  async observe(): Promise<Observation> {
    const u = new URL(this.page.url());
    if (
      u.pathname === "/session-expired" ||
      (u.pathname === "/login" && this.session.everAuthenticated)
    )
      this.session.observe(u.pathname, false);
    if (this.blockedNavigation)
      throw new RuntimeCondition(
        "POLICY_DENIED",
        "Blocked an out-of-scope browser request",
      );
    this.policy.url(u.href);
    await this.page
      .waitForFunction(
        () => !document.querySelector('.top-progress[data-active="true"]'),
        {},
        { timeout: 10000 },
      )
      .catch(() => undefined);
    // Read only rendered DOM. No cookies, storage, fetch, application internals or database access.
    const raw = await this.page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll("input,select,button,a"),
      )
        .filter(
          (e) =>
            !!(e as HTMLElement).offsetWidth &&
            !!(e as HTMLElement).offsetHeight,
        )
        .map((e) => {
          const tag = e.tagName.toLowerCase();
          const label = e.id
            ? (
                document.querySelector(`label[for="${CSS.escape(e.id)}"]`)
                  ?.textContent ?? ""
              ).trim()
            : "";
          return {
            tag,
            label,
            name:
              e.getAttribute("aria-label") ||
              label ||
              (e.textContent ?? "").replace(/\s+/g, " ").trim(),
            type: e.getAttribute("type"),
            field: e.getAttribute("name"),
            href: e.getAttribute("href"),
            title: e.getAttribute("title"),
          };
        });
      const body = document.body.innerText;
      const patterns = [
        "No members match",
        "Member not found",
        "Permission denied",
        "username or password",
        "Enter your username",
        "Enter your password",
        "request timed out",
        "service unavailable",
        "staff account is disabled",
        "Sign-in failed",
      ];
      return {
        controls,
        loading: !!document.querySelector('.top-progress[data-active="true"]'),
        signals: patterns.filter((p) =>
          body.toLowerCase().includes(p.toLowerCase()),
        ),
        dialog: !!document.querySelector(
          '[role="alertdialog"],[role="dialog"]',
        ),
        shell: !!document.querySelector(".shell"),
        account: (
          document.querySelector('[aria-label="Account summary"]')
            ?.textContent ?? ""
        )
          .replace(/\s+/g, " ")
          .trim(),
      };
    });
    const session = this.session.observe(u.pathname, raw.shell);
    const known =
      /^(Sign in|Search|Member search|Members|Overview|Accounts(?:\s+\d+)?|All accounts|Try again|Acknowledge|Dismiss|Remind me later|OK, got it|Sign in again|Username|Password|Status|Branch|Sort by|Clear search|Continue|Resolve demonstration block)$/;
    const controls: Observation["controls"] = [];
    for (const c of raw.controls) {
      let name = c.name;
      if (c.tag === "a" && c.href) {
        const href = new URL(c.href, this.policy.origin);
        try {
          this.policy.url(href.href);
        } catch {
          continue;
        }
        if (
          href.pathname === `/members/${this.inputs.member_id}` &&
          !known.test(name)
        )
          name = this.inputs.member_id!;
        if (href.pathname.endsWith(`/${this.inputs.member_id}-S00`))
          name = "Primary savings share S00";
        if (
          !known.test(name) &&
          name !== this.inputs.member_id &&
          name !== "Primary savings share S00"
        )
          continue;
        // The semantic href is an observed attribute; names containing member PII are never copied.
        const locators: TargetSpec["locators"] = [];
        if (name === c.name && name)
          locators.push({
            kind: "role",
            role: "link",
            name: parameterize(name, this.inputs),
            exact: true,
          });
        locators.push({
          kind: "attribute",
          tag: "a",
          attribute: "href",
          value: parameterize(c.href, this.inputs),
        });
        controls.push({
          name: parameterize(name, this.inputs),
          target: { description: parameterize(name, this.inputs), locators },
        });
      } else if (known.test(name)) {
        const locators: TargetSpec["locators"] = [];
        if (c.tag === "input" && c.type !== "password")
          locators.push({
            kind: "role",
            role: c.type === "search" ? "searchbox" : "textbox",
            name,
            exact: true,
          });
        if (c.label) locators.push({ kind: "label", label: c.label });
        if (c.tag === "button")
          locators.push({ kind: "role", role: "button", name, exact: true });
        if (c.tag === "select")
          locators.push({ kind: "role", role: "combobox", name, exact: true });
        if (locators.length)
          controls.push({ name, target: { description: name, locators } });
      }
    }
    const signals = [...raw.signals];
    if (this.inputs.member_name && this.inputs.member_id)
      signals.push("MEMBER_RESOLVED");
    if (raw.dialog) signals.push("MODAL_PRESENT");
    if (raw.loading) signals.push("LOADING");
    // Strip account numbers/nicknames/owners. Only product identity and labeled balances are exposed.
    const accountSummary = raw.account
      ? [
          "Account summary",
          raw.account.includes("S00") ? "S00" : "",
          ...(raw.account.match(
            /(?:Current balance|Available|On hold)\s+-?\$[\d,.]+/g,
          ) ?? []),
        ].join(" | ")
      : undefined;
    if (raw.account)
      controls.push({
        name: "Current balance value",
        target: {
          description: "Current balance in Account summary",
          locators: [
            {
              kind: "css",
              selector:
                'section[aria-label="Account summary"] .account-balances > div:has(.account-balances__label:text-is("Current balance")) .account-balances__value',
            },
          ],
        },
      });
    return {
      path: parameterize(u.pathname + u.search, this.inputs),
      session,
      controls,
      signals,
      accountSummary,
    };
  }
  async condition() {
    const o = await this.observe();
    const condition = classifyText(o.signals.join(" "));
    if (condition) {
      if (
        condition.code.startsWith("AUTH") ||
        condition.code.startsWith("LOGIN")
      )
        this.session.block();
      throw condition;
    }
    return o;
  }
  async execute(step: CapabilityStep) {
    const current = await this.condition();
    this.policy.step(step, new URL(this.page.url()).pathname);
    if (current.signals.includes("MODAL_PRESENT"))
      throw new RuntimeCondition(
        "INTERSTITIAL_BLOCKED",
        "An unexpected dialog requires operator review",
      );
    if (step.action === "navigate") {
      if (
        this.session.state !== "authenticated" &&
        step.value?.source === "literal" &&
        step.value.value !== "/login"
      )
        throw new RuntimeCondition(
          "POLICY_DENIED",
          "Cannot navigate to a protected route before UI authentication",
        );
      await this.page.goto(
        this.policy.url(
          interpolate(
            step.value?.source === "literal" ? step.value.value : "",
            this.inputs,
          ),
        ),
        { waitUntil: "domcontentloaded" },
      );
      return {};
    }
    if (step.action === "wait") {
      await this.page.waitForTimeout(300);
      return {};
    }
    const { locator, strategy } = await resolveTarget(
      this.page,
      step.target!,
      this.inputs,
    );
    if (step.action === "fill") {
      const value = step.value!;
      const resolved =
        value.source === "secret"
          ? this.secrets.get(value.key)
          : value.source === "input"
            ? this.inputs[value.key]
            : value.value;
      if (value.source === "secret") this.session.authenticating();
      if (resolved === undefined)
        throw new RuntimeCondition("INVALID_PARAMETER", "Input is not bound");
      await locator.fill(resolved);
    } else if (step.action === "select") {
      const value = step.value!;
      if (value.source === "secret")
        throw new RuntimeCondition(
          "POLICY_DENIED",
          "Secrets cannot be used in selection controls",
        );
      await locator.selectOption({
        label: value.source === "input" ? this.inputs[value.key] : value.value,
      });
    } else if (step.action === "click") {
      // Risk is derived from the actual control as well as model-supplied intent.
      const tag = await locator.evaluate((e) => e.tagName.toLowerCase());
      const href = await locator.getAttribute("href");
      if (tag === "a" && href) this.policy.url(href);
      else {
        const name = (await locator.innerText()).trim();
        if (!["Sign in", "Search", "Try again"].includes(name))
          throw new RuntimeCondition(
            "HUMAN_APPROVAL_REQUIRED",
            "This control is not on the read-only button allowlist",
          );
      }
      await locator.click();
      await this.page.waitForTimeout(100);
    } else if (step.action === "extract") {
      const path = new URL(this.page.url()).pathname;
      if (
        path !==
        `/members/${this.inputs.member_id}/accounts/${this.inputs.member_id}-S00`
      )
        throw new RuntimeCondition(
          "WRONG_ACCOUNT",
          "Extraction requires this member’s primary savings detail",
        );
      // Cross-check the requested locator against the visible labeled current balance.
      const summary = this.page.getByRole("region", {
        name: "Account summary",
        exact: true,
      });
      const body = await summary.innerText();
      if (!body.includes(`${this.inputs.member_id}-S00`))
        throw new RuntimeCondition(
          "WRONG_ACCOUNT",
          "Account ownership checkpoint failed",
        );
      const expected = await summary
        .locator(".account-balances__label")
        .filter({ hasText: /^Current balance$/ })
        .locator("..")
        .locator(".account-balances__value")
        .innerText();
      const actual = await locator.innerText();
      if (actual.trim() !== expected.trim())
        throw new RuntimeCondition(
          "WRONG_BALANCE",
          "Extraction target does not equal the labeled current balance",
        );
      return { strategy, output: parseMoney(actual) };
    }
    return { strategy };
  }
  async checkpoint(cp: CheckpointSpec, outputs: Record<string, Money>) {
    const deadline = Date.now() + 12000;
    do {
      await this.condition();
      if (cp.kind === "member_resolved") {
        if (!this.inputs.member_name)
          throw new RuntimeCondition(
            "INVALID_PARAMETER",
            "Name resolution requires member_name",
          );
        const id = await resolveNameSearch(this.page, this.inputs.member_name);
        if (id) {
          if (this.inputs.member_id && this.inputs.member_id !== id)
            throw new RuntimeCondition(
              "MEMBER_CHANGED",
              "Resolved member changed during this run",
            );
          this.inputs.member_id = id;
          return;
        }
      }
      if (cp.kind === "authenticated" && this.session.state === "authenticated")
        return;
      if (
        cp.kind === "route" &&
        new URL(this.page.url()).pathname === interpolate(cp.path, this.inputs)
      )
        return;
      if (
        cp.kind === "output" &&
        outputs[cp.key] &&
        /^-?\d+\.\d{2}$/.test(outputs[cp.key].amount)
      )
        return;
      if (cp.kind === "visible") {
        try {
          await resolveTarget(this.page, cp.target, this.inputs, 250);
          return;
        } catch (e) {
          if (e instanceof RuntimeCondition && e.code === "AMBIGUOUS_TARGET")
            throw e;
        }
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    throw new RuntimeCondition(
      "CHECKPOINT_FAILED",
      "Expected state did not become true",
      "hard",
      cp,
      await this.observe(),
    );
  }
  async close() {
    await this.browser.close();
  }
}
