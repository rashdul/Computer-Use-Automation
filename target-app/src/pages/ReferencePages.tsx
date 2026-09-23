import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History, Percent } from "lucide-react";
import { Fragment, useState } from "react";
import { Panel } from "../components/display";
import { LoadError, SlowNotice } from "../components/feedback";
import { Field, Select } from "../components/form";
import { Pager, SkeletonRows } from "../components/navigation";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { api } from "../lib/api";
import { date, money } from "../lib/format";
import { CATEGORY_LABEL } from "../lib/labels";
import type { ProductCategory } from "../lib/types";
import { AuditTable } from "./activity/AuditTable";

const ORDER: ProductCategory[] = ["share", "share_draft", "money_market", "club", "certificate", "ira", "loan"];

export function ProductRatesPage() {
  useDocumentTitle("Product rates");
  const q = useQuery({ queryKey: ["products"], queryFn: api.products, staleTime: 5 * 60_000 });
  const latest = q.data?.reduce((m, p) => (p.updated_at && p.updated_at > m ? p.updated_at : m), "");

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header__text">
          <h1>Product rates</h1>
          <p>Current deposit and lending rates to quote to members{latest ? ` · updated ${date(latest)}` : ""}.</p>
        </div>
      </div>
      <div className="stack">
        {q.isError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} what="product rates" />
        ) : (
          <Panel title="Rate sheet" icon={<Percent size={15} aria-hidden="true" />} flush>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Code</th>
                    <th scope="col" className="num">Rate</th>
                    <th scope="col" className="num">Minimum to open</th>
                    <th scope="col" className="num">Minimum balance</th>
                    <th scope="col">Term</th>
                    <th scope="col" className="num">Monthly fee</th>
                    <th scope="col">Eligibility</th>
                  </tr>
                </thead>
                <tbody>
                  {!q.data ? (
                    <SkeletonRows columns={8} rows={12} />
                  ) : (
                    ORDER.map((c) => {
                      const rows = q.data.filter((p) => p.category === c);
                      if (!rows.length) return null;
                      return (
                        <Fragment key={c}>
                          <tr className="table-subhead">
                            <td colSpan={8}>{CATEGORY_LABEL[c]}</td>
                          </tr>
                          {rows.map((p) => (
                            <tr key={p.code}>
                              <td>
                                <span className="col-primary">{p.name}</span>
                                <span className="cell-sub">{p.description}</span>
                              </td>
                              <td className="mono nowrap">{p.code}</td>
                              <td className="num">{p.rate === null ? "—" : `${p.rate.toFixed(2)}% ${c === "loan" ? "APR" : "APY"}`}</td>
                              <td className="num">{c === "loan" ? "—" : money(p.min_opening_deposit)}</td>
                              <td className="num">{c === "loan" ? "—" : money(p.min_balance)}</td>
                              <td className="nowrap">{p.term_months ? `${p.term_months} months` : "—"}</td>
                              <td className="num">{p.monthly_fee ? money(p.monthly_fee) : "None"}</td>
                              <td className="muted">
                                {[
                                  p.min_age ? `${p.min_age}+` : null,
                                  p.max_age ? `Under ${p.max_age + 1}` : null,
                                  p.max_per_member ? `Max ${p.max_per_member} per member` : null,
                                  p.is_openable === false ? "Opened by Lending" : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "Any member"}
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

const ACTIVITY_PAGE = 50;

export function MyActivityPage() {
  useDocumentTitle("My activity");
  const [outcome, setOutcome] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["my-activity", outcome, offset],
    queryFn: () => api.myActivity(ACTIVITY_PAGE, offset, outcome),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header__text">
          <h1>My activity</h1>
          <p>Everything recorded under your sign-in, newest first. Compliance reviews this log.</p>
        </div>
        <Field label="Outcome">
          <Select
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="failed">Failed</option>
          </Select>
        </Field>
      </div>
      <div className="stack">
        <SlowNotice active={q.isFetching} what="your activity" />
        {q.isError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} what="your activity" />
        ) : (
          <Panel
            title="Activity"
            icon={<History size={15} aria-hidden="true" />}
            count={q.data ? `· ${q.data.total.toLocaleString()}` : undefined}
            flush
            footer={q.data && q.data.total > ACTIVITY_PAGE ? <Pager total={q.data.total} limit={ACTIVITY_PAGE} offset={offset} onChange={setOffset} noun="events" /> : undefined}
          >
            {!q.data ? (
              <table className="table">
                <tbody>
                  <SkeletonRows columns={5} rows={10} />
                </tbody>
              </table>
            ) : (
              <AuditTable rows={q.data.rows} />
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}
