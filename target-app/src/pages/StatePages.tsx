import { ArrowLeft, Search } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { Button, ButtonLink } from "../components/Button";
import { DL } from "../components/display";
import { StatePage } from "../components/feedback";
import { Field, Input } from "../components/form";
import type { ApiError } from "../lib/errors";

/** 403 from the server: shows what was blocked, why, and the audit reference. */
export function PermissionDenied({ error, subject }: { error: ApiError; subject?: string }) {
  const navigate = useNavigate();
  const { context } = useAuth();
  const d = error.permission;
  const restricted = d.context === "restricted_record";

  return (
    <div className="page">
      <StatePage
        tone="bad"
        code="Error 403 · Permission denied"
        title={restricted ? "You don't have access to this record" : "You don't have permission to do this"}
        facts={
          <DL
            items={[
              ["Attempted", restricted ? `Open member ${d.member_number ?? ""}` : (d.context ?? subject ?? "This action")],
              ...(restricted && d.restriction ? ([["Record type", `Restricted · ${d.restriction}`]] as [string, string][]) : []),
              ["Permission needed", d.permission_label ?? d.permission ?? "—"],
              ["Your role", d.role_label ?? context?.staff.role_label ?? "—"],
              ["Audit reference", <span className="mono">{error.reference ?? "—"}</span>],
            ]}
          />
        }
        actions={
          <>
            <Button icon={<ArrowLeft size={15} aria-hidden="true" />} onClick={() => navigate(-1)}>
              Go back
            </Button>
            <ButtonLink to="/members" variant="primary" icon={<Search size={15} aria-hidden="true" />}>
              Member search
            </ButtonLink>
          </>
        }
        foot="This attempt was recorded. If your job needs this access, ask a branch manager to request it from Administration, and quote the audit reference."
      >
        {restricted
          ? "This member is a restricted record. Your role can find it in search, but only branch managers and compliance staff can open it."
          : `Your role (${d.role_label ?? context?.staff.role_label ?? "current role"}) doesn't include the "${d.permission_label ?? d.permission}" permission.`}
      </StatePage>
    </div>
  );
}

/** 404 for a member number that doesn't exist, with a way to search again. */
export function MemberNotFound({ memberNumber }: { memberNumber: string }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState(memberNumber);
  const invalid = !/^\d{7}$/.test(memberNumber);
  return (
    <div className="page">
      <StatePage
        tone="warn"
        code="Error 404 · Member not found"
        title="Member not found"
        actions={
          <form
            style={{ display: "flex", gap: 8, alignItems: "flex-end", width: "100%" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) navigate(`/members?q=${encodeURIComponent(query.trim())}`);
            }}
          >
            <Field label="Search again" className="grow" hint="Name, member number, SSN, phone, or email">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 280 }} />
            </Field>
            <Button type="submit" variant="primary" icon={<Search size={15} aria-hidden="true" />}>
              Search
            </Button>
          </form>
        }
        foot="Memberships that were merged or purged keep their number on the surviving record. Ask the member for a statement if the number doesn't match."
      >
        {invalid ? (
          <>
            <span className="mono">{memberNumber}</span> isn't a valid member number. Member numbers are 7 digits.
          </>
        ) : (
          <>
            No membership matches member number <span className="mono">{memberNumber}</span>. Check the number with the member, or search by
            name or SSN instead.
          </>
        )}
      </StatePage>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <StatePage
        tone="neutral"
        code="Error 404"
        title="This page doesn't exist"
        actions={
          <ButtonLink to="/members" variant="primary" icon={<Search size={15} aria-hidden="true" />}>
            Go to member search
          </ButtonLink>
        }
      >
        The address may be mistyped, or the page was moved. Use the navigation on the left to find what you need.
      </StatePage>
    </div>
  );
}
