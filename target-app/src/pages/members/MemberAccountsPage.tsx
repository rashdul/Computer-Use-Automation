import { useQuery } from "@tanstack/react-query";
import { FilePlus2, Landmark, Lock, Wallet } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthContext";
import { ButtonLink } from "../../components/Button";
import { Badge, Panel, Stats, Suffix } from "../../components/display";
import { EmptyState, LoadError, Skeleton, SlowNotice } from "../../components/feedback";
import { Check } from "../../components/form";
import { SkeletonRows } from "../../components/navigation";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { count, date, dateNumeric, money, rate } from "../../lib/format";
import { ACCOUNT_STATUS, CATEGORY_LABEL } from "../../lib/labels";
import type { Account, ProductCategory } from "../../lib/types";
import { keys, useMemberDetail } from "../queries";
import { PermissionDenied } from "../StatePages";
import { MemberAlerts } from "./MemberLayout";

const DEPOSIT_ORDER: ProductCategory[] = ["share", "club", "share_draft", "money_market", "certificate", "ira"];

export function MemberAccountsPage() {
  const detail = useMemberDetail();
  const n = detail.member.member_number;
  const { can } = useAuth();
  const [showClosed, setShowClosed] = useState(false);
  const q = useQuery({ queryKey: keys.accounts(n, showClosed), queryFn: () => api.memberAccounts(n, showClosed) });

  if (isApiError(q.error) && q.error.kind === "permission_denied") return <PermissionDenied error={q.error} />;

  const accounts = q.data?.accounts ?? [];
  const deposits = accounts.filter((a) => a.category !== "loan");
  const loans = accounts.filter((a) => a.category === "loan");
  const live = (a: Account) => a.status !== "closed";
  // never show computed zeros for balances that haven't loaded
  const loaded = q.data !== undefined;
  const figure = (v: string) => (loaded ? v : q.isError ? "—" : <Skeleton width={96} height={18} />);
  const note = (v: string) => (loaded ? v : q.isError ? "Not available" : " ");

  return (
    <div className="page">
      <MemberAlerts alerts={detail.alerts} />
      <div className="stack">
        <Stats
          items={[
            {
              label: "Deposits",
              value: figure(money(deposits.filter(live).reduce((s, a) => s + a.current_balance, 0))),
              sub: note(`${deposits.filter(live).length} sub-accounts`),
            },
            {
              label: "Available to withdraw",
              value: figure(money(deposits.filter(live).reduce((s, a) => s + a.available_balance, 0))),
              sub: note("After holds"),
            },
            {
              label: "Loans & lines",
              value: figure(money(loans.filter(live).reduce((s, a) => s + a.current_balance, 0))),
              sub: note(`${loans.filter(live).length} open`),
            },
            {
              label: "Relationship since",
              value: date(detail.member.member_since),
              sub: loaded ? `${detail.summary.joint_accounts} joint · ${q.data.closed_count} closed` : `${detail.summary.joint_accounts} joint`,
            },
          ]}
        />

        <div className="toolbar">
          <Check
            label={`Show closed sub-accounts${q.data ? ` (${count(q.data.closed_count)})` : ""}`}
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          <span className="toolbar__spacer" />
          <ButtonLink
            to={`/members/${n}/accounts/new`}
            variant="primary"
            icon={can("accounts.open") ? <FilePlus2 size={15} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
          >
            Open sub-account
          </ButtonLink>
        </div>

        <SlowNotice active={q.isFetching} what="accounts" />
        {q.isError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} what="accounts" />
        ) : (
          <>
            <Panel title="Deposit accounts" icon={<Wallet size={15} aria-hidden="true" />} flush>
              <DepositTable memberNumber={n} accounts={deposits} loading={q.isPending} />
            </Panel>
            <Panel title="Loans & lines of credit" icon={<Landmark size={15} aria-hidden="true" />} flush>
              <LoanTable memberNumber={n} accounts={loans} loading={q.isPending} />
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

function Owners({ a }: { a: Account }) {
  const joint = a.parties.filter((p) => p.role === "joint");
  const custodian = a.parties.find((p) => p.role === "custodian");
  if (a.ownership === "joint") {
    return (
      <>
        Joint owner
        <span className="cell-sub">Primary: {a.owner_member_number}</span>
      </>
    );
  }
  return (
    <>
      Primary
      {joint.length > 0 && <span className="cell-sub">+ {joint.map((j) => j.name).join(", ")}</span>}
      {custodian && <span className="cell-sub">Custodian: {custodian.name}</span>}
    </>
  );
}

function useRowNav(memberNumber: string) {
  const navigate = useNavigate();
  return (a: Account) => ({
    "data-href": `/members/${memberNumber}/accounts/${a.account_number}`,
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a")) return;
      navigate(`/members/${memberNumber}/accounts/${a.account_number}`);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") navigate(`/members/${memberNumber}/accounts/${a.account_number}`);
    },
  });
}

function DepositTable({ memberNumber, accounts, loading }: { memberNumber: string; accounts: Account[]; loading: boolean }) {
  const rowNav = useRowNav(memberNumber);
  if (!loading && !accounts.length) return <EmptyState title="No deposit accounts">Open a share, checking, or certificate sub-account to get started.</EmptyState>;
  const groups = DEPOSIT_ORDER.map((c) => ({ c, rows: accounts.filter((a) => a.category === c) })).filter((g) => g.rows.length);
  const total = accounts.filter((a) => a.status !== "closed").reduce((s, a) => s + a.current_balance, 0);
  const avail = accounts.filter((a) => a.status !== "closed").reduce((s, a) => s + a.available_balance, 0);

  return (
    <div className="table-wrap">
      <table className="table table--interactive">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Product</th>
            <th scope="col">Ownership</th>
            <th scope="col">Status</th>
            <th scope="col">Opened</th>
            <th scope="col" className="num">Rate</th>
            <th scope="col" className="num">Current balance</th>
            <th scope="col" className="num">Available</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows columns={8} rows={5} />
          ) : (
            groups.map((g) => (
              <Fragment key={g.c}>
                <tr className="table-subhead">
                  <td colSpan={8}>{CATEGORY_LABEL[g.c]}</td>
                </tr>
                {g.rows.map((a) => (
                  <tr key={a.id} {...rowNav(a)} className={a.status === "closed" ? "row-muted" : undefined} aria-label={`${a.account_number} ${a.product_name}`}>
                    <td className="nowrap">
                      <Suffix value={a.suffix} />{" "}
                      <Link to={`/members/${memberNumber}/accounts/${a.account_number}`} className="mono" style={{ marginLeft: 4 }}>
                        {a.account_number}
                      </Link>
                    </td>
                    <td>
                      <span className="col-primary">{a.product_name}</span>
                      {a.nickname && <span className="cell-sub">“{a.nickname}”</span>}
                      {a.maturity_date && a.category === "certificate" && <span className="cell-sub">Matures {date(a.maturity_date)}</span>}
                    </td>
                    <td>
                      <Owners a={a} />
                    </td>
                    <td>
                      <Badge tone={ACCOUNT_STATUS[a.status].tone} dot>
                        {ACCOUNT_STATUS[a.status].label}
                      </Badge>
                    </td>
                    <td className="nowrap">{dateNumeric(a.opened_on)}</td>
                    <td className="num">{a.rate === null ? "—" : `${a.rate.toFixed(2)}%`}</td>
                    <td className="num">{money(a.current_balance)}</td>
                    <td className="num">
                      {money(a.available_balance)}
                      {a.hold_amount > 0 && <span className="cell-sub">{money(a.hold_amount)} on hold</span>}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))
          )}
        </tbody>
        {!loading && accounts.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={6}>Total deposits</td>
              <td className="num">{money(total)}</td>
              <td className="num">{money(avail)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function LoanTable({ memberNumber, accounts, loading }: { memberNumber: string; accounts: Account[]; loading: boolean }) {
  const rowNav = useRowNav(memberNumber);
  if (!loading && !accounts.length) return <EmptyState title="No loans or lines of credit">Loans are originated in the lending system and appear here once booked.</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="table table--interactive">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Product</th>
            <th scope="col">Status</th>
            <th scope="col">Opened</th>
            <th scope="col" className="num">APR</th>
            <th scope="col" className="num">Payment</th>
            <th scope="col">Next due</th>
            <th scope="col" className="num">Limit / original</th>
            <th scope="col" className="num">Balance owed</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows columns={9} rows={2} />
          ) : (
            accounts.map((a) => (
              <tr key={a.id} {...rowNav(a)} className={a.status === "closed" ? "row-muted" : undefined} aria-label={`${a.account_number} ${a.product_name}`}>
                <td className="nowrap">
                  <Suffix value={a.suffix} loan />{" "}
                  <Link to={`/members/${memberNumber}/accounts/${a.account_number}`} className="mono" style={{ marginLeft: 4 }}>
                    {a.account_number}
                  </Link>
                </td>
                <td className="col-primary">{a.product_name}</td>
                <td>
                  <Badge tone={a.status === "closed" ? "neutral" : ACCOUNT_STATUS[a.status].tone} dot>
                    {a.status === "closed" ? "Paid off" : ACCOUNT_STATUS[a.status].label}
                  </Badge>
                </td>
                <td className="nowrap">{dateNumeric(a.opened_on)}</td>
                <td className="num">{a.rate === null ? "—" : rate(a.rate, "APR").replace(" APR", "")}</td>
                <td className="num">{money(a.payment_amount)}</td>
                <td className="nowrap">{a.next_payment_due ? dateNumeric(a.next_payment_due) : "—"}</td>
                <td className="num">{money(a.credit_limit ?? a.original_amount)}</td>
                <td className="num">{money(a.current_balance)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
