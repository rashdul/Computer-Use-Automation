import { useCallback, useEffect, useState } from "react";
import type { FieldError } from "../../lib/errors";
import { parseMoney } from "../../lib/format";
import type { OpenAccountRequest, OpenContext, OpenContextProduct } from "../../lib/types";

export interface Beneficiary {
  name: string;
  relationship: string;
  percent: string;
}

export interface OpenDraft {
  productCode: string;
  nickname: string;
  ownershipType: "individual" | "joint";
  jointMemberNumbers: string[];
  /** Joint owners added by member number (not in the member's relationships). */
  extraJoint: { member_number: string; display_name: string }[];
  beneficiaries: Beneficiary[];
  fundingMethod: "" | "transfer" | "cash" | "check" | "none";
  amount: string;
  sourceAccount: string;
  checkNumber: string;
  maturityOption: string;
  dividendDisposition: string;
  overdraftSource: string;
  orderDebitCard: boolean;
  statementDelivery: "" | "electronic" | "paper";
  purpose: string;
  expectedDeposits: string;
  sourceOfFunds: string;
  disclosures: string[];
  signatureMethod: string;
  requestId: string;
  serverErrors: FieldError[];
  touched: boolean;
}

export function emptyDraft(): OpenDraft {
  return {
    productCode: "",
    nickname: "",
    ownershipType: "individual",
    jointMemberNumbers: [],
    extraJoint: [],
    beneficiaries: [],
    fundingMethod: "",
    amount: "",
    sourceAccount: "",
    checkNumber: "",
    maturityOption: "",
    dividendDisposition: "",
    overdraftSource: "",
    orderDebitCard: true,
    statementDelivery: "",
    purpose: "",
    expectedDeposits: "",
    sourceOfFunds: "",
    disclosures: [],
    signatureMethod: "",
    requestId: crypto.randomUUID(),
    serverErrors: [],
    touched: false,
  };
}

const DRAFT_PREFIX = "rfcu.console.open-draft.";
const storageKey = (memberNumber: string) => `${DRAFT_PREFIX}${memberNumber}`;

/** Drops every application draft in this tab (sign-out, or a different user signing in). */
export function clearAllDrafts() {
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i);
    if (key?.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(key);
  }
}

export function loadDraft(memberNumber: string): OpenDraft | null {
  try {
    const raw = sessionStorage.getItem(storageKey(memberNumber));
    return raw ? { ...emptyDraft(), ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

export function clearDraft(memberNumber: string) {
  sessionStorage.removeItem(storageKey(memberNumber));
}

/** Application draft for one member, persisted per browser tab. */
export function useDraft(memberNumber: string) {
  const [draft, setDraftState] = useState<OpenDraft>(() => loadDraft(memberNumber) ?? emptyDraft());

  // persist synchronously so a change made just before navigating is never lost
  const update = useCallback(
    (patch: Partial<OpenDraft>) => {
      setDraftState((d) => {
        const changed = Object.keys(patch);
        // editing a field clears the server's error for it
        const serverErrors =
          "serverErrors" in patch
            ? (patch.serverErrors ?? [])
            : d.serverErrors.filter((e) => !changed.some((k) => fieldFor(k).some((f) => e.field.startsWith(f))));
        const next = { ...d, ...patch, serverErrors, touched: true };
        sessionStorage.setItem(storageKey(memberNumber), JSON.stringify(next));
        return next;
      });
    },
    [memberNumber],
  );

  useEffect(() => {
    setDraftState(loadDraft(memberNumber) ?? emptyDraft());
  }, [memberNumber]);

  const reset = useCallback(() => {
    clearDraft(memberNumber);
    setDraftState(emptyDraft());
  }, [memberNumber]);

  return { draft, update, reset };
}

/** Draft property → request field(s) it feeds. */
function fieldFor(key: string): string[] {
  const map: Record<string, string[]> = {
    productCode: ["product_code"],
    nickname: ["nickname"],
    ownershipType: ["ownership"],
    jointMemberNumbers: ["ownership"],
    extraJoint: ["ownership"],
    beneficiaries: ["beneficiaries"],
    fundingMethod: ["funding"],
    amount: ["funding.amount"],
    sourceAccount: ["funding.source_account_number", "funding.amount"],
    checkNumber: ["funding.check_number"],
    maturityOption: ["certificate.maturity_option"],
    dividendDisposition: ["certificate.dividend_disposition"],
    overdraftSource: ["checking"],
    statementDelivery: ["statement_delivery"],
    purpose: ["compliance.purpose"],
    expectedDeposits: ["compliance.expected_monthly_deposits"],
    sourceOfFunds: ["compliance.source_of_funds"],
    disclosures: ["disclosures"],
    signatureMethod: ["signature_method"],
  };
  return map[key] ?? [];
}

export function selectedProduct(draft: OpenDraft, ctx: OpenContext): OpenContextProduct | undefined {
  return ctx.products.find((p) => p.code === draft.productCode);
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Mirrors the server's rules so problems surface before submission. */
export function validateForm(d: OpenDraft, ctx: OpenContext): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });
  const p = selectedProduct(d, ctx);

  if (!p) add("product_code", "Choose a product.");
  else if (!p.eligibility.eligible) add("product_code", `${p.name}: ${p.eligibility.reason}.`);

  if (d.nickname && (d.nickname.length > 30 || !/^[A-Za-z0-9 '&.,()-]+$/.test(d.nickname))) {
    add("nickname", "Use up to 30 letters, numbers, spaces, and basic punctuation.");
  }

  if (d.ownershipType === "joint" && d.jointMemberNumbers.length === 0) {
    add("ownership.joint_member_numbers", "Choose at least one joint owner.");
  }
  if (d.jointMemberNumbers.length > 3) add("ownership.joint_member_numbers", "A sub-account can have at most 3 joint owners.");

  if (d.beneficiaries.length) {
    let total = 0;
    let bad = false;
    d.beneficiaries.forEach((b, i) => {
      if (b.name.trim().length < 2) add(`beneficiaries.${i}.name`, "Enter the beneficiary's full name.");
      if (!b.relationship) add(`beneficiaries.${i}.relationship`, "Choose a relationship.");
      const pct = Number(b.percent);
      if (!b.percent || !Number.isFinite(pct) || pct <= 0 || pct > 100 || Math.round(pct * 100) !== pct * 100) {
        add(`beneficiaries.${i}.percent`, "Enter a share between 0.01 and 100.");
        bad = true;
      } else total += pct;
    });
    if (!bad && Math.abs(total - 100) > 0.001) add("beneficiaries", `Beneficiary shares must add up to 100%. They add up to ${total.toFixed(2)}%.`);
  }

  const amount = parseMoney(d.amount);
  if (!d.fundingMethod) add("funding.method", "Choose how the account will be funded.");
  else if (d.fundingMethod === "none") {
    if (p && p.min_opening_deposit > 0) add("funding.method", `${p.name} needs an opening deposit of at least ${money(p.min_opening_deposit)}.`);
  } else {
    if (amount === null || amount <= 0) add("funding.amount", "Enter a dollar amount, like 250.00.");
    else if (amount > 1_000_000) add("funding.amount", "Opening deposits over $1,000,000.00 need treasury approval.");
    else if (p && amount < p.min_opening_deposit) add("funding.amount", `Minimum opening deposit for ${p.name} is ${money(p.min_opening_deposit)}.`);

    if (d.fundingMethod === "transfer") {
      const src = ctx.funding_accounts.find((f) => f.account_number === d.sourceAccount);
      if (!src) add("funding.source_account_number", "Choose the account to transfer from.");
      else if (amount !== null && amount > 0 && amount > src.transferable) {
        add(
          "funding.amount",
          src.available_balance < amount
            ? `Available balance in ${src.account_number} is ${money(src.available_balance)}.`
            : `${src.account_number} must keep its ${money(src.min_balance)} minimum balance. You can transfer up to ${money(src.transferable)}.`,
        );
      }
    }
    if (d.fundingMethod === "cash" && amount !== null && amount > 10_000) {
      add("funding.amount", "Cash over $10,000.00 needs a Currency Transaction Report. Accept it at a teller station instead.");
    }
    if (d.fundingMethod === "check" && !/^\d{3,10}$/.test(d.checkNumber.trim())) add("funding.check_number", "Enter the 3–10 digit check number.");
  }

  if (p?.category === "certificate") {
    if (!d.maturityOption) add("certificate.maturity_option", "Choose what happens at maturity.");
    if (!d.dividendDisposition) add("certificate.dividend_disposition", "Choose how dividends are paid.");
  }

  if (!d.statementDelivery) add("statement_delivery", "Choose electronic or paper statements.");
  else if (d.statementDelivery === "electronic" && !ctx.member.has_email) {
    add("statement_delivery", "No email address on file. Choose paper statements or update the member's email first.");
  }

  if (!d.purpose) add("compliance.purpose", "Choose the purpose of the account.");
  if (!d.expectedDeposits) add("compliance.expected_monthly_deposits", "Choose the expected monthly deposits.");
  if (!d.sourceOfFunds) add("compliance.source_of_funds", "Choose the source of funds.");

  return errors;
}

export function validateReview(d: OpenDraft, ctx: OpenContext): FieldError[] {
  const errors: FieldError[] = [];
  const p = selectedProduct(d, ctx);
  if (p && p.disclosures.some((code) => !d.disclosures.includes(code))) {
    errors.push({ field: "disclosures", message: "Confirm the member received every required disclosure." });
  }
  if (!d.signatureMethod) errors.push({ field: "signature_method", message: "Record how the member signed." });
  return errors;
}

export function toRequest(d: OpenDraft, memberNumber: string, confirmDuplicate: boolean): OpenAccountRequest {
  const amount = parseMoney(d.amount);
  return {
    client_request_id: d.requestId,
    member_number: memberNumber,
    product_code: d.productCode,
    nickname: d.nickname.trim(),
    ownership: { type: d.ownershipType, joint_member_numbers: d.ownershipType === "joint" ? d.jointMemberNumbers : [] },
    beneficiaries: d.beneficiaries.map((b) => ({ name: b.name.trim(), relationship: b.relationship, percent: b.percent })),
    funding: {
      method: (d.fundingMethod || "none") as OpenAccountRequest["funding"]["method"],
      amount: d.fundingMethod === "none" ? "0" : amount === null ? d.amount : amount.toFixed(2),
      source_account_number: d.fundingMethod === "transfer" ? d.sourceAccount : "",
      check_number: d.fundingMethod === "check" ? d.checkNumber.trim() : "",
    },
    certificate: { maturity_option: d.maturityOption, dividend_disposition: d.dividendDisposition },
    checking: { overdraft_source_account_number: d.overdraftSource, order_debit_card: d.orderDebitCard },
    statement_delivery: (d.statementDelivery || "paper") as "electronic" | "paper",
    compliance: { purpose: d.purpose, expected_monthly_deposits: d.expectedDeposits, source_of_funds: d.sourceOfFunds },
    disclosures_acknowledged: d.disclosures,
    signature_method: d.signatureMethod,
    confirm_duplicate_product: confirmDuplicate,
  };
}

/** Which form section a field belongs to (for "Edit" links and error summaries). */
export function sectionOf(field: string): string {
  if (field.startsWith("product_code")) return "section-product";
  if (field.startsWith("nickname") || field.startsWith("certificate") || field.startsWith("checking")) return "section-details";
  if (field.startsWith("ownership")) return "section-ownership";
  if (field.startsWith("beneficiaries")) return "section-beneficiaries";
  if (field.startsWith("funding")) return "section-funding";
  if (field.startsWith("statement")) return "section-statements";
  if (field.startsWith("compliance")) return "section-compliance";
  return "section-product";
}
