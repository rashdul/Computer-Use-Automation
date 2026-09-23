import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, FilePlus2, ListChecks, Printer } from "lucide-react";
import { useEffect, useRef } from "react";
import { useParams } from "react-router";
import { Button, ButtonLink } from "../../components/Button";
import { CopyButton, DL, Panel } from "../../components/display";
import { LoadError, SkeletonLines, SlowNotice, StatePage } from "../../components/feedback";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { date, dateTime, money } from "../../lib/format";
import { DIVIDEND_OPTION, FUNDING_METHOD, MATURITY_OPTION, SIGNATURE_METHOD } from "../../lib/labels";
import type { OpeningReceipt } from "../../lib/types";
import { keys } from "../queries";
import { PermissionDenied } from "../StatePages";
import { FlowHeader } from "./OpenSubAccountPage";

export function ConfirmationPage() {
  const { memberNumber = "", confirmation = "" } = useParams();
  useDocumentTitle(`Sub-account opened · ${confirmation}`);
  const q = useQuery({ queryKey: keys.opening(confirmation), queryFn: () => api.opening(confirmation), staleTime: Infinity });
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (q.data) headingRef.current?.focus();
  }, [q.data]);

  if (q.isPending) {
    return (
      <div className="page">
        <FlowHeader step={3} title="Sub-account opened" />
        <SlowNotice active what="the receipt" />
        <div className="panel panel__body">
          <SkeletonLines lines={10} />
        </div>
      </div>
    );
  }
  if (q.isError) {
    if (isApiError(q.error) && q.error.kind === "permission_denied") return <PermissionDenied error={q.error} />;
    if (isApiError(q.error) && q.error.kind === "not_found") {
      return (
        <div className="page">
          <StatePage
            tone="warn"
            code="Error 404 · Confirmation not found"
            title="No account opening matches this confirmation number"
            actions={
              <ButtonLink to={`/members/${memberNumber}/accounts`} variant="primary">
                View the member's accounts
              </ButtonLink>
            }
          >
            <span className="mono">{confirmation}</span> doesn't match an account opening. Check the number on the printed receipt.
          </StatePage>
        </div>
      );
    }
    return (
      <div className="page">
        <LoadError error={q.error} onRetry={() => q.refetch()} what="the receipt" />
      </div>
    );
  }

  const r = q.data;
  return (
    <div className="page">
      <div className="no-print">
        <FlowHeader step={3} title="Sub-account opened" subtitle="The account is open and funded. Give the member their receipt and disclosures." />
      </div>
      <div className="flow-layout">
        <Receipt r={r} headingRef={headingRef} />
        <aside className="flow-aside stack no-print" aria-label="Next steps">
          <Panel title="Next steps" icon={<ListChecks size={15} aria-hidden="true" />}>
            <ul className="next-steps">
              {nextSteps(r).map((s) => (
                <li key={s}>
                  <ArrowRight size={14} aria-hidden="true" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </Panel>
          <div className="stack stack--sm">
            <ButtonLink to={`/members/${r.member.member_number}/accounts/${r.account.account_number}`} variant="primary" block iconAfter={<ArrowRight size={15} aria-hidden="true" />}>
              View account
            </ButtonLink>
            <Button block icon={<Printer size={15} aria-hidden="true" />} onClick={() => window.print()}>
              Print receipt
            </Button>
            <ButtonLink to={`/members/${r.member.member_number}/accounts/new`} block icon={<FilePlus2 size={15} aria-hidden="true" />}>
              Open another sub-account
            </ButtonLink>
            <ButtonLink to={`/members/${r.member.member_number}`} variant="ghost" block>
              Back to member overview
            </ButtonLink>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Receipt({ r, headingRef }: { r: OpeningReceipt; headingRef: React.Ref<HTMLHeadingElement> }) {
  const a = r.account;
  const joint = a.parties.filter((p) => p.role === "joint");
  const bens = a.parties.filter((p) => p.role === "beneficiary");
  const opened = new Date(r.opened_at);
  const stampDate = opened
    .toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/New_York" })
    .replace(",", "")
    .toUpperCase();
  const stampTime = opened.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });

  return (
    <section className="panel receipt" aria-labelledby="receipt-title">
      <div className="receipt__head">
        <div className="receipt__title">
          <div className="receipt__check">
            <CircleCheck size={20} aria-hidden="true" />
          </div>
          <div>
            <h2 id="receipt-title" ref={headingRef} tabIndex={-1} style={{ outline: "none" }}>
              {r.product.name} opened
            </h2>
            <p>
              <span className="receipt__account">{a.account_number}</span> for {r.member.full_name}
            </p>
            <p style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <span className="subtle">Confirmation</span>
              <span className="receipt__confirm">{r.confirmation_number}</span>
              <CopyButton text={r.confirmation_number} label="Copy confirmation number" />
            </p>
          </div>
        </div>
        <div className="stamp" aria-label={`Opened ${stampDate} ${stampTime} Eastern at ${r.opened_by.workstation}`}>
          <span className="stamp__word">Opened</span>
          <span className="stamp__line">
            {stampDate} · {stampTime} ET
          </span>
          <span className="stamp__line">
            {r.branch.code} · {r.opened_by.workstation}
          </span>
        </div>
      </div>

      {r.idempotent_replay && (
        <div style={{ padding: "12px 24px 0" }}>
          <p className="banner banner--info" role="status">
            This application was already submitted, so no second account was opened. This is the original receipt.
          </p>
        </div>
      )}

      <div className="receipt__grid">
        <DL
          items={[
            ["Account number", <span className="mono">{a.account_number}</span>],
            ["Product", r.product.name],
            ["Rate", a.rate === null ? "—" : `${a.rate.toFixed(2)}% APY`],
            ...(a.term_months
              ? ([
                  ["Term", `${a.term_months} months`],
                  ["Maturity date", date(a.maturity_date)],
                  ["At maturity", a.maturity_option ? MATURITY_OPTION[a.maturity_option] : "—"],
                  ["Dividends", a.dividend_disposition ? DIVIDEND_OPTION[a.dividend_disposition] : "—"],
                ] as [string, string][])
              : []),
            ...(a.nickname ? ([["Nickname", `“${a.nickname}”`]] as [string, string][]) : []),
            ["Statements", a.statement_delivery === "electronic" ? "Electronic" : "Paper (mailed)"],
            "sep",
            ["Primary owner", `${r.member.full_name} (${r.member.member_number})`],
            ["Joint owners", joint.length ? joint.map((j) => `${j.name}${j.member_number ? ` (${j.member_number})` : ""}`).join(", ") : "None"],
            ["Beneficiaries", bens.length ? bens.map((b) => `${b.name} · ${b.percent}%`).join("; ") : "None"],
          ]}
        />
        <DL
          items={[
            ["Opening deposit", <strong className="num">{money(r.initial_deposit)}</strong>],
            [
              "Funded by",
              r.funding.method === "transfer" ? (
                <>
                  Transfer from <span className="mono">{r.funding.source_account_number}</span>
                  <span className="subtle"> · {r.funding.source_product_name}</span>
                </>
              ) : r.funding.method === "check" ? (
                <>
                  Check <span className="mono">#{r.funding.check_number}</span>
                </>
              ) : (
                FUNDING_METHOD[r.funding.method]
              ),
            ],
            ["Available now", <span className="num">{money(a.available_balance)}</span>],
            ...(a.hold_amount > 0 ? ([["On hold (Reg CC)", <span className="num">{money(a.hold_amount)}</span>]] as [string, React.ReactNode][]) : []),
            "sep",
            ["Opened", dateTime(r.opened_at) + " ET"],
            ["Opened by", `${r.opened_by.name} (${r.opened_by.username})`],
            ["Branch", `${r.branch.code} · ${r.branch.name}`],
            ["Signature", SIGNATURE_METHOD[r.signature_method]],
            ["Disclosures", <span className="mono" style={{ fontSize: 11.5 }}>{r.disclosures.join(", ")}</span>],
          ]}
        />
      </div>
    </section>
  );
}

function nextSteps(r: OpeningReceipt): string[] {
  const steps = ["Give the member copies of the disclosures they acknowledged."];
  const a = r.account;
  if (a.category === "certificate" && a.maturity_date) steps.push(`A maturity notice mails 30 days before ${date(a.maturity_date)}.`);
  if (a.category === "share_draft" && a.debit_card_ordered) steps.push("The Visa debit card mails in 7–10 business days; the PIN mails separately.");
  if (a.hold_amount > 0) steps.push(`${money(a.hold_amount)} of the check is on hold until the next business day.`);
  if (a.statement_delivery === "electronic") steps.push("The first e-statement arrives at the end of the month.");
  if (a.parties.some((p) => p.role === "joint") && r.signature_method !== "e_sign") {
    steps.push("Joint owners sign the signature card at their next visit.");
  }
  if (r.funding.method === "transfer") steps.push(`The transfer already posted to ${r.funding.source_account_number}.`);
  return steps;
}
