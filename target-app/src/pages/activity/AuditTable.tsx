import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import { Badge } from "../../components/display";
import { EmptyState } from "../../components/feedback";
import { dateNumeric, time } from "../../lib/format";
import { actionLabel } from "../../lib/labels";
import type { AuditRow } from "../../lib/types";

const OUTCOME: Record<AuditRow["outcome"], { label: string; tone: "ok" | "bad" | "warn" }> = {
  success: { label: "Success", tone: "ok" },
  denied: { label: "Denied", tone: "bad" },
  failed: { label: "Failed", tone: "warn" },
};

export function AuditTable({ rows, showActor, expandable }: { rows: AuditRow[]; showActor?: boolean; expandable?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <EmptyState title="No activity recorded">Nothing matches these filters.</EmptyState>;
  const cols = 5 + (showActor ? 1 : 0) + (expandable ? 1 : 0);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {expandable && <th scope="col" style={{ width: 28 }}><span className="sr-only">Details</span></th>}
            <th scope="col">When (ET)</th>
            {showActor && <th scope="col">Staff</th>}
            <th scope="col">Action</th>
            <th scope="col">Summary</th>
            <th scope="col">Outcome</th>
            <th scope="col">Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isOpen = open === r.reference;
            return (
              <Fragment key={r.reference}>
                <tr>
                  {expandable && (
                    <td>
                      <button
                        type="button"
                        className="copy-btn"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? `Hide details for ${r.reference}` : `Show details for ${r.reference}`}
                        onClick={() => setOpen(isOpen ? null : r.reference)}
                      >
                        {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                      </button>
                    </td>
                  )}
                  <td className="nowrap">
                    {dateNumeric(r.occurred_at)} <span className="subtle">{time(r.occurred_at)}</span>
                  </td>
                  {showActor && (
                    <td className="nowrap">
                      {r.actor_name}
                      <span className="cell-sub mono">{r.actor_username}</span>
                    </td>
                  )}
                  <td className="nowrap">{actionLabel(r.action)}</td>
                  <td>
                    {r.summary}
                    {r.member_number && !r.summary.includes(r.member_number) && (
                      <>
                        {" "}
                        · <Link to={`/members/${r.member_number}`} className="mono">{r.member_number}</Link>
                      </>
                    )}
                  </td>
                  <td>
                    <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                  </td>
                  <td className="mono nowrap">{r.reference}</td>
                </tr>
                {expandable && isOpen && (
                  <tr>
                    <td colSpan={cols} style={{ background: "var(--surface-sunk)" }}>
                      <pre className="details-json">{JSON.stringify({ workstation: r.workstation, ...(r.details ?? {}) }, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
