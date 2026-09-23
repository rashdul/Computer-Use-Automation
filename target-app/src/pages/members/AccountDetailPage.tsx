import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Filter, ReceiptText, RotateCcw, Users } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "../../components/Button";
import { Badge, CopyButton, DL, Panel, Suffix } from "../../components/display";
import { EmptyState, LoadError, SkeletonLines, SlowNotice } from "../../components/feedback";
import { Field, Input, Select } from "../../components/form";
import { Pager, SkeletonRows } from "../../components/navigation";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { api, type TxnFilters } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { date, dateNumeric, money, rate, time } from "../../lib/format";
import { ACCOUNT_STATUS, CHANNEL, DIVIDEND_OPTION, MATURITY_OPTION, TXN_TYPE } from "../../lib/labels";
import type { AccountDetail } from "../../lib/types";
import { keys, useMemberDetail } from "../queries";
import { PermissionDenied } from "../StatePages";

const PAGE = 25;

export function AccountDetailPage() {
  const { accountNumber = "" } = useParams();
  const detail = useMemberDetail();
  const n = detail.member.member_number;
  const q = useQuery({ queryKey: keys.account(n, accountNumber), queryFn: () => api.account(n, accountNumber) });
  useDocumentTitle(`Account ${accountNumber.toUpperCase()}`);

  if (q.isError && isApiError(q.error) && q.error.kind === "permission_denied") return <PermissionDenied error={q.error} />;

  return (
    <div className="page">
      <div className="stack">
        <div>
          <Link to={`/members/${n}/accounts`} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600 }}>
            <ArrowLeft size={14} aria-hidden="true" /> All accounts
          </Link>
        </div>
        <SlowNotice active={q.isPending} what="the account" />
        {q.isPending ? (
          <div className="panel panel__body">
            <SkeletonLines lines={6} />
          </div>
        ) : q.isError ? (
          isApiError(q.error) && q.error.kind === "not_found" ? (
            <Panel>
              <EmptyState
                title={`Account ${accountNumber.toUpperCase()} isn't on this membership`}
                actions={
                  <Link to={`/members/${n}/accounts`} className="btn btn--secondary" style={{ textDecoration: "none" }}>
                    View this member's accounts
                  </Link>
                }
              >
                Check the account number. Joint accounts appear under each owner's membership.
              </EmptyState>
            </Panel>
          ) : (
            <LoadError error={q.error} onRetry={() => q.refetch()} what="the account" />
          )
        ) : (
          <>
            <AccountHeader d={q.data} />
            <div className="grid-12">
              <Panel title="Account details" icon={<ReceiptText size={15} aria-hidden="true" />} className="span-7">
                <AccountFacts d={q.data} />
              </Panel>
              <Panel title="Owners & beneficiaries" icon={<Users size={15} aria-hidden="true" />} className="span-5">
                <OwnerFacts d={q.data} />
              </Panel>
            </div>
            {detail.capabilities.view_transactions && <Ledger memberNumber={n} d={q.data} />}
          </>
        )}
      </div>
    </div>
  );
}

function AccountHeader({ d }: { d: AccountDetail }) {
  const a = d.account;
  const isLoan = a.category === "loan";
  return (
    <section className="panel" aria-label="Account summary">
      <div className="account-head">
        <div>
          <div className="account-head__title">
            <Suffix value={a.suffix} loan={isLoan} />
            <h2>{a.product_name}</h2>
            {a.nickname && <span className="muted">“{a.nickname}”</span>}
            <Badge tone={a.status === "closed" && isLoan ? "neutral" : ACCOUNT_STATUS[a.status].tone} dot>
              {a.status === "closed" && isLoan ? "Paid off" : ACCOUNT_STATUS[a.status].label}
            </Badge>
          </div>
          <div className="account-head__number">
            Account <span className="mono">{a.account_number}</span> <CopyButton text={a.account_number} label="Copy account number" />
            {a.ownership === "joint" && <> · Joint with primary member {d.owner.display_name}</>}
          </div>
        </div>
        <div className="account-balances">
          {isLoan ? (
            <>
              <div>
                <div className="account-balances__label">Balance owed</div>
                <div className="account-balances__value">{money(a.current_balance)}</div>
              </div>
              {a.credit_limit !== null && (
                <div>
                  <div className="account-balances__label">Available credit</div>
                  <div className="account-balances__value">{money(a.available_balance)}</div>
                </div>
              )}
              <div>
                <div className="account-balances__label">Payment</div>
                <div className="account-balances__value">{money(a.payment_amount)}</div>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="account-balances__label">Current balance</div>
                <div className="account-balances__value">{money(a.current_balance)}</div>
              </div>
              <div>
                <div className="account-balances__label">Available</div>
                <div className="account-balances__value">{money(a.available_balance)}</div>
              </div>
              {a.hold_amount > 0 && (
                <div>
                  <div className="account-balances__label">On hold</div>
                  <div className="account-balances__value" style={{ color: "var(--warn-700)" }}>
                    {money(a.hold_amount)}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function AccountFacts({ d }: { d: AccountDetail }) {
  const a = d.account;
  const items: ([React.ReactNode, React.ReactNode] | "sep")[] = [
    ["Product", <>{a.product_name} <span className="subtle mono">{a.product_code}</span></>],
    [a.category === "loan" ? "APR" : "Rate (APY)", a.rate === null ? "—" : rate(a.rate, a.category === "loan" ? "APR" : "APY")],
    ["Opened", <>{date(a.opened_on)} <span className="subtle">by {a.opened_by_name}</span></>],
  ];
  if (d.opening) {
    items.push([
      "Confirmation",
      <Link to={`/members/${d.owner.member_number}/accounts/new/confirmation/${d.opening.confirmation_number}`} className="mono">
        {d.opening.confirmation_number}
      </Link>,
    ]);
  }
  if (a.closed_on) items.push(["Closed", date(a.closed_on)]);
  items.push(["Last activity", a.last_activity_on ? date(a.last_activity_on) : "—"]);
  items.push(["Statements", a.statement_delivery === "electronic" ? "Electronic" : "Paper (mailed)"]);

  if (a.category === "certificate") {
    items.push("sep");
    items.push(["Term", `${a.term_months} months`]);
    items.push(["Matures", date(a.maturity_date)]);
    items.push(["At maturity", a.maturity_option ? MATURITY_OPTION[a.maturity_option] : "—"]);
    items.push(["Dividends", a.dividend_disposition ? DIVIDEND_OPTION[a.dividend_disposition] : "—"]);
  }
  if (a.category === "share_draft") {
    items.push("sep");
    items.push(["Overdraft protection", d.overdraft_source_account_number ? <span className="mono">{d.overdraft_source_account_number}</span> : "Not set up"]);
    items.push(["Debit card", a.debit_card_ordered ? "Issued" : "None"]);
  }
  if (a.category === "loan") {
    items.push("sep");
    if (a.original_amount !== null) items.push(["Original amount", money(a.original_amount)]);
    if (a.credit_limit !== null) items.push(["Credit limit", money(a.credit_limit)]);
    items.push(["Next payment due", a.next_payment_due ? date(a.next_payment_due) : "—"]);
    if (a.maturity_date) items.push(["Final payment", date(a.maturity_date)]);
  }
  items.push("sep");
  items.push(["About this product", <span className="muted">{d.product.description}</span>]);
  return <DL items={items} wide />;
}

function OwnerFacts({ d }: { d: AccountDetail }) {
  const a = d.account;
  const joint = a.parties.filter((p) => p.role === "joint");
  const bens = a.parties.filter((p) => p.role === "beneficiary");
  const custodian = a.parties.filter((p) => p.role === "custodian");
  const items: ([React.ReactNode, React.ReactNode] | "sep")[] = [
    [
      "Primary owner",
      <>
        <Link to={`/members/${d.owner.member_number}`}>{d.owner.display_name}</Link> <span className="subtle mono">{d.owner.member_number}</span>
      </>,
    ],
  ];
  joint.forEach((p) =>
    items.push([
      "Joint owner",
      p.member_number ? (
        <>
          <Link to={`/members/${p.member_number}`}>{p.name}</Link> <span className="subtle mono">{p.member_number}</span>
        </>
      ) : (
        p.name
      ),
    ]),
  );
  custodian.forEach((p) => items.push(["Custodian", <>{p.name} {p.member_number && <span className="subtle mono">{p.member_number}</span>}</>]));
  if (bens.length) {
    items.push("sep");
    bens.forEach((p) => items.push(["Beneficiary (POD)", <>{p.name} <span className="subtle">· {p.relationship} · {p.percent}%</span></>]));
  } else {
    items.push(["Beneficiaries", <span className="subtle">None designated</span>]);
  }
  return <DL items={items} />;
}

function Ledger({ memberNumber, d }: { memberNumber: string; d: AccountDetail }) {
  const acct = d.account.account_number;
  const isLoan = d.account.category === "loan";
  const empty: TxnFilters = { from: "", to: "", direction: "all", search: "" };
  const [draft, setDraft] = useState<TxnFilters>(empty);
  const [filters, setFilters] = useState<TxnFilters>(empty);
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: keys.txns(memberNumber, acct, { ...filters, offset }),
    queryFn: () => api.transactions(memberNumber, acct, { ...filters, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const validation = isApiError(q.error) && q.error.kind === "validation" ? q.error.fields[0] : null;
  const lastPage = q.data ? offset + PAGE >= q.data.total : false;
  const showForward = q.data && lastPage && filters.direction === "all" && !filters.search && q.data.balance_forward !== null;

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    setFilters(draft);
  };

  return (
    <Panel
      title="Transactions"
      icon={<ReceiptText size={15} aria-hidden="true" />}
      count={q.data ? `· ${q.data.total.toLocaleString()}` : undefined}
      flush
      footer={
        q.data && q.data.total > PAGE ? <Pager total={q.data.total} limit={PAGE} offset={offset} onChange={setOffset} noun="transactions" disabled={q.isFetching} /> : undefined
      }
    >
      <form className="ledger-filters" onSubmit={apply} aria-label="Filter transactions">
        <Field label="From" error={validation?.field === "from" ? validation.message : undefined}>
          <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </Field>
        <Field label="To" error={validation?.field === "to" ? validation.message : undefined}>
          <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </Field>
        <Field label="Show">
          <Select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value as TxnFilters["direction"] })}>
            <option value="all">All transactions</option>
            <option value="credit">{isLoan ? "Payments only" : "Credits only"}</option>
            <option value="debit">{isLoan ? "Charges only" : "Debits only"}</option>
          </Select>
        </Field>
        <Field label="Description or check #" className="field--grow">
          <Input value={draft.search} onChange={(e) => setDraft({ ...draft, search: e.target.value })} placeholder="e.g. PAYROLL, GIANT, 1043" />
        </Field>
        <Button type="submit" icon={<Filter size={14} aria-hidden="true" />}>
          Apply
        </Button>
        <Button
          variant="ghost"
          icon={<RotateCcw size={14} aria-hidden="true" />}
          onClick={() => {
            setDraft(empty);
            setFilters(empty);
            setOffset(0);
          }}
        >
          Reset
        </Button>
      </form>
      <div style={{ padding: q.isFetching ? "12px 16px 0" : 0 }}>
        <SlowNotice active={q.isFetching} what="transactions" />
      </div>
      {q.isError && !validation ? (
        <div className="panel__body">
          <LoadError error={q.error} onRetry={() => q.refetch()} what="transactions" />
        </div>
      ) : q.data && q.data.rows.length === 0 && !showForward ? (
        <EmptyState title="No transactions match">
          {d.history_starts_on ? `History online starts ${date(d.history_starts_on)}. ` : ""}Older activity is on the member's statements.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Posted (ET)</th>
                <th scope="col">Description</th>
                <th scope="col">Type</th>
                <th scope="col" className="num">{isLoan ? "Payments" : "Debits"}</th>
                <th scope="col" className="num">{isLoan ? "Charges" : "Credits"}</th>
                <th scope="col" className="num">{isLoan ? "Balance owed" : "Balance"}</th>
              </tr>
            </thead>
            <tbody>
              {!q.data ? (
                <SkeletonRows columns={6} rows={10} />
              ) : (
                <>
                  {q.data.rows.map((t) => {
                    // loans: negative = payment (reduces owed), positive = charge
                    const outflow = isLoan ? t.amount < 0 : t.amount < 0;
                    return (
                      <tr key={t.id}>
                        <td className="nowrap">
                          {dateNumeric(t.posted_at)} <span className="subtle">{time(t.posted_at)}</span>
                        </td>
                        <td>
                          {t.description}
                          {t.reference && <span className="cell-sub">Ref {t.reference}</span>}
                        </td>
                        <td className="nowrap">
                          {TXN_TYPE[t.type] ?? t.type}
                          <span className="cell-sub">{CHANNEL[t.channel] ?? t.channel}</span>
                        </td>
                        <td className="num">{outflow ? money(Math.abs(t.amount)) : ""}</td>
                        <td className={`num${!outflow && !isLoan ? " amount-credit" : ""}`}>{!outflow ? money(t.amount) : ""}</td>
                        <td className="num">{money(t.balance_after)}</td>
                      </tr>
                    );
                  })}
                  {showForward && (
                    <tr className="row-forward">
                      <td className="nowrap">{d.history_starts_on ? dateNumeric(d.history_starts_on) : ""}</td>
                      <td colSpan={4}>Balance forward</td>
                      <td className="num">{money(q.data.balance_forward)}</td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
