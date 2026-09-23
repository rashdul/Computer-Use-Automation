import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleAlert, CircleCheck, Info, Plus, ShieldAlert, Trash2, TriangleAlert, UserPlus } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "../../auth/AuthContext";
import { Button, ButtonLink } from "../../components/Button";
import { Badge, Panel } from "../../components/display";
import { Banner, LoadError, SkeletonLines, SlowNotice, StatePage } from "../../components/feedback";
import { Check, Field, Input, MoneyInput, Select } from "../../components/form";
import { Modal } from "../../components/Modal";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { api } from "../../lib/api";
import { isApiError, type FieldError } from "../../lib/errors";
import { date, money, parseMoney } from "../../lib/format";
import {
  ACCOUNT_PURPOSES,
  BENEFICIARY_RELATIONSHIPS,
  CATEGORY_LABEL,
  DIVIDEND_OPTION,
  EXPECTED_DEPOSITS,
  FUNDING_METHOD,
  KYC,
  MATURITY_OPTION,
  SOURCE_OF_FUNDS,
} from "../../lib/labels";
import type { MemberBrief, OpenContext, ProductCategory } from "../../lib/types";
import { keys } from "../queries";
import { MemberNotFound, PermissionDenied } from "../StatePages";
import { selectedProduct, useDraft, validateForm, type OpenDraft } from "./draft";

export function FlowHeader({ step, title, subtitle }: { step: 1 | 2 | 3; title: string; subtitle?: ReactNode }) {
  const steps = ["Details", "Review", "Confirmation"];
  return (
    <div className="flow-header">
      <div className="page-header__text">
        {/* the member band holds the page's h1 (the member); the flow title sits under it */}
        <h2 className="flow-header__title">{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <ol className="stepper" aria-label="Progress">
        {steps.map((s, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "current" : "todo";
          return (
            <Fragment key={s}>
              {i > 0 && <li className="step__line" aria-hidden="true" />}
              <li className={`step step--${state}`} aria-current={state === "current" ? "step" : undefined}>
                <span className="step__num">{state === "done" ? "✓" : n}</span>
                {s}
                {state === "done" && <span className="sr-only"> (completed)</span>}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}

/** Loads the opening context and handles the page-level outcomes. */
export function useOpenContext(memberNumber: string) {
  return useQuery({ queryKey: keys.openContext(memberNumber), queryFn: () => api.openContext(memberNumber), staleTime: 60_000 });
}

export function OpenContextGate({
  memberNumber,
  query,
  children,
}: {
  memberNumber: string;
  query: ReturnType<typeof useOpenContext>;
  children: (ctx: OpenContext) => ReactNode;
}) {
  if (query.isPending) {
    return (
      <div className="page">
        <FlowHeader step={1} title="Open a sub-account" />
        <div className="stack">
          <SlowNotice active what="products and eligibility" />
          <div className="panel panel__body">
            <SkeletonLines lines={9} />
          </div>
        </div>
      </div>
    );
  }
  if (query.isError) {
    const e = query.error;
    if (isApiError(e) && e.kind === "permission_denied") return <PermissionDenied error={e} subject="Open a sub-account" />;
    if (isApiError(e) && e.kind === "not_found") return <MemberNotFound memberNumber={memberNumber} />;
    return (
      <div className="page">
        <LoadError error={e} onRetry={() => query.refetch()} what="products and eligibility" />
      </div>
    );
  }
  const ctx = query.data;
  if (ctx.blockers.length) {
    return (
      <div className="page">
        <StatePage
          tone="warn"
          code="Account opening unavailable"
          title="New sub-accounts can't be opened for this member"
          facts={
            <ul style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {ctx.blockers.map((b) => (
                <li key={b.code} style={{ display: "flex", gap: 8 }}>
                  <ShieldAlert size={16} style={{ flex: "none", color: "var(--bad-700)", marginTop: 2 }} aria-hidden="true" />
                  <span>{b.message}</span>
                </li>
              ))}
            </ul>
          }
          actions={
            <ButtonLink to={`/members/${memberNumber}`} variant="primary">
              Back to member
            </ButtonLink>
          }
          foot="Resolve the issues above, then start the application again."
        >
          {ctx.member.full_name} ({memberNumber}) has {ctx.blockers.length === 1 ? "an issue that blocks" : `${ctx.blockers.length} issues that block`} account opening.
        </StatePage>
      </div>
    );
  }
  return <>{children(ctx)}</>;
}

export function OpenSubAccountPage() {
  const { memberNumber = "" } = useParams();
  useDocumentTitle(`Open sub-account · ${memberNumber}`);
  const query = useOpenContext(memberNumber);
  return (
    <OpenContextGate memberNumber={memberNumber} query={query}>
      {(ctx) => <OpenForm memberNumber={memberNumber} ctx={ctx} />}
    </OpenContextGate>
  );
}

const CATEGORY_ORDER: ProductCategory[] = ["share", "share_draft", "money_market", "club", "certificate", "ira"];

function OpenForm({ memberNumber, ctx }: { memberNumber: string; ctx: OpenContext }) {
  const navigate = useNavigate();
  const { draft, update, reset } = useDraft(memberNumber);
  const [submitted, setSubmitted] = useState(draft.serverErrors.length > 0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const leavingToReview = useRef(false);
  const { isLeaving } = useAuth();
  const product = selectedProduct(draft, ctx);
  const location = useLocation();

  // "Edit" links from the review step land on the matching section
  useEffect(() => {
    if (!location.hash) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(location.hash.slice(1));
      el?.scrollIntoView({ block: "start" });
    }, 50);
    return () => window.clearTimeout(t);
  }, [location.hash]);

  // live re-validation after the first attempt, derived so it never lags a keystroke
  const errors: FieldError[] = useMemo(() => {
    if (!submitted) return [];
    const local = validateForm(draft, ctx);
    return [...local, ...draft.serverErrors.filter((e) => !local.some((l) => l.field === e.field))];
  }, [draft, ctx, submitted]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (isLeaving() || leavingToReview.current || !draft.touched) return false;
    return currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (!draft.touched) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [draft.touched]);

  const err = (field: string) => errors.find((e) => e.field === field)?.message;

  const cont = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateForm(draft, ctx);
    setSubmitted(true);
    if (found.length) {
      window.setTimeout(() => summaryRef.current?.focus(), 0);
      return;
    }
    update({ serverErrors: [] });
    leavingToReview.current = true;
    navigate(`/members/${memberNumber}/accounts/new/review`);
  };

  const groups = CATEGORY_ORDER.map((c) => ({ c, products: ctx.products.filter((p) => p.category === c) })).filter((g) => g.products.length);
  const amount = parseMoney(draft.amount);
  const source = ctx.funding_accounts.find((f) => f.account_number === draft.sourceAccount);

  return (
    <div className="page">
      <FlowHeader step={1} title="Open a sub-account" subtitle={<>For {ctx.member.full_name} · member <span className="mono">{memberNumber}</span></>} />

      <form onSubmit={cont} noValidate>
        {submitted && errors.length > 0 && (
          <div ref={summaryRef} tabIndex={-1} className="error-summary" role="alert" aria-labelledby="error-summary-title">
            <Banner tone="bad" title={<span id="error-summary-title">Fix {errors.length === 1 ? "1 problem" : `${errors.length} problems`} to continue</span>}>
              <ul>
                {errors.map((e) => (
                  <li key={e.field + e.message}>
                    <a href={`#${fieldAnchor(e.field)}`}>{e.message}</a>
                  </li>
                ))}
              </ul>
            </Banner>
          </div>
        )}

        <div className="flow-layout">
          <div>
            {/* 1. Product */}
            <section className="panel form-section" id="section-product" aria-labelledby="h-product">
              <div className="form-section__header">
                <h2 id="h-product">Product</h2>
                <p>Rates effective September 2026</p>
              </div>
              <div className="form-section__body">
                <fieldset style={{ border: 0, margin: 0, padding: 0 }} aria-describedby={err("product_code") ? "product-error" : undefined}>
                  <legend className="sr-only">Choose a product</legend>
                  {err("product_code") && (
                    <p className="field__error" id="product-error" style={{ marginBottom: 8 }}>
                      <CircleAlert size={13} aria-hidden="true" />
                      {err("product_code")}
                    </p>
                  )}
                  <div className="option-list" id={fieldAnchor("product_code")}>
                    {groups.map((g) => (
                      <Fragment key={g.c}>
                        <div className="option-group-label">{CATEGORY_LABEL[g.c]}</div>
                        {g.products.map((p) => (
                          <label className="option" key={p.code}>
                            <input
                              type="radio"
                              name="product"
                              value={p.code}
                              checked={draft.productCode === p.code}
                              disabled={!p.eligibility.eligible}
                              aria-labelledby={`product-${p.code}`}
                              aria-describedby={[`product-${p.code}-desc`, !p.eligibility.eligible && `product-${p.code}-reason`, `product-${p.code}-meta`]
                                .filter(Boolean)
                                .join(" ")}
                              onChange={() =>
                                update({
                                  productCode: p.code,
                                  maturityOption: p.category === "certificate" ? draft.maturityOption || "renew" : "",
                                  dividendDisposition: p.category === "certificate" ? draft.dividendDisposition || "compound" : "",
                                })
                              }
                              style={{ width: 15, height: 15, accentColor: "var(--ink-800)" }}
                            />
                            <span>
                              <span className="option__title" id={`product-${p.code}`}>
                                {p.name}
                              </span>
                              <span className="option__desc" id={`product-${p.code}-desc`}>
                                {p.description}
                              </span>
                              {!p.eligibility.eligible && (
                                <span className="option__reason" id={`product-${p.code}-reason`}>
                                  <TriangleAlert size={12} aria-hidden="true" /> Not available: {p.eligibility.reason}
                                </span>
                              )}
                              {p.eligibility.eligible && p.eligibility.existing_count > 0 && (
                                <span className="option__reason" style={{ color: "var(--text-2)" }}>
                                  <Info size={12} aria-hidden="true" /> Member already has {p.eligibility.existing_count}
                                </span>
                              )}
                            </span>
                            <span className="option__meta" id={`product-${p.code}-meta`}>
                              <strong>{p.rate === null ? "—" : `${p.rate.toFixed(2)}% APY`}</strong>
                              {p.min_opening_deposit > 0 ? `Min. ${money(p.min_opening_deposit)}` : "No minimum"}
                              {p.eligibility.next_suffix && p.eligibility.eligible && (
                                <span style={{ display: "block" }} className="mono">
                                  Opens as {p.eligibility.next_suffix}
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                      </Fragment>
                    ))}
                  </div>
                </fieldset>
              </div>
            </section>

            {/* 2. Details */}
            <section className="panel form-section" id="section-details" aria-labelledby="h-details">
              <div className="form-section__header">
                <h2 id="h-details">Account details</h2>
              </div>
              <div className="form-section__body">
                <div className="form-grid">
                  <Field label="Nickname" optional error={err("nickname")} hint="Shown on statements and in online banking">
                    <Input value={draft.nickname} maxLength={30} onChange={(e) => update({ nickname: e.target.value })} placeholder="e.g. Emergency fund" />
                  </Field>
                  <div />
                  {product?.category === "certificate" && (
                    <>
                      <RadioGroup
                        label="At maturity"
                        name="maturity"
                        value={draft.maturityOption}
                        options={Object.entries(MATURITY_OPTION).map(([value, label]) => ({ value, label }))}
                        onChange={(v) => update({ maturityOption: v })}
                        error={err("certificate.maturity_option")}
                        anchor={fieldAnchor("certificate.maturity_option")}
                      />
                      <RadioGroup
                        label="Dividends"
                        name="dividends"
                        value={draft.dividendDisposition}
                        options={Object.entries(DIVIDEND_OPTION).map(([value, label]) => ({ value, label }))}
                        onChange={(v) => update({ dividendDisposition: v })}
                        error={err("certificate.dividend_disposition")}
                        anchor={fieldAnchor("certificate.dividend_disposition")}
                      />
                    </>
                  )}
                  {product?.category === "share_draft" && (
                    <>
                      <Field label="Overdraft protection" optional hint="Covers overdrafts by transferring from savings" error={err("checking.overdraft_source_account_number")}>
                        <Select value={draft.overdraftSource} onChange={(e) => update({ overdraftSource: e.target.value })}>
                          <option value="">No overdraft protection</option>
                          {ctx.funding_accounts
                            .filter((f) => f.category === "share" || f.category === "money_market")
                            .map((f) => (
                              <option key={f.account_number} value={f.account_number}>
                                {f.account_number} · {f.nickname ?? f.product_name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <div style={{ alignSelf: "end", paddingBottom: 6 }}>
                        <Check label="Order a Visa debit card" hint="Mailed in 7–10 business days" checked={draft.orderDebitCard} onChange={(e) => update({ orderDebitCard: e.target.checked })} />
                      </div>
                    </>
                  )}
                  {product && product.category !== "certificate" && product.category !== "share_draft" && (
                    <p className="subtle form-grid__full" style={{ fontSize: "var(--fs-sm)" }}>
                      No other options for {product.name}.
                    </p>
                  )}
                  {!product && (
                    <p className="subtle form-grid__full" style={{ fontSize: "var(--fs-sm)" }}>
                      Choose a product to see its options.
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* 3. Ownership */}
            <OwnershipSection draft={draft} update={update} ctx={ctx} error={err("ownership.joint_member_numbers")} memberNumber={memberNumber} />

            {/* 4. Beneficiaries */}
            <BeneficiariesSection draft={draft} update={update} err={err} />

            {/* 5. Funding */}
            <section className="panel form-section" id="section-funding" aria-labelledby="h-funding">
              <div className="form-section__header">
                <h2 id="h-funding">Opening deposit</h2>
                {product && <p>{product.min_opening_deposit > 0 ? `Minimum ${money(product.min_opening_deposit)}` : "No minimum deposit"}</p>}
              </div>
              <div className="form-section__body">
                <div className="stack stack--sm">
                  <RadioGroup
                    label="Funding method"
                    name="funding"
                    inline
                    value={draft.fundingMethod}
                    options={Object.entries(FUNDING_METHOD).map(([value, label]) => ({ value, label }))}
                    onChange={(v) => update({ fundingMethod: v as OpenDraft["fundingMethod"] })}
                    error={err("funding.method")}
                    anchor={fieldAnchor("funding.method")}
                  />
                  {draft.fundingMethod && draft.fundingMethod !== "none" && (
                    <div className="form-grid">
                      <Field label="Deposit amount" error={err("funding.amount")}>
                        <MoneyInput value={draft.amount} onChange={(v) => update({ amount: v })} placeholder="0.00" id={fieldAnchor("funding.amount")} />
                      </Field>
                      {draft.fundingMethod === "transfer" && (
                        <Field
                          label="Transfer from"
                          error={err("funding.source_account_number")}
                          hint={source ? `Available ${money(source.available_balance)} · can transfer up to ${money(source.transferable)}` : undefined}
                        >
                          <Select value={draft.sourceAccount} onChange={(e) => update({ sourceAccount: e.target.value })}>
                            <option value="">Choose an account…</option>
                            {ctx.funding_accounts.map((f) => (
                              <option key={f.account_number} value={f.account_number}>
                                {f.account_number} · {f.nickname ?? f.product_name} · {money(f.available_balance)} available
                              </option>
                            ))}
                          </Select>
                        </Field>
                      )}
                      {draft.fundingMethod === "check" && (
                        <Field label="Check number" error={err("funding.check_number")} hint="Checks over $225 are partly held until the next business day">
                          <Input mono inputMode="numeric" value={draft.checkNumber} onChange={(e) => update({ checkNumber: e.target.value.replace(/\D/g, "") })} />
                        </Field>
                      )}
                      {draft.fundingMethod === "cash" && (
                        <p className="subtle" style={{ alignSelf: "end", fontSize: "var(--fs-sm)", paddingBottom: 8 }}>
                          Count cash with the member present. Over $10,000 requires a CTR at a teller station.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* 6. Statements */}
            <section className="panel form-section" id="section-statements" aria-labelledby="h-statements">
              <div className="form-section__header">
                <h2 id="h-statements">Statements</h2>
              </div>
              <div className="form-section__body">
                <RadioGroup
                  label="Statement delivery"
                  name="statements"
                  value={draft.statementDelivery}
                  options={[
                    {
                      value: "electronic",
                      label: "Electronic",
                      hint: ctx.member.has_email ? `Emailed to ${ctx.member.email_masked}` : "No email address on file",
                    },
                    { value: "paper", label: "Paper", hint: `Mailed to ${ctx.member.mailing_address}` },
                  ]}
                  onChange={(v) => update({ statementDelivery: v as OpenDraft["statementDelivery"] })}
                  error={err("statement_delivery")}
                  anchor={fieldAnchor("statement_delivery")}
                />
              </div>
            </section>

            {/* 7. Compliance */}
            <section className="panel form-section" id="section-compliance" aria-labelledby="h-compliance">
              <div className="form-section__header">
                <h2 id="h-compliance">Account purpose</h2>
                <p>Required for BSA/CIP customer due diligence</p>
              </div>
              <div className="form-section__body">
                <div className="form-grid form-grid--3">
                  <Field label="Purpose of the account" error={err("compliance.purpose")}>
                    <Select id={fieldAnchor("compliance.purpose")} value={draft.purpose} onChange={(e) => update({ purpose: e.target.value })}>
                      <option value="">Choose…</option>
                      {ACCOUNT_PURPOSES.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Expected monthly deposits" error={err("compliance.expected_monthly_deposits")}>
                    <Select value={draft.expectedDeposits} onChange={(e) => update({ expectedDeposits: e.target.value })}>
                      <option value="">Choose…</option>
                      {Object.entries(EXPECTED_DEPOSITS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Source of funds" error={err("compliance.source_of_funds")}>
                    <Select value={draft.sourceOfFunds} onChange={(e) => update({ sourceOfFunds: e.target.value })}>
                      <option value="">Choose…</option>
                      {Object.entries(SOURCE_OF_FUNDS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
            </section>

            <div className="toolbar" style={{ marginTop: "var(--s-4)" }}>
              <Button onClick={() => navigate(`/members/${memberNumber}`)}>Cancel</Button>
              <span className="toolbar__spacer" />
              <Button type="submit" variant="primary" size="lg" iconAfter={<ArrowRight size={15} aria-hidden="true" />}>
                Continue to review
              </Button>
            </div>
          </div>

          <aside className="flow-aside stack" aria-label="Application summary">
            <Panel title="Summary" flush>
              <dl className="summary-list">
                <div>
                  <dt>Member</dt>
                  <dd>{ctx.member.display_name}</dd>
                </div>
                <div>
                  <dt>Product</dt>
                  <dd>{product?.name ?? <span className="subtle">Not chosen</span>}</dd>
                </div>
                <div>
                  <dt>Account number</dt>
                  <dd className="mono">
                    {product?.eligibility.next_suffix ? `${memberNumber}-${product.eligibility.next_suffix}` : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Rate</dt>
                  <dd>{product?.rate != null ? `${product.rate.toFixed(2)}% APY` : "—"}</dd>
                </div>
                {product?.term_months && (
                  <div>
                    <dt>Matures</dt>
                    <dd>{date(addMonths(product.term_months))}</dd>
                  </div>
                )}
                <div>
                  <dt>Opening deposit</dt>
                  <dd className="num">{draft.fundingMethod === "none" ? money(0) : amount !== null ? money(amount) : "—"}</dd>
                </div>
                <div>
                  <dt>Funding</dt>
                  <dd>
                    {draft.fundingMethod === "transfer" && draft.sourceAccount
                      ? `Transfer from ${draft.sourceAccount.split("-")[1]}`
                      : draft.fundingMethod
                        ? FUNDING_METHOD[draft.fundingMethod].split(" ")[0]
                        : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Ownership</dt>
                  <dd>{draft.ownershipType === "joint" ? `Joint (${draft.jointMemberNumbers.length})` : "Individual"}</dd>
                </div>
              </dl>
            </Panel>
            <Panel title="Screening">
              <div className="screening">
                <div className="screening__row">
                  <span>OFAC</span>
                  <Badge tone={ctx.screening.ofac === "clear" ? "ok" : "bad"}>
                    {ctx.screening.ofac === "clear" ? <CircleCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
                    {ctx.screening.ofac === "clear" ? "Clear" : "Review required"}
                  </Badge>
                </div>
                <div className="screening__row">
                  <span>Identity (CIP)</span>
                  <Badge tone={KYC[ctx.screening.cip].tone}>{KYC[ctx.screening.cip].label}</Badge>
                </div>
                <p className="subtle" style={{ fontSize: "var(--fs-xs)" }}>
                  Screened {date(ctx.screening.screened_at)} against the current SDN list.
                </p>
              </div>
            </Panel>
          </aside>
        </div>
      </form>

      <Modal
        open={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        tone="warn"
        icon={<TriangleAlert size={17} aria-hidden="true" />}
        title="Leave this application?"
        footer={
          <>
            <Button onClick={() => blocker.reset?.()} autoFocus>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                reset();
                blocker.proceed?.();
              }}
            >
              Discard application
            </Button>
          </>
        }
      >
        The details you've entered for {ctx.member.full_name} won't be saved.
      </Modal>
    </div>
  );
}

function addMonths(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Stable DOM ids for error-summary links. */
export function fieldAnchor(field: string): string {
  return `f-${field.replace(/[^a-z0-9]+/gi, "-")}`;
}

interface RadioGroupProps {
  label: string;
  name: string;
  value: string;
  options: { value: string; label: string; hint?: string }[];
  onChange: (value: string) => void;
  error?: string;
  inline?: boolean;
  anchor?: string;
}

function RadioGroup({ label, name, value, options, onChange, error, inline, anchor }: RadioGroupProps) {
  const errorId = `${name}-error`;
  return (
    <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }} aria-describedby={error ? errorId : undefined} id={anchor} tabIndex={-1}>
      <legend className="field__label" style={{ padding: 0, marginBottom: 6 }}>
        {label}
      </legend>
      <div className={inline ? "choice-row" : "stack stack--sm"} style={inline ? undefined : { gap: 8 }}>
        {options.map((o) => (
          <Check key={o.value} type="radio" name={name} label={o.label} hint={o.hint} checked={value === o.value} onChange={() => onChange(o.value)} />
        ))}
      </div>
      {error && (
        <span className="field__error" id={errorId}>
          <CircleAlert size={13} aria-hidden="true" />
          {error}
        </span>
      )}
    </fieldset>
  );
}

function OwnershipSection({
  draft,
  update,
  ctx,
  error,
  memberNumber,
}: {
  draft: OpenDraft;
  update: (p: Partial<OpenDraft>) => void;
  ctx: OpenContext;
  error?: string;
  memberNumber: string;
}) {
  const [lookup, setLookup] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const find = useMutation({
    mutationFn: (n: string) => api.lookupMember(n),
    onSuccess: (m: MemberBrief) => {
      if (!m.eligible) {
        setLookupError(`${m.display_name} (${m.member_number}) can't be a joint owner: ${m.reason?.toLowerCase()}.`);
        return;
      }
      if (m.member_number === memberNumber) {
        setLookupError("The primary member can't also be a joint owner.");
        return;
      }
      if (!draft.jointMemberNumbers.includes(m.member_number)) {
        update({
          jointMemberNumbers: [...draft.jointMemberNumbers, m.member_number],
          extraJoint: ctx.joint_candidates.some((c) => c.member_number === m.member_number)
            ? draft.extraJoint
            : [...draft.extraJoint, { member_number: m.member_number, display_name: m.display_name }],
        });
      }
      setLookup("");
      setLookupError(null);
    },
    onError: (e) => {
      if (isApiError(e) && e.kind === "not_found") setLookupError(`No member record ${lookup}.`);
      else if (isApiError(e) && e.kind === "validation") setLookupError(e.fields[0]?.message ?? "Enter a 7-digit member number.");
      else setLookupError("Couldn't look up that member. Try again.");
    },
  });

  const toggle = (n: string, on: boolean) =>
    update({ jointMemberNumbers: on ? [...draft.jointMemberNumbers, n] : draft.jointMemberNumbers.filter((x) => x !== n) });

  const listed = [
    ...ctx.joint_candidates,
    ...draft.extraJoint.map((x) => ({ ...x, relationship: "Added by member number", eligible: true, reason: null })),
  ];

  return (
    <section className="panel form-section" id="section-ownership" aria-labelledby="h-ownership">
      <div className="form-section__header">
        <h2 id="h-ownership">Ownership</h2>
      </div>
      <div className="form-section__body">
        <div className="stack stack--sm">
          <RadioGroup
            label="Owners"
            name="ownership"
            inline
            value={draft.ownershipType}
            options={[
              { value: "individual", label: "Individual" },
              { value: "joint", label: "Joint with another member" },
            ]}
            onChange={(v) => update({ ownershipType: v as OpenDraft["ownershipType"] })}
          />
          {draft.ownershipType === "joint" && (
            <>
              <fieldset style={{ border: 0, margin: 0, padding: 0 }} id={fieldAnchor("ownership.joint_member_numbers")} tabIndex={-1}>
                <legend className="field__label" style={{ padding: 0, marginBottom: 6 }}>
                  Joint owners
                </legend>
                {listed.length ? (
                  <div className="joint-list option-list">
                    {listed.map((c) => (
                      <label className="option" key={c.member_number}>
                        <input
                          type="checkbox"
                          checked={draft.jointMemberNumbers.includes(c.member_number)}
                          disabled={!c.eligible}
                          aria-labelledby={`joint-${c.member_number}`}
                          aria-describedby={[`joint-${c.member_number}-desc`, !c.eligible && `joint-${c.member_number}-reason`].filter(Boolean).join(" ")}
                          onChange={(e) => toggle(c.member_number, e.target.checked)}
                          style={{ width: 15, height: 15, accentColor: "var(--ink-800)" }}
                        />
                        <span>
                          <span className="option__title" id={`joint-${c.member_number}`}>
                            {c.display_name}
                          </span>
                          <span className="option__desc" id={`joint-${c.member_number}-desc`}>
                            {c.relationship} · <span className="mono">{c.member_number}</span>
                          </span>
                          {!c.eligible && (
                            <span className="option__reason" id={`joint-${c.member_number}-reason`}>
                              <TriangleAlert size={12} aria-hidden="true" /> {c.reason}
                            </span>
                          )}
                        </span>
                        <span />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="subtle" style={{ fontSize: "var(--fs-sm)" }}>
                    No related members on file. Add a joint owner by member number.
                  </p>
                )}
                {error && (
                  <span className="field__error" style={{ marginTop: 6 }}>
                    <CircleAlert size={13} aria-hidden="true" />
                    {error}
                  </span>
                )}
              </fieldset>
              <div className="lookup-row">
                <Field label="Add by member number" error={lookupError}>
                  <Input
                    mono
                    inputMode="numeric"
                    maxLength={7}
                    value={lookup}
                    onChange={(e) => setLookup(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (lookup) find.mutate(lookup);
                      }
                    }}
                  />
                </Field>
                <Button icon={<UserPlus size={14} aria-hidden="true" />} loading={find.isPending} onClick={() => lookup && find.mutate(lookup)}>
                  Verify & add
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function BeneficiariesSection({ draft, update, err }: { draft: OpenDraft; update: (p: Partial<OpenDraft>) => void; err: (f: string) => string | undefined }) {
  const total = draft.beneficiaries.reduce((s, b) => s + (Number(b.percent) || 0), 0);
  const set = (i: number, patch: Partial<OpenDraft["beneficiaries"][number]>) =>
    update({ beneficiaries: draft.beneficiaries.map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  return (
    <section className="panel form-section" id="section-beneficiaries" aria-labelledby="h-beneficiaries">
      <div className="form-section__header">
        <h2 id="h-beneficiaries">Beneficiaries</h2>
        <p>Optional · payable on death (POD)</p>
      </div>
      <div className="form-section__body">
        {draft.beneficiaries.map((b, i) => (
          <div className="beneficiary-row" key={i}>
            <Field label={`Beneficiary ${i + 1} name`} error={err(`beneficiaries.${i}.name`)}>
              <Input value={b.name} onChange={(e) => set(i, { name: e.target.value })} id={fieldAnchor(`beneficiaries.${i}.name`)} />
            </Field>
            <Field label="Relationship" error={err(`beneficiaries.${i}.relationship`)}>
              <Select value={b.relationship} onChange={(e) => set(i, { relationship: e.target.value })}>
                <option value="">Choose…</option>
                {BENEFICIARY_RELATIONSHIPS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            </Field>
            <Field label="Share %" error={err(`beneficiaries.${i}.percent`)}>
              <Input inputMode="decimal" className="num" style={{ textAlign: "right" }} value={b.percent} onChange={(e) => set(i, { percent: e.target.value.replace(/[^\d.]/g, "") })} />
            </Field>
            <div style={{ paddingTop: 22 }}>
              <Button
                variant="ghost"
                icon={<Trash2 size={14} aria-hidden="true" />}
                aria-label={`Remove beneficiary ${i + 1}`}
                onClick={() => update({ beneficiaries: draft.beneficiaries.filter((_, j) => j !== i) })}
              />
            </div>
          </div>
        ))}
        {draft.beneficiaries.length > 0 && (
          <div className="beneficiary-total" id={fieldAnchor("beneficiaries")}>
            <span>{err("beneficiaries") ? <span className="field__error">{err("beneficiaries")}</span> : "Shares must add up to 100%."}</span>
            <strong className="num" style={{ color: Math.abs(total - 100) < 0.001 ? "var(--ok-700)" : "var(--warn-700)" }}>
              Total {total.toFixed(2)}%
            </strong>
          </div>
        )}
        <div style={{ marginTop: draft.beneficiaries.length ? 12 : 0 }}>
          {draft.beneficiaries.length < 4 ? (
            <Button
              size="sm"
              icon={<Plus size={13} aria-hidden="true" />}
              onClick={() =>
                update({
                  beneficiaries: [...draft.beneficiaries, { name: "", relationship: "", percent: draft.beneficiaries.length === 0 ? "100" : "" }],
                })
              }
            >
              Add beneficiary
            </Button>
          ) : (
            <p className="subtle" style={{ fontSize: "var(--fs-sm)" }}>
              Up to 4 beneficiaries.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

