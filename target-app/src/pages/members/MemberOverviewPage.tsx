import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Eye, EyeOff, IdCard, Landmark, Lock, NotebookPen, Phone, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, ButtonLink } from "../../components/Button";
import { Badge, DL, Panel, Suffix } from "../../components/display";
import { EmptyState, LoadError, SkeletonLines } from "../../components/feedback";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { isApiError } from "../../lib/errors";
import { date, dateNumeric, money, phone, relative, ssnMasked } from "../../lib/format";
import { KYC, MEMBER_STATUS, PREFERRED_CONTACT, RISK } from "../../lib/labels";
import { keys, useMemberDetail } from "../queries";
import { MemberAlerts } from "./MemberLayout";
import { NoteItem } from "./MemberNotesPage";

export function MemberOverviewPage() {
  const detail = useMemberDetail();
  const { member, summary, capabilities } = detail;
  const n = member.member_number;

  return (
    <div className="page">
      <MemberAlerts alerts={detail.alerts} />
      <div className="grid-12">
        <Panel title="Identity" icon={<IdCard size={15} aria-hidden="true" />} className="span-4">
          <DL
            items={[
              ["Legal name", member.full_name],
              [
                "Date of birth",
                <>
                  {dateNumeric(member.date_of_birth)} <span className="subtle">· age {member.age}</span>
                </>,
              ],
              ["SSN", <SsnField memberNumber={n} last4={member.ssn_last4} canReveal={capabilities.reveal_ssn} />],
              [
                "ID on file",
                member.identity.id_document_type ? (
                  <>
                    {member.identity.id_document_type}
                    {member.identity.id_document_state && ` · ${member.identity.id_document_state}`} ·{" "}
                    <span className="masked">••••{member.identity.id_document_last4}</span>
                    <div className="subtle" style={{ fontSize: "var(--fs-sm)" }}>
                      {member.identity.id_document_expires_on && new Date(member.identity.id_document_expires_on) < new Date() ? (
                        <Badge tone="bad">Expired {date(member.identity.id_document_expires_on)}</Badge>
                      ) : (
                        <>Expires {date(member.identity.id_document_expires_on)}</>
                      )}
                    </div>
                  </>
                ) : (
                  "—"
                ),
              ],
              "sep",
              [
                "CIP status",
                <>
                  <Badge tone={KYC[member.identity.kyc_status].tone}>{KYC[member.identity.kyc_status].label}</Badge>
                  {member.identity.kyc_verified_on && <span className="subtle"> · {date(member.identity.kyc_verified_on)}</span>}
                </>,
              ],
              ["Risk rating", <Badge tone={RISK[member.identity.risk_rating].tone}>{RISK[member.identity.risk_rating].label}</Badge>],
            ]}
          />
        </Panel>

        <Panel title="Contact" icon={<Phone size={15} aria-hidden="true" />} className="span-4">
          <DL
            items={[
              [
                "Mailing address",
                <>
                  {member.contact.address_line1}
                  {member.contact.address_line2 && <>, {member.contact.address_line2}</>}
                  <br />
                  {member.contact.city}, {member.contact.state} {member.contact.postal_code}
                </>,
              ],
              ["Mobile", phone(member.contact.phone_mobile)],
              ["Home", phone(member.contact.phone_home)],
              [
                "Email",
                member.contact.email ? (
                  <>
                    {member.contact.email.split("@")[0]}@<wbr />
                    {member.contact.email.split("@")[1]}
                  </>
                ) : (
                  <span className="subtle">None on file</span>
                ),
              ],
              ["Preferred contact", PREFERRED_CONTACT[member.contact.preferred_contact]],
              ["Statements", member.contact.e_statements ? "Electronic" : "Paper (mailed)"],
              "sep",
              ["Employer", member.employment.employer ?? "—"],
              ["Occupation", member.employment.occupation ?? "—"],
            ]}
          />
        </Panel>

        <Panel
          title="Relationship"
          icon={<Landmark size={15} aria-hidden="true" />}
          className="span-4"
          flush
          footer={
            capabilities.view_accounts && (
              <Link to={`/members/${n}/accounts`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
                All accounts <ArrowRight size={13} aria-hidden="true" />
              </Link>
            )
          }
        >
          <div className="panel__body" style={{ paddingBottom: 12 }}>
            <DL
              items={[
                ["Deposits", <span className="num">{money(summary.deposit_total)}</span>],
                ["Available", <span className="num">{money(summary.available_total)}</span>],
                ["Loans & lines", <span className="num">{money(summary.loan_total)}</span>],
                [
                  "Sub-accounts",
                  <>
                    {summary.open_accounts} open
                    {summary.joint_accounts > 0 && <span className="subtle"> · {summary.joint_accounts} joint</span>}
                  </>,
                ],
                ["Last activity", summary.last_activity_on ? date(summary.last_activity_on) : "—"],
              ]}
            />
          </div>
          {capabilities.view_accounts && <MiniAccounts memberNumber={n} />}
        </Panel>

        <Panel
          title="Recent notes"
          icon={<NotebookPen size={15} aria-hidden="true" />}
          count={`· ${detail.notes_count}`}
          className="span-8"
          flush
          actions={
            capabilities.add_notes && (
              <ButtonLink to={`/members/${n}/notes?compose=1`} size="sm" icon={<NotebookPen size={13} aria-hidden="true" />}>
                Add note
              </ButtonLink>
            )
          }
          footer={
            detail.notes_count > 3 && (
              <Link to={`/members/${n}/notes`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}>
                All {detail.notes_count} notes <ArrowRight size={13} aria-hidden="true" />
              </Link>
            )
          }
        >
          {detail.recent_notes.length ? (
            detail.recent_notes.map((note) => <NoteItem key={note.id} note={note} />)
          ) : (
            <EmptyState title="No notes yet">Record calls, visits, and requests so the next person has the context.</EmptyState>
          )}
        </Panel>

        <Panel title="Related members" icon={<Users size={15} aria-hidden="true" />} className="span-4" flush>
          {detail.relationships.length ? (
            <ul className="relation-list">
              {detail.relationships.map((r) => (
                <li key={r.member_number}>
                  <span>
                    <Link to={`/members/${r.member_number}`} style={{ fontWeight: 600 }}>
                      {r.display_name}
                    </Link>{" "}
                    {r.is_restricted && <Lock size={12} className="lock-icon" aria-label="Restricted record" />}
                    <span className="recent-item__sub" style={{ display: "block" }}>
                      {r.relationship} · <span className="mono">{r.member_number}</span>
                    </span>
                  </span>
                  <Badge tone={MEMBER_STATUS[r.status].tone} dot>
                    {MEMBER_STATUS[r.status].label}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No related members">Spouses, custodians, and business partners linked to this membership show here.</EmptyState>
          )}
        </Panel>
      </div>
    </div>
  );
}

function MiniAccounts({ memberNumber }: { memberNumber: string }) {
  const q = useQuery({ queryKey: keys.accounts(memberNumber, false), queryFn: () => api.memberAccounts(memberNumber, false) });
  if (q.isPending) {
    return (
      <div className="panel__body" style={{ borderTop: "1px solid var(--line-soft)" }}>
        <SkeletonLines lines={4} />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="panel__body" style={{ borderTop: "1px solid var(--line-soft)" }}>
        <LoadError error={q.error} onRetry={() => q.refetch()} what="accounts" />
      </div>
    );
  }
  const top = q.data.accounts.slice(0, 6);
  return (
    <ul className="mini-accounts" style={{ borderTop: "1px solid var(--line-soft)" }}>
      {top.map((a) => (
        <li key={a.id}>
          <Suffix value={a.suffix} loan={a.category === "loan"} />
          <Link to={`/members/${memberNumber}/accounts/${a.account_number}`} className="mini-accounts__name" title={a.product_name}>
            {a.nickname ?? a.product_name}
          </Link>
          <span className="num">{money(a.current_balance)}</span>
        </li>
      ))}
    </ul>
  );
}

const REVEAL_SECONDS = 30;

/** Masked SSN with an audited, time-limited reveal. */
function SsnField({ memberNumber, last4, canReveal }: { memberNumber: string; last4: string; canReveal: boolean }) {
  const toast = useToast();
  const [shown, setShown] = useState<{ ssn: string; at: number } | null>(null);
  const [left, setLeft] = useState(REVEAL_SECONDS);
  const reveal = useMutation({
    mutationFn: () => api.revealSsn(memberNumber),
    onSuccess: (r) => setShown({ ssn: r.ssn, at: Date.now() }),
    onError: (e) =>
      toast.show({
        tone: "bad",
        title: isApiError(e) && e.kind === "permission_denied" ? "You can't reveal SSNs" : "Couldn't reveal the SSN",
        text: isApiError(e) && e.reference ? `Reference ${e.reference}` : undefined,
      }),
  });

  useEffect(() => {
    if (!shown) return;
    const t = window.setInterval(() => {
      const remaining = REVEAL_SECONDS - Math.floor((Date.now() - shown.at) / 1000);
      if (remaining <= 0) {
        setShown(null);
        setLeft(REVEAL_SECONDS);
      } else setLeft(remaining);
    }, 250);
    return () => window.clearInterval(t);
  }, [shown]);

  return (
    <span className="ssn-row">
      <span className="masked" aria-live="polite">
        {shown ? shown.ssn : ssnMasked(last4)}
      </span>
      {canReveal &&
        (shown ? (
          <Button size="sm" variant="ghost" icon={<EyeOff size={13} aria-hidden="true" />} onClick={() => setShown(null)}>
            Hide ({left}s)
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon={<Eye size={13} aria-hidden="true" />} loading={reveal.isPending} onClick={() => reveal.mutate()}>
            Reveal
          </Button>
        ))}
      {shown && <span className="sr-only">Revealed {relative(new Date(shown.at).toISOString())}. Hides automatically.</span>}
    </span>
  );
}
