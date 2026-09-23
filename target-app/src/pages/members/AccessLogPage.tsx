import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Panel } from "../../components/display";
import { LoadError, SlowNotice } from "../../components/feedback";
import { Pager, SkeletonRows } from "../../components/navigation";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { keys, useMemberDetail } from "../queries";
import { PermissionDenied } from "../StatePages";
import { AuditTable } from "../activity/AuditTable";

const PAGE = 25;

export function AccessLogPage() {
  const detail = useMemberDetail();
  const n = detail.member.member_number;
  const [offset, setOffset] = useState(0);
  const q = useQuery({ queryKey: keys.accessLog(n, offset), queryFn: () => api.accessLog(n, PAGE, offset), placeholderData: keepPreviousData });

  if (isApiError(q.error) && q.error.kind === "permission_denied") return <PermissionDenied error={q.error} />;

  return (
    <div className="page">
      <div className="stack">
        <SlowNotice active={q.isFetching} what="the access log" />
        {q.isError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} what="the access log" />
        ) : (
          <Panel
            title="Who accessed this record"
            icon={<ShieldCheck size={15} aria-hidden="true" />}
            count={q.data ? `· ${q.data.total}` : undefined}
            flush
            footer={q.data && q.data.total > PAGE ? <Pager total={q.data.total} limit={PAGE} offset={offset} onChange={setOffset} noun="events" /> : undefined}
          >
            {q.isPending ? (
              <table className="table">
                <tbody>
                  <SkeletonRows columns={5} />
                </tbody>
              </table>
            ) : (
              <AuditTable rows={q.data.rows} showActor />
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}
