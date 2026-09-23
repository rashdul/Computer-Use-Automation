"""Provision staff sign-ins for the Member Services console.

Generates a strong random password per staff member, hashes it locally with
bcrypt (the format Supabase Auth verifies), and writes:

  * a SQL file that creates the auth.users / auth.identities rows and the
    matching core.staff profiles (hashes only — no plaintext), and
  * a credentials file for the people running the UAT environment.

Both outputs are git-ignored. Plaintext passwords never leave this machine.

Usage:
    python target-app/scripts/provision_staff.py \
        --sql target-app/supabase/seed/.generated/02_staff.sql \
        --credentials target-app/STAFF_CREDENTIALS.local.md
"""

from __future__ import annotations

import argparse
import secrets
import string
import uuid
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import bcrypt

EMAIL_DOMAIN = "rashedfcu.internal"  # .internal is reserved for private networks
SYMBOLS = "!#%+=?@^_-"
AUTH_INSTANCE = "00000000-0000-0000-0000-000000000000"


@dataclass(frozen=True)
class Staff:
    username: str
    full_name: str
    title: str
    role: str
    branch_id: int
    workstation: str
    employee_id: str
    persona: bool = False  # the documented test sign-ins
    active: bool = True


ROSTER: list[Staff] = [
    Staff("dwhitfield", "Dana Whitfield", "Systems Administrator", "system_admin", 1, "BAL-ADM-01", "E10017", persona=True),
    Staff("mreyes", "Marcus Reyes", "Branch Manager", "branch_manager", 2, "TWS-MGR-01", "E10288", persona=True),
    Staff("aokafor", "Adaeze Okafor", "Member Service Representative II", "member_service_rep", 1, "BAL-MSR-04", "E10431", persona=True),
    Staff("jlin", "Jenny Lin", "Teller", "teller", 1, "BAL-TLR-07", "E10562", persona=True),
    Staff("tbrennan", "Thomas Brennan", "BSA/AML Compliance Officer", "compliance_officer", 1, "BAL-CMP-02", "E10133", persona=True),
    Staff("kpatel", "Kiran Patel", "Member Service Representative", "member_service_rep", 3, "COL-MSR-02", "E10614"),
    Staff("lnguyen", "Linh Nguyen", "Teller", "teller", 5, "SSP-TLR-03", "E10679"),
    Staff("rcoleman", "Renee Coleman", "Branch Manager", "branch_manager", 1, "BAL-MGR-01", "E10045"),
    Staff("jharris", "Jamal Harris", "Senior Teller", "teller", 8, "GLB-TLR-01", "E10388"),
    Staff("sgarcia", "Sofia Garcia", "Member Service Representative", "member_service_rep", 5, "SSP-MSR-01", "E10702"),
    Staff("bthompson", "Brian Thompson", "Teller", "teller", 4, "ANP-TLR-02", "E10733"),
    Staff("mhaddad", "Maya Haddad", "Member Service Representative", "member_service_rep", 6, "DCK-MSR-01", "E10591"),
    Staff("dkim", "Daniel Kim", "Branch Manager", "branch_manager", 3, "COL-MGR-01", "E10204"),
    Staff("owashington", "Olivia Washington", "Teller", "teller", 6, "DCK-TLR-02", "E10755"),
    Staff("pmurphy", "Patrick Murphy", "Member Service Representative", "member_service_rep", 4, "ANP-MSR-01", "E10467"),
    Staff("cadeyemi", "Chioma Adeyemi", "Teller", "teller", 2, "TWS-TLR-04", "E10781"),
    Staff("ewilliams", "Ethan Williams", "Member Service Representative", "member_service_rep", 7, "ARL-MSR-02", "E10640"),
    Staff("gsantos", "Gabriela Santos", "Branch Manager", "branch_manager", 7, "ARL-MGR-01", "E10311"),
    Staff("tjohnson", "Tyrone Johnson", "Teller", "teller", 1, "BAL-TLR-03", "E10523"),
    Staff("aschmidt", "Anna Schmidt", "Compliance Analyst", "compliance_officer", 1, "BAL-CMP-04", "E10699"),
    Staff("rali", "Rami Ali", "Member Service Representative", "member_service_rep", 8, "GLB-MSR-01", "E10718"),
    Staff("hbrooks", "Hannah Brooks", "Teller", "teller", 3, "COL-TLR-05", "E10796"),
    Staff("vramirez", "Victor Ramirez", "IT Security Administrator", "system_admin", 1, "BAL-ADM-02", "E10092"),
    Staff("nokeke", "Nnamdi Okeke", "Branch Manager", "branch_manager", 5, "SSP-MGR-01", "E10257"),
    Staff("cmorgan", "Carla Morgan", "Teller", "teller", 2, "TWS-TLR-02", "E10409", active=False),
]

BRANCH_CODES = {1: "BAL", 2: "TWS", 3: "COL", 4: "ANP", 5: "SSP", 6: "DCK", 7: "ARL", 8: "GLB"}


def strong_password(length: int = 20) -> str:
    """Random password with at least two of each character class."""
    alphabet = string.ascii_letters + string.digits + SYMBOLS
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (
            sum(c.islower() for c in pw) >= 2
            and sum(c.isupper() for c in pw) >= 2
            and sum(c.isdigit() for c in pw) >= 2
            and sum(c in SYMBOLS for c in pw) >= 2
            and pw[0] not in SYMBOLS  # easier to type and paste
        ):
            return pw


def bcrypt_hash(password: str) -> str:
    # $2a$ is the prefix Supabase Auth (Go bcrypt) writes itself.
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10, prefix=b"2a")).decode()


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build(roster: list[Staff]) -> tuple[str, list[tuple[Staff, str]]]:
    credentials: list[tuple[Staff, str]] = []
    rows: list[str] = []

    for s in roster:
        password = strong_password(24 if s.role == "system_admin" else 20)
        credentials.append((s, password))
        rows.append(
            "  ("
            + ", ".join(
                [
                    sql_literal(str(uuid.uuid4())) + "::uuid",
                    sql_literal(s.username),
                    sql_literal(bcrypt_hash(password)),
                    sql_literal(s.employee_id),
                    sql_literal(s.full_name),
                    sql_literal(s.title),
                    sql_literal(s.role),
                    str(s.branch_id),
                    sql_literal(s.workstation),
                    "true" if s.active else "false",
                ]
            )
            + ")"
        )

    rows_sql = ",\n".join(rows)
    sql = f"""-- Generated by target-app/scripts/provision_staff.py — contains bcrypt hashes only.
begin;

create temporary table staff_seed (
  id uuid, username text, password_hash text, employee_id text, full_name text,
  title text, role text, branch_id smallint, workstation text, is_active boolean
) on commit drop;

insert into staff_seed values
{rows_sql};

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token,
  is_sso_user, is_anonymous
)
select '{AUTH_INSTANCE}', s.id, 'authenticated', 'authenticated', s.username || '@{EMAIL_DOMAIN}', s.password_hash, now(),
       '{{"provider": "email", "providers": ["email"]}}'::jsonb, jsonb_build_object('full_name', s.full_name), now(), now(),
       '', '', '', '', '', '', '', '', false, false
from staff_seed s;

insert into auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
select gen_random_uuid(), s.id, s.id::text,
       jsonb_build_object('sub', s.id::text, 'email', s.username || '@{EMAIL_DOMAIN}', 'email_verified', true, 'phone_verified', false),
       'email', now(), now()
from staff_seed s;

insert into core.staff (id, employee_id, username, full_name, title, role, branch_id, workstation, is_active)
select s.id, s.employee_id, s.username, s.full_name, s.title, s.role::core.staff_role, s.branch_id, s.workstation, s.is_active
from staff_seed s;

commit;
"""
    return sql, credentials


def credentials_markdown(credentials: list[tuple[Staff, str]]) -> str:
    lines = [
        "# Staff sign-ins — UAT (LOCAL ONLY, DO NOT COMMIT)",
        "",
        f"Generated {date.today().isoformat()} by `target-app/scripts/provision_staff.py`.",
        "Sign in with the **username** (the console adds the internal email domain).",
        "",
        "## Test personas",
        "",
        "| Username | Name | Role | Branch | Password |",
        "|---|---|---|---|---|",
    ]
    for s, pw in credentials:
        if s.persona:
            lines.append(f"| `{s.username}` | {s.full_name} | {s.title} | {BRANCH_CODES[s.branch_id]} | `{pw}` |")
    lines += ["", "## Other staff", "", "| Username | Name | Role | Branch | Active | Password |", "|---|---|---|---|---|---|"]
    for s, pw in credentials:
        if not s.persona:
            lines.append(
                f"| `{s.username}` | {s.full_name} | {s.title} | {BRANCH_CODES[s.branch_id]} | {'yes' if s.active else 'no'} | `{pw}` |"
            )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sql", required=True, type=Path)
    parser.add_argument("--credentials", required=True, type=Path)
    args = parser.parse_args()

    sql, credentials = build(ROSTER)
    args.sql.parent.mkdir(parents=True, exist_ok=True)
    args.sql.write_text(sql, encoding="utf-8")
    args.credentials.write_text(credentials_markdown(credentials), encoding="utf-8")
    print(f"wrote {args.sql} ({len(ROSTER)} staff) and {args.credentials}")


if __name__ == "__main__":
    main()
