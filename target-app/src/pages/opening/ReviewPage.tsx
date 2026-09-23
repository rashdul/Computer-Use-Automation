import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, Copy, FileCheck2, Pencil, ShieldCheck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { Button } from "../../components/Button";
import { Badge, DL, Panel } from "../../components/display";
import { Banner, LoadError } from "../../components/feedback";
import { Check } from "../../components/form";
import { Modal } from "../../components/Modal";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { api } from "../../lib/api";
import { isApiError, type ApiError, type FieldError } from "../../lib/errors";
import { date, money, parseMoney } from "../../lib/format";
import {
  DIVIDEND_OPTION,
  EXPECTED_DEPOSITS,
  FUNDING_METHOD,
  KYC,
  MATURITY_OPTION,
  SIGNATURE_METHOD,
  SOURCE_OF_FUNDS,
} from "../../lib/labels";
import type { OpenContext } from "../../lib/types";
import { keys } from "../queries";
import { PermissionDenied } from "../StatePages";
import { clearDraft, sectionOf, selectedProduct, toRequest, useDraft, validateForm, validateReview } from "./draft";
import { FlowHeader, OpenContextGate, useOpenContext } from "./OpenSubAccountPage";

export function ReviewPage() {
  const { memberNumber = "" } = useParams();
  useDocumentTitle(`Review sub-account · ${memberNumber}`);
  const query = useOpenContext(memberNumber);
  return (
    <OpenContextGate memberNumber={memberNumber} query={query}>
      {(ctx) => <Review memberNumber={memberNumber} ctx={ctx} />}
    </OpenContextGate>
  );
}

interface DuplicateDetails {
  product_name: string;
  existing: { account_number: string; nickname: string | null; current_balance: number; opened_on: string }[];
}

function Review({ memberNumber, ctx }: { memberNumber: string; ctx: OpenContext }) {
  const { draft, update } = useDraft(memberNumber);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const product = selectedProduct(draft, ctx);
  const formErrors = useMemo(() => validateForm(draft, ctx), [draft, ctx]);
  const [reviewErrors, setReviewErrors] = useState<FieldError[]>([]);
  const [duplicate, setDuplicate] = useState<DuplicateDetails | null>(null);
  const [denied, setDenied] = useState<ApiError | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const formUrl = `/members/${memberNumber}/accounts/new`;

  const submit = useMutation({
    mutationFn: (confirmDuplicate: boolean) => api.openSubAccount(toRequest(draft, memberNumber, confirmDuplicate)),
    onSuccess: (receipt) => {
      clearDraft(memberNumber);
      qc.setQueryData(keys.opening(receipt.confirmation_number), receipt);
      void qc.invalidateQueries({ queryKey: keys.member(memberNumber) });
      void qc.invalidateQueries({ queryKey: ["member-accounts", memberNumber] });
      void qc.invalidateQueries({ queryKey: keys.openContext(memberNumber) });
      navigate(`/members/${memberNumber}/accounts/new/confirmation/${receipt.confirmation_number}`, { replace: true });
    },
    onError: (e) => {
      setDuplicate(null);
      if (isApiError(e) && e.kind === "permission_denied") return setDenied(e);
      if (isApiError(e) && e.kind === "validation") {
        update({ serverErrors: e.fields });
        setReviewErrors(e.fields);
      }
      if (isApiError(e) && e.kind === "conflict" && e.rule === "duplicate_product") {
        setDuplicate(e.details as DuplicateDetails);
        return;
      }
      window.setTimeout(() => errorRef.current?.focus(), 0);
    },
  });

  if (!draft.touched || !draft.productCode) return <Navigate to={formUrl} replace />;
  if (denied) return <PermissionDenied error={denied} subject="Open a sub-account" />;

  const open = (confirmDuplicate = false) => {
    const found = validateReview(draft, ctx);
    setReviewErrors(found);
    if (found.length || formErrors.length) {
      window.setTimeout(() => errorRef.current?.focus(), 0);
      return;
    }
    submit.mutate(confirmDuplicate);
  };

  const err = (f: string) => reviewErrors.find((e) => e.field === f)?.message;
  const amount = draft.fundingMethod === "none" ? 0 : parseMoney(draft.amount) ?? 0;
  const source = ctx.funding_accounts.find((f) => f.account_number === draft.sourceAccount);
  const jointNames = draft.jointMemberNumbers.map(
    (n) =>
      ctx.joint_candidates.find((c) => c.member_number === n)?.display_name ??
      draft.extraJoint.find((x) => x.member_number === n)?.display_name ??
      n,
  );
  const disclosures = (product?.disclosures ?? []).map((code) => ctx.disclosure_catalog.find((d) => d.code === code) ?? { code, title: code, revised: "" });
  const businessError = isApiError(submit.error) && submit.error.kind === "conflict" && submit.error.rule === "member_ineligible" ? submit.error : null;
  const serverFieldErrors = isApiError(submit.error) && submit.error.kind === "validation" ? submit.error.fields : [];
  const transient =
    submit.error && isApiError(submit.error) && ["timeout", "unavailable", "network", "server"].includes(submit.error.kind) ? submit.error : null;
  const checkHold = draft.fundingMethod === "check" && amount > 225 ? amount - 225 : 0;
  const blockingFormErrors = [...formErrors, ...serverFieldErrors.filter((s) => !["disclosures", "signature_method"].includes(s.field))];

  const Edit = ({ section }: { section: string }) => (
    <Link to={`${formUrl}#${section}`} className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--fs-sm)" }}>
      <Pencil size={12} aria-hidden="true" /> Edit
    </Link>
  );

  return (
    <div className="page">
      <FlowHeader step={2} title="Review and open" subtitle={<>Confirm the details with {ctx.member.full_name} before opening the account.</>} />

      <div ref={errorRef} tabIndex={-1} style={{ outline: "none" }}>
        {blockingFormErrors.length > 0 && (
          <div className="error-summary">
            <Banner tone="bad" live title="Some details need changes before the account can be opened">
              <ul>
                {blockingFormErrors.map((e) => (
                  <li key={e.field + e.message}>
                    <Link to={`${formUrl}#${sectionOf(e.field)}`}>{e.message}</Link>
                  </li>
                ))}
              </ul>
            </Banner>
          </div>
        )}
        {businessError && (
          <div className="error-summary">
            <Banner tone="bad" live title="The member isn't eligible for new accounts right now">
              <ul>
                {((businessError.details as { issues?: { message: string }[] })?.issues ?? []).map((i) => (
                  <li key={i.message}>{i.message}</li>
                ))}
              </ul>
            </Banner>
          </div>
        )}
        {transient && (
          <div className="error-summary">
            <LoadError error={transient} onRetry={() => open(false)} what="a response from the core system" />
            <p className="subtle" style={{ marginTop: 6, fontSize: "var(--fs-sm)" }}>
              It's safe to try again: this application has a request ID, so a repeat submission returns the original account instead of
              opening a second one.
            </p>
          </div>
        )}
      </div>

      <div className="flow-layout">
        <div className="stack">
          <Panel title="Application" icon={<FileCheck2 size={15} aria-hidden="true" />} flush>
            <section className="review-section" aria-labelledby="rv-product">
              <div className="review-section__head">
                <h3 id="rv-product">Product</h3>
                <Edit section="section-product" />
              </div>
              <DL
                wide
                items={[
                  ["Product", product?.name ?? "—"],
                  ["New account number", <span className="mono">{product?.eligibility.next_suffix ? `${memberNumber}-${product.eligibility.next_suffix}` : "—"}</span>],
                  ["Rate", product?.rate != null ? `${product.rate.toFixed(2)}% APY` : "—"],
                  ...(product?.term_months
                    ? ([
                        ["Term", `${product.term_months} months`],
                        ["At maturity", MATURITY_OPTION[draft.maturityOption] ?? "—"],
                        ["Dividends", DIVIDEND_OPTION[draft.dividendDisposition] ?? "—"],
                      ] as [string, string][])
                    : []),
                  ...(product?.category === "share_draft"
                    ? ([
                        ["Overdraft protection", draft.overdraftSource || "None"],
                        ["Debit card", draft.orderDebitCard ? "Order a Visa debit card" : "No card"],
                      ] as [string, string][])
                    : []),
                  ["Nickname", draft.nickname || <span className="subtle">None</span>],
                ]}
              />
            </section>
            <section className="review-section" aria-labelledby="rv-owners">
              <div className="review-section__head">
                <h3 id="rv-owners">Ownership</h3>
                <Edit section="section-ownership" />
              </div>
              <DL
                wide
                items={[
                  ["Primary owner", `${ctx.member.full_name} (${memberNumber})`],
                  ["Joint owners", draft.ownershipType === "joint" && jointNames.length ? jointNames.join(", ") : <span className="subtle">None</span>],
                  [
                    "Beneficiaries (POD)",
                    draft.beneficiaries.length ? (
                      draft.beneficiaries.map((b) => (
                        <div key={b.name + b.percent}>
                          {b.name} <span className="subtle">· {b.relationship} · {b.percent}%</span>
                        </div>
                      ))
                    ) : (
                      <span className="subtle">None</span>
                    ),
                  ],
                ]}
              />
            </section>
            <section className="review-section" aria-labelledby="rv-funding">
              <div className="review-section__head">
                <h3 id="rv-funding">Opening deposit</h3>
                <Edit section="section-funding" />
              </div>
              <DL
                wide
                items={[
                  ["Amount", <strong className="num">{money(amount)}</strong>],
                  ["Method", draft.fundingMethod ? FUNDING_METHOD[draft.fundingMethod] : "—"],
                  ...(draft.fundingMethod === "transfer"
                    ? ([
                        [
                          "From",
                          <>
                            <span className="mono">{draft.sourceAccount}</span>{" "}
                            <span className="subtle">
                              · {source?.product_name} · {money(source?.available_balance)} available now
                            </span>
                          </>,
                        ],
                      ] as [string, React.ReactNode][])
                    : []),
                  ...(draft.fundingMethod === "check" ? ([["Check number", <span className="mono">{draft.checkNumber}</span>]] as [string, React.ReactNode][]) : []),
                ]}
              />
            </section>
            <section className="review-section" aria-labelledby="rv-other">
              <div className="review-section__head">
                <h3 id="rv-other">Statements & purpose</h3>
                <Edit section="section-compliance" />
              </div>
              <DL
                wide
                items={[
                  ["Statements", draft.statementDelivery === "electronic" ? `Electronic · ${ctx.member.email_masked ?? "no email"}` : "Paper · mailed"],
                  ["Purpose", draft.purpose || "—"],
                  ["Expected deposits", EXPECTED_DEPOSITS[draft.expectedDeposits] ?? "—"],
                  ["Source of funds", SOURCE_OF_FUNDS[draft.sourceOfFunds] ?? "—"],
                ]}
              />
            </section>
          </Panel>

          <Panel title="Disclosures & signature" icon={<ShieldCheck size={15} aria-hidden="true" />}>
            <div className="stack">
              <fieldset style={{ border: 0, margin: 0, padding: 0 }} aria-describedby={err("disclosures") ? "disc-error" : undefined}>
                <legend className="field__label" style={{ padding: 0, marginBottom: 8 }}>
                  The member received
                </legend>
                <div className="disclosures">
                  {disclosures.map((d) => (
                    <Check
                      key={d.code}
                      label={d.title}
                      hint={`${d.code}${d.revised ? ` · revised ${d.revised}` : ""}`}
                      checked={draft.disclosures.includes(d.code)}
                      onChange={(e) =>
                        update({ disclosures: e.target.checked ? [...draft.disclosures, d.code] : draft.disclosures.filter((c) => c !== d.code) })
                      }
                    />
                  ))}
                </div>
                {err("disclosures") && (
                  <span className="field__error" id="disc-error" style={{ marginTop: 8 }}>
                    <CircleAlert size={13} aria-hidden="true" />
                    {err("disclosures")}
                  </span>
                )}
              </fieldset>
              <div className="divider" style={{ margin: 0 }} />
              <fieldset style={{ border: 0, margin: 0, padding: 0 }} aria-describedby={err("signature_method") ? "sig-error" : undefined}>
                <legend className="field__label" style={{ padding: 0, marginBottom: 8 }}>
                  Member signature
                </legend>
                <div className="stack stack--sm" style={{ gap: 8 }}>
                  {Object.entries(SIGNATURE_METHOD).map(([value, label]) => (
                    <Check key={value} type="radio" name="signature" label={label} checked={draft.signatureMethod === value} onChange={() => update({ signatureMethod: value })} />
                  ))}
                </div>
                {err("signature_method") && (
                  <span className="field__error" id="sig-error" style={{ marginTop: 8 }}>
                    <CircleAlert size={13} aria-hidden="true" />
                    {err("signature_method")}
                  </span>
                )}
              </fieldset>
            </div>
          </Panel>

          {checkHold > 0 && (
            <Banner tone="warn" title="Part of this deposit will be on hold">
              {money(checkHold)} of the check will be available the next business day under Regulation CC. The first $225.00 is available now.
            </Banner>
          )}

          <div className="toolbar">
            <Button icon={<ArrowLeft size={15} aria-hidden="true" />} onClick={() => navigate(formUrl)} disabled={submit.isPending}>
              Back to edit
            </Button>
            <span className="toolbar__spacer" />
            <Button variant="primary" size="lg" onClick={() => open(false)} loading={submit.isPending} loadingText="Opening account…">
              Open account
            </Button>
          </div>
        </div>

        <aside className="flow-aside stack" aria-label="Summary">
          <Panel title="You're opening" flush>
            <dl className="summary-list">
              <div>
                <dt>Account</dt>
                <dd className="mono">{product?.eligibility.next_suffix ? `${memberNumber}-${product.eligibility.next_suffix}` : "—"}</dd>
              </div>
              <div>
                <dt>Product</dt>
                <dd>{product?.name}</dd>
              </div>
              <div>
                <dt>Opening deposit</dt>
                <dd className="num">{money(amount)}</dd>
              </div>
              {product?.term_months && (
                <div>
                  <dt>Matures</dt>
                  <dd>{date(addMonthsIso(product.term_months))}</dd>
                </div>
              )}
            </dl>
          </Panel>
          <Panel title="Screening">
            <div className="screening">
              <div className="screening__row">
                <span>OFAC</span>
                <Badge tone={ctx.screening.ofac === "clear" ? "ok" : "bad"}>{ctx.screening.ofac === "clear" ? "Clear" : "Review required"}</Badge>
              </div>
              <div className="screening__row">
                <span>Identity (CIP)</span>
                <Badge tone={KYC[ctx.screening.cip].tone}>{KYC[ctx.screening.cip].label}</Badge>
              </div>
            </div>
          </Panel>
          <p className="subtle" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.5 }}>
            Request ID <span className="mono">{draft.requestId.slice(0, 8)}</span> · resubmitting this application can't open a duplicate account.
          </p>
        </aside>
      </div>

      <Modal
        open={duplicate !== null}
        onClose={() => setDuplicate(null)}
        tone="warn"
        icon={<Copy size={16} aria-hidden="true" />}
        title={`Member already has a ${duplicate?.product_name ?? "product like this"}`}
        footer={
          <>
            <Button onClick={() => setDuplicate(null)} autoFocus>
              Cancel
            </Button>
            <Button variant="primary" loading={submit.isPending} loadingText="Opening…" onClick={() => open(true)}>
              Open another
            </Button>
          </>
        }
      >
        <p>Opening another one is allowed. Confirm the member wants a separate account:</p>
        <ul style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {duplicate?.existing?.map((x) => (
            <li key={x.account_number}>
              <span className="mono">{x.account_number}</span> {x.nickname && `“${x.nickname}”`} · {money(x.current_balance)} · opened {date(x.opened_on)}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function addMonthsIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
