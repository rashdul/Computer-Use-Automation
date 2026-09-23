import { FilePlus2, Lock, NotebookPen } from "lucide-react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/Button";
import { Badge, CopyButton } from "../../components/display";
import { Banner, LoadError, Skeleton, SkeletonLines, SlowNotice } from "../../components/feedback";
import { Tabs } from "../../components/navigation";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { isApiError } from "../../lib/errors";
import { date } from "../../lib/format";
import { ALERT_LABEL, KYC, MEMBER_STATUS, MEMBERSHIP_TYPE } from "../../lib/labels";
import type { MemberAlert, MemberDetail } from "../../lib/types";
import { useMemberQuery } from "../queries";
import { MemberNotFound, PermissionDenied } from "../StatePages";

export function MemberLayout() {
  const { memberNumber = "" } = useParams();
  const location = useLocation();
  const query = useMemberQuery(memberNumber);
  const inFlow = /\/accounts\/new(\/|$)/.test(location.pathname);
  useDocumentTitle(query.data ? `${query.data.member.display_name} (${memberNumber})` : `Member ${memberNumber}`);

  if (query.isPending) {
    return (
      <>
        <MemberBandSkeleton />
        <div className="page">
          <div className="stack">
            <SlowNotice active what="the member record" />
            <div className="panel panel__body">
              <SkeletonLines lines={6} />
            </div>
          </div>
        </div>
      </>
    );
  }

  if (query.isError) {
    const e = query.error;
    if (isApiError(e) && e.kind === "not_found") return <MemberNotFound memberNumber={memberNumber} />;
    if (isApiError(e) && e.kind === "permission_denied") return <PermissionDenied error={e} />;
    return (
      <div className="page">
        <LoadError error={e} onRetry={() => query.refetch()} what="the member record" />
      </div>
    );
  }

  const detail = query.data;
  return (
    <>
      <MemberBand detail={detail} inFlow={inFlow} onNotes={/\/notes\/?$/.test(location.pathname)} />
      {!inFlow && (
        <div className="member-tabs">
          <div className="member-tabs__inner">
            <Tabs
              label="Member record"
              items={[
                { to: `/members/${memberNumber}`, label: "Overview", end: true },
                ...(detail.capabilities.view_accounts
                  ? [{ to: `/members/${memberNumber}/accounts`, label: "Accounts", count: detail.summary.open_accounts }]
                  : []),
                { to: `/members/${memberNumber}/notes`, label: "Notes", count: detail.notes_count },
                ...(detail.capabilities.view_access_log ? [{ to: `/members/${memberNumber}/access-log`, label: "Access log" }] : []),
              ]}
            />
          </div>
        </div>
      )}
      <Outlet context={detail} />
    </>
  );
}

function MemberBand({ detail, inFlow, onNotes }: { detail: MemberDetail; inFlow: boolean; onNotes: boolean }) {
  const { member, branch, capabilities } = detail;
  const navigate = useNavigate();
  const { can } = useAuth();
  const status = MEMBER_STATUS[member.status];
  const kyc = KYC[member.identity.kyc_status];

  return (
    <section className="member-band" aria-label="Member">
      <div className="member-band__inner">
        <div className="member-band__identity">
          <div className="member-band__name">
            <h1>{member.full_name}</h1>
            {member.preferred_name && <span className="member-band__preferred">Goes by {member.preferred_name}</span>}
          </div>
          <div className="member-band__meta">
            <span className="member-band__number">
              <span className="sr-only">Member number </span>
              {member.member_number}
              <CopyButton text={member.member_number} label="Copy member number" />
            </span>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
            {member.is_restricted && (
              <Badge tone="warn" title={member.restriction_reason ?? undefined}>
                <Lock aria-hidden="true" /> Restricted · {member.restriction_reason}
              </Badge>
            )}
            <span>{MEMBERSHIP_TYPE[member.membership_type]}</span>
            <span>
              Member since <strong>{date(member.member_since)}</strong>
            </span>
            <span>
              Branch <strong>{branch.code}</strong> · {branch.name}
            </span>
            <span>
              CIP{" "}
              <Badge tone={kyc.tone} title="Customer Identification Program status">
                {kyc.label}
              </Badge>
            </span>
          </div>
        </div>
        {!inFlow && (
          <div className="member-band__actions">
            {capabilities.add_notes && !onNotes && (
              <Button variant="on-ink" icon={<NotebookPen size={15} aria-hidden="true" />} onClick={() => navigate(`/members/${member.member_number}/notes?compose=1`)}>
                Add note
              </Button>
            )}
            <Button
              variant="on-ink-primary"
              icon={can("accounts.open") ? <FilePlus2 size={15} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
              onClick={() => navigate(`/members/${member.member_number}/accounts/new`)}
              title={can("accounts.open") ? undefined : "Your role can't open sub-accounts"}
            >
              Open sub-account
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function MemberBandSkeleton() {
  return (
    <section className="member-band member-band--skeleton" aria-busy="true" aria-label="Loading member">
      <div className="member-band__inner">
        <div className="member-band__identity">
          <Skeleton width={260} height={20} />
          <div style={{ marginTop: 10, display: "flex", gap: 14 }}>
            <Skeleton width={90} />
            <Skeleton width={70} />
            <Skeleton width={160} />
            <Skeleton width={140} />
          </div>
        </div>
      </div>
    </section>
  );
}

const ALERT_TONE: Record<MemberAlert["severity"], "bad" | "warn" | "info"> = { critical: "bad", warning: "warn", info: "info" };

/** Open alerts, most severe first. Shown at the top of member screens. */
export function MemberAlerts({ alerts }: { alerts: MemberAlert[] }) {
  if (!alerts.length) return null;
  return (
    <div className="alert-strip" aria-label="Member alerts">
      {alerts.map((a) => (
        <Banner key={a.id} tone={ALERT_TONE[a.severity]} title={ALERT_LABEL[a.type]}>
          {a.message}{" "}
          <span className="subtle">
            — {a.created_by}, {date(a.created_at)}
          </span>
        </Banner>
      ))}
    </div>
  );
}
