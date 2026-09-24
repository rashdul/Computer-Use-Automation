import type { Page } from "playwright";
import type {
  InputValues,
  TargetSpec,
  CapabilityStep,
  OutputValue,
} from "./schema.js";
import type { Policy } from "./policy.js";
import { parameterize, redactPII, Secrets } from "./secrets.js";
import { PRIVATE_LABEL } from "./rfcu-profile.js";
import { RuntimeCondition } from "./errors.js";
import { resolveTarget } from "./locators.js";

export function cleanText(text: string, inputs: InputValues, secrets: Secrets) {
  return parameterize(redactPII(secrets.redact(text)), inputs)
    .replace(/\b\d{7}\b/g, "[MEMBER]")
    .slice(0, 8000);
}
export async function observeGeneral(
  page: Page,
  policy: Policy,
  inputs: InputValues,
  secrets: Secrets,
) {
  const raw = await page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll('input,textarea,select,button,a,[role="tab"]'),
    )
      .filter(
        (e) =>
          (e as HTMLElement).offsetWidth > 0 &&
          !e.closest(".topbar,.sidebar__foot,.user-menu") &&
          !(e as HTMLInputElement).disabled,
      )
      .map((e) => {
        const labelled = e
          .getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        const labels = (e as HTMLInputElement).labels;
        const label = labels?.length
          ? Array.from(labels)
              .map((l) => {
                const copy = l.cloneNode(true) as Element;
                copy
                  .querySelectorAll(".check__hint,.field__hint")
                  .forEach((h) => h.remove());
                return copy.textContent?.trim();
              })
              .join(" ")
          : "";
        const name = (
          e.getAttribute("aria-label") ||
          labelled ||
          label ||
          (e.tagName === "INPUT" ? "" : e.textContent) ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const select =
          e.tagName === "SELECT"
            ? Array.from((e as HTMLSelectElement).options)
                .map((o) => ({ label: o.label, value: o.value }))
                .slice(0, 60)
            : undefined;
        return {
          tag: e.tagName.toLowerCase(),
          type: e.getAttribute("type"),
          role: e.getAttribute("role"),
          name,
          label,
          href: e.getAttribute("href"),
          field: e.getAttribute("name"),
          navigation: e.closest("nav[aria-label]")?.getAttribute("aria-label"),
          shortenedLabel:
            !labelled &&
            !e.getAttribute("aria-label") &&
            !!Array.from(labels ?? []).find((l) =>
              l.querySelector(".check__hint,.field__hint"),
            ),
          privateControl: !!e.closest(".joint-list"),
          explicitName: !!labelled || !!e.getAttribute("aria-label"),
          select,
        };
      });
    const headings = Array.from(
      document.querySelectorAll(
        'main h1,main h2,.page h1,.page h2,[role="dialog"] h2',
      ),
    )
      .filter(
        (e) => (e as HTMLElement).offsetWidth > 0 && !e.closest(".member-band"),
      )
      .map((e) => ({
        name: Array.from(e.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join("")
          .trim(),
        tag: e.tagName.toLowerCase(),
      }));
    const tables = Array.from(document.querySelectorAll("table"))
      .filter((e) => e.offsetWidth > 0)
      .map((t) => {
        const panel = t.closest("section.panel");
        const h = panel?.querySelector("h2");
        const title = h
          ? Array.from(h.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent)
              .join("")
              .trim()
          : "";
        return {
          caption: t.querySelector("caption")?.textContent?.trim(),
          title,
          headers: Array.from(t.querySelectorAll("thead th")).map(
            (e) => e.textContent?.trim() ?? "",
          ),
        };
      });
    const fields = Array.from(document.querySelectorAll("dt"))
      .filter(
        (e) =>
          (e as HTMLElement).offsetWidth > 0 &&
          e.nextElementSibling?.tagName === "DD",
      )
      .map((e) => ({ label: e.textContent?.trim() ?? "" }));
    const alerts = Array.from(
      document.querySelectorAll(
        '[role="alert"],.error-summary,.field__error,.banner--bad',
      ),
    ).map((e) => e.textContent?.replace(/\s+/g, " ").trim().slice(0, 500));
    return { controls, headings, tables, fields, alerts };
  });
  const controls: {
    name: string;
    target: TargetSpec;
    options?: { label: string; value: string }[];
  }[] = [];
  const clean = (s: string) => cleanText(s, inputs, secrets);
  for (const c of raw.controls) {
    if (
      c.privateControl &&
      !Object.values(inputs).some((v) => v && c.name.includes(v))
    )
      continue;
    if (
      !c.name ||
      c.name.length > 250 ||
      /Show password|Reveal.*SSN/i.test(c.name)
    )
      continue;
    let name = c.name;
    const locators: TargetSpec["locators"] = [];
    if (c.tag === "a" && c.href) {
      try {
        policy.url(c.href);
      } catch {
        continue;
      }
      if (/^\/members\/\d{7}/.test(c.href)) name = c.href;
      if (name === c.name)
        locators.push({
          kind: "role",
          role: "link",
          name: clean(name),
          exact: true,
        });
      locators.push({
        kind: "attribute",
        tag: "a",
        attribute: "href",
        value: clean(c.href),
      });
    } else {
      if (
        c.tag === "input" &&
        c.type === "password" &&
        new URL(page.url()).pathname !== "/login"
      )
        continue;
      const role =
        c.role === "tab"
          ? "tab"
          : c.tag === "button"
            ? "button"
            : c.tag === "select"
              ? "combobox"
              : c.type === "checkbox"
                ? "checkbox"
                : c.type === "radio"
                  ? "radio"
                  : c.type === "search"
                    ? "searchbox"
                    : "textbox";
      locators.push({
        kind: "role",
        role,
        name: clean(name),
        exact: !c.shortenedLabel,
      });
      if (c.label && !c.shortenedLabel && !c.explicitName)
        locators.push({ kind: "label", label: clean(c.label) });
    }
    // Unknown names in controls on admin/member pages are not copied to the model.
    if (
      /^(Role for|Active for|Disable |End sessions for)/i.test(name) &&
      !Object.values(inputs).some((v) => v && name.includes(v))
    )
      continue;
    controls.push({
      name: clean(name),
      target: {
        description: clean(name),
        locators,
        ...(c.navigation
          ? {
              within: {
                role: "navigation" as const,
                name: clean(c.navigation),
              },
            }
          : {}),
      },
      ...(c.select
        ? {
            options: c.select.map((o) => ({
              label: clean(o.label),
              value: clean(o.value),
            })),
          }
        : {}),
    });
  }
  const readables: {
    name: string;
    target: TargetSpec;
    type: string;
    columns?: string[];
  }[] = [];
  for (const h of raw.headings)
    if (h.name && !PRIVATE_LABEL.test(h.name))
      readables.push({
        name: clean(h.name),
        target: {
          description: clean(h.name),
          locators: [
            {
              kind: "role",
              role: "heading",
              name: clean(h.name),
              exact: false,
            },
          ],
        },
        type: "text",
      });
  for (const t of raw.tables) {
    if (!t.headers.length) continue;
    const columns = t.headers.filter(
      (h) =>
        h &&
        !PRIVATE_LABEL.test(h) &&
        !/^(Name|Member #|User|Staff|Details|Description|Note)$/i.test(h),
    );
    let locators: TargetSpec["locators"] = [];
    if (t.caption)
      locators = [
        { kind: "role", role: "table", name: clean(t.caption), exact: true },
      ];
    else if (t.title)
      locators = [
        {
          kind: "css",
          selector: `section.panel:has(h2:text-matches(${JSON.stringify("^" + t.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))})) table`,
        },
      ];
    if (locators.length)
      readables.push({
        name: clean(t.caption || t.title || "Table"),
        target: {
          description: clean(t.caption || t.title || "Table"),
          locators,
        },
        type: "table",
        columns,
      });
  }
  for (const f of raw.fields)
    if (f.label && !PRIVATE_LABEL.test(f.label))
      readables.push({
        name: clean(f.label),
        target: {
          description: clean(f.label),
          locators: [
            {
              kind: "css",
              selector: `dt:text-is(${JSON.stringify(clean(f.label))}) + dd`,
            },
          ],
        },
        type: "text",
      });
  return {
    controls,
    readables,
    alerts: raw.alerts.filter(Boolean).map((s) => clean(s!)),
  };
}

export function outputMatches(value: OutputValue | undefined, type: string) {
  if (value === undefined) return false;
  if (type === "money")
    return (
      typeof value === "object" &&
      !Array.isArray(value) &&
      /^-?\d+\.\d{2}$/.test(value.amount) &&
      value.currency === "USD"
    );
  if (type === "table")
    return (
      Array.isArray(value) &&
      value.every((row) =>
        Object.values(row).every((v) => typeof v === "string"),
      )
    );
  if (type === "text") return typeof value === "string" && value.length > 0;
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return type === "boolean" && typeof value === "boolean";
}
export async function extractGeneral(
  page: Page,
  step: CapabilityStep,
  inputs: InputValues,
  secrets: Secrets,
): Promise<{ strategy: string; output: OutputValue }> {
  const { locator, strategy } = await resolveTarget(page, step.target!, inputs);
  // Never collect form values, login surfaces, entire pages, or secret display controls.
  if (
    new URL(page.url()).pathname === "/login" ||
    (await locator.evaluate(
      (e) =>
        e.matches("html,body,input,textarea,select,form,main") ||
        !!e.querySelector('input[type="password"]'),
    ))
  )
    throw new RuntimeCondition(
      "EXTRACTION_DENIED",
      "Extraction must target a specific non-secret displayed field or table",
    );
  if (PRIVATE_LABEL.test(step.target!.description))
    throw new RuntimeCondition(
      "EXTRACTION_DENIED",
      "Direct identity/secret extraction is outside the privacy profile",
    );
  const clean = (s: string) => cleanText(s, inputs, secrets);
  if (step.outputType === "table") {
    if (!step.columns?.length)
      throw new RuntimeCondition(
        "OUTPUT_VALIDATION_FAILED",
        "Table extraction needs explicit column names",
      );
    const table = await locator.evaluate((e) => ({
      tag: e.tagName,
      headers: Array.from(e.querySelectorAll("thead th")).map(
        (h) => h.textContent?.trim() ?? "",
      ),
      rows: Array.from(e.querySelectorAll("tbody tr")).map((r) =>
        Array.from(r.querySelectorAll("td")).map(
          (c) => c.textContent?.replace(/\s+/g, " ").trim() ?? "",
        ),
      ),
    }));
    if (
      table.tag !== "TABLE" ||
      step.columns.some((c) => !table.headers.includes(c))
    )
      throw new RuntimeCondition(
        "OUTPUT_VALIDATION_FAILED",
        "Requested table columns not present",
      );
    if (
      step.columns.some(
        (c) =>
          PRIVATE_LABEL.test(c) ||
          /^(Name|Member #|User|Staff|Details|Description|Note)$/i.test(c),
      )
    )
      throw new RuntimeCondition(
        "EXTRACTION_DENIED",
        "Selected columns contain identity or free-form private data",
      );
    return {
      strategy,
      output: table.rows
        .filter((r) => r.length === table.headers.length)
        .slice(0, 100)
        .map((row) =>
          Object.fromEntries(
            step.columns!.map((c) => [c, clean(row[table.headers.indexOf(c)])]),
          ),
        ),
    };
  }
  const raw = (await locator.innerText()).trim();
  const field = await locator.evaluate((e) => ({
    tag: e.tagName,
    label:
      e.tagName === "DD"
        ? e.previousElementSibling?.textContent
        : e.parentElement?.querySelector(".account-balances__label")
            ?.textContent,
    balance: e.classList.contains("account-balances__value"),
  }));
  if (!/^H[1-6]$/.test(field.tag) && field.tag !== "DD" && !field.balance)
    throw new RuntimeCondition(
      "EXTRACTION_DENIED",
      "Text extraction requires a heading, labeled definition value or account balance; use explicit columns for a table",
    );
  if (PRIVATE_LABEL.test(field.label ?? ""))
    throw new RuntimeCondition(
      "EXTRACTION_DENIED",
      "The displayed field contains private identity data",
    );
  if (raw.length > 8000 || /\b\d{3}-\d{2}-\d{4}\b/.test(raw))
    throw new RuntimeCondition(
      "EXTRACTION_DENIED",
      "Extraction exceeds the privacy or size boundary",
    );
  let output: OutputValue = clean(raw);
  if (step.outputType === "number") {
    output = Number(raw.replaceAll(",", ""));
    if (!raw || !Number.isFinite(output))
      throw new RuntimeCondition(
        "OUTPUT_VALIDATION_FAILED",
        "Expected numeric text",
      );
  }
  if (step.outputType === "boolean") {
    if (!/^(yes|no|true|false|enabled|disabled)$/i.test(raw))
      throw new RuntimeCondition(
        "OUTPUT_VALIDATION_FAILED",
        "Expected boolean text",
      );
    output = /^(yes|true|enabled)$/i.test(raw);
  }
  if ((step.outputType ?? "money") === "money") {
    const m = raw.match(/^(-?)\$([\d,]+\.\d{2})$/);
    if (!m)
      throw new RuntimeCondition(
        "OUTPUT_VALIDATION_FAILED",
        "Expected a single USD value",
      );
    output = { amount: m[1] + m[2].replaceAll(",", ""), currency: "USD" };
  }
  return { strategy, output };
}
