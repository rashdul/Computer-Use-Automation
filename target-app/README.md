# Rashed Federal Credit Union: Member Services Console

A synthetic internal banking application used as the **target system** for the
computer-use automation project. Staff search for members, review their
accounts, and open sub-accounts through a Member Search → Member Details →
Accounts → Open Sub-Account → Review → Confirmation flow.

It behaves like real credit-union software: role-based permissions, restricted
records, compliance blockers, audit logging, and server-side validation. It also
has an **Environment controls** page where an administrator can switch on slow
responses, outages, timeouts, unexpected dialogs, maintenance notices, and
short idle timeouts, so the same flow can be run under harder conditions.

All people, SSNs, phone numbers, and emails are synthetic: SSNs start with 9 and
are not ITINs, phone numbers use the 555 exchange, and emails use the reserved
`example.*` domains.

**Try it without installing anything:** <https://rashed-federal-credit-union.netlify.app>.
Sign in with any account from [Staff sign-ins](#staff-sign-ins). The rest of
this README is for running your own copy.

> The UI has no `data-testid` or other automation-only hooks by design. Anything
> automating it has to go by what a person sees: labels, roles, and visible text.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 19, React Router 7 (data router), TanStack Query 5, TypeScript (strict), Vite 7 |
| UI | Hand-written CSS design tokens (no UI kit), Public Sans / Libre Caslon Text / IBM Plex Mono, lucide icons |
| Backend | Supabase: Postgres 17, Auth (password sign-in), PostgREST RPC |
| Tests | Python Playwright walkthroughs (`tests/ui/`) |

## Run it

Requires Node 22 LTS (Node 20.19+ also works for the dev server) and a Supabase
project loaded with the [schema and seed data](#database).

```bash
cd target-app
npm install
cp .env.example .env.local   # then fill in the two values below
npm run dev                  # http://localhost:5173
```

| Variable in `.env.local` | What it is |
| --- | --- |
| `VITE_SUPABASE_URL` | The Supabase project URL, `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The project's publishable key (`sb_publishable_…`). It is safe in a browser bundle because every table is closed to the Data API and each RPC checks the caller's session and role. |

`.env.local` is git-ignored. The Python test scripts and the automation's `demo:env` helper read the same file.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Type-checks, then builds to `dist/` |
| `npm run preview` | Serves the built `dist/` locally |
| `npm run typecheck` | Type check only |

A deployed copy runs at `https://rashed-federal-credit-union.netlify.app`. Netlify builds it with the repository root's `netlify.toml` (base `target-app`, Node 22, SPA redirect to `index.html`).

### Staff sign-ins

Sign in with the username alone, for example `aokafor`; the console adds the
internal email domain. Passwords are in
[`STAFF_CREDENTIALS.local.md`](STAFF_CREDENTIALS.local.md).

> That file is committed on purpose. RFCU is not a real app, and its 25 staff
> accounts are synthetic test accounts.

| Username | Role | Use it for |
| --- | --- | --- |
| `aokafor` | Member Service Representative (Baltimore, BAL-MSR-04) | The main flow: search, view, and open sub-accounts |
| `jlin` | Teller | Permission-denied cases: can view but can't open accounts or reveal SSNs |
| `mreyes` | Branch Manager | Restricted records and the member access log |
| `dwhitfield` | System Administrator | Administration: environment controls, staff, permissions, audit |

Compliance officers and the other staff are listed in the credentials file.

#### Re-provisioning staff

To generate new random passwords (for example, for a fresh Supabase project):

```bash
pip install bcrypt
python target-app/scripts/provision_staff.py   --sql target-app/supabase/seed/.generated/02_staff.sql   --credentials target-app/STAFF_CREDENTIALS.local.md
```

| Argument | Required | What it does |
| --- | --- | --- |
| `--sql <file>` | yes | Where to write the seed SQL that creates the `auth.users` / `auth.identities` rows and `core.staff` profiles. It holds bcrypt hashes only. The `.generated/` folder is git-ignored. |
| `--credentials <file>` | yes | Where to write the plaintext username/password table. Overwrites the existing file. |

Then load the new SQL file as seed step 02 (see below).

## Database

The SQL files in `supabase/migrations/` build the schema; apply them in
filename order. The files in `supabase/seed/` load the data; run them in
numeric order, with `seed/.generated/02_staff.sql` (from
[re-provisioning](#re-provisioning-staff)) second.

| Table | Rows |
| --- | ---: |
| Members | 50,000 |
| Sub-accounts (share, checking, money market, certificates, IRAs, loans) | 151,939 |
| Posted transactions | 985,393 |
| Member notes | ~28,000 |
| Relationships (spouse, custodian, business partner, …) | 20,316 |
| Account parties (joint owners, beneficiaries, custodians) | 15,880 |
| Member alerts | 5,410 |
| Audit history | ~51,000 |
| Branches / products / staff | 8 / 21 / 25 |

These counts were taken after seeding. Notes and audit rows grow as the console is used.

### Security model

- **Tables are closed.** The tables live in the `core` schema with row-level
  security on, no policies, and every privilege revoked from `anon` and
  `authenticated`. The Data API can't read or write them.
- **Every operation is an RPC.** `public` has thin `SECURITY INVOKER` wrappers.
  Only `authenticated` can execute them, and each one calls a
  `SECURITY DEFINER` function in the unexposed `private` schema.
- **Each call is checked server-side.** Every call verifies that the JWT's
  session still exists in `auth.sessions`, so ending a session takes effect
  immediately. It also checks that the staff profile is active and that the
  role has the permission. Restricted records and denials are recorded in
  `core.audit_log` with an `AUD-…` reference that staff can quote.
- **Administration needs a fresh password.** Admin functions require a
  password sign-in within the last 15 minutes (`amr` claim). The console
  asks for the password when you open Administration.
- **Segregation of duties.** System administrators manage access but can't
  open accounts. An administrator can't remove their own admin access or
  change their own role.
- **Idempotent account opening.** Opening an account takes a client request
  ID and a per-member lock. Submitting the same application again returns
  the original receipt instead of opening a second account.

Errors use a consistent envelope: `RF404` not found, `RF403` permission denied
(with an audit reference), `RF409` business rule (ineligible, duplicate
product), `RF422` field validation, `RF428` password confirmation required, and
`PT401`/`PT403` for ended sessions or disabled accounts.

## Scenario catalogue

These seeded members give each business outcome a fixed trigger. They are also
listed under **Administration → Test data**.

| Scenario | Member | Sign in as | What happens |
| --- | --- | --- | --- |
| Happy path | 1030966 | `aokafor` | Open a 12-Month Share Certificate from S00; confirmation with an `OA…` number |
| Joint ownership | 1000021 | `aokafor` | Spouse added as joint owner; listed on the receipt |
| Member not found | 9999999 | `aokafor` | No search results; `/members/9999999` shows “Member not found” |
| Restricted record | 1000672 | `aokafor` | Employee account: “Permission denied” with an `AUD-…` reference |
| Legal hold | 1002515 | `mreyes` | Manager can open the record; account opening is blocked |
| Teller can't open | 1030966 | `jlin` | Open sub-account → “Permission denied” |
| Administrators can't transact | 1030966 | `dwhitfield` | Open sub-account → “Permission denied” |
| Deceased | 1000222 | `aokafor` | Critical alert; opening blocked |
| OFAC review | 1002123 | `aokafor` | Opening blocked until Compliance clears the match |
| CIP expired | 1000028 | `aokafor` | Opening blocked: re-verify ID |
| Dormant | 1000204 | `aokafor` | Opening blocked: reactivate the membership |
| No email on file | 1000082 | `aokafor` | Electronic statements fail validation |
| Insufficient funds | 1000564 | `aokafor` | Transfer amount exceeds S00's available balance |
| Minor | 1068311 | `aokafor` | Certificates and IRAs unavailable (age requirement) |
| Duplicate product | 1001544 | `aokafor` | Second 12-month certificate asks for confirmation |
| Large relationship | 1057101 | `aokafor` | Long account list and history |

To put these members back to their seeded state, run
`python tests/ui/reset_scenarios.py` (see [Tests](#tests)). The reset reverses
accounts opened from the console and refunds their transfers.

## Error states and how to trigger them

| State | Trigger |
| --- | --- |
| Member not found | Search `9999999`, or open `/members/9999999` |
| Permission denied | Restricted record 1000672 as `aokafor`; Open sub-account as `jlin`; `/admin` as anyone but a system administrator |
| Field validation | Submit the empty sub-account form; no email (1000082); insufficient funds (1000564); a 6-digit member number such as `103096` in search |
| Business-rule blocks | Deceased, OFAC, CIP expired, dormant, legal hold, minor, duplicate product (see above) |
| Slow loading | Environment controls → Network latency. Screens show “Still loading …” with a seconds counter after the notice threshold |
| Request timeout | Latency above **Time out after**. Shows “The request timed out” with a `TMO-…` reference and **Try again** |
| Service outage | Environment controls → Failure injection. Shows “Core banking service unavailable” with an `SVC-…` reference |
| Unexpected dialog | Environment controls → Unexpected dialogs: maintenance notice, BSA/AML attestation (two steps), password expiry, printer offline (retry), sign-in on another workstation. Each can target a specific screen at a set probability and delay. Escape doesn't dismiss them |
| Maintenance banner | Environment controls → Maintenance banner |
| Session expired (idle) | Environment controls → Idle timeout. A countdown warning appears first, then “You were signed out after a period of inactivity” |
| Session ended | Environment controls → **End all other sessions now**. The other user's next action shows “Your session has ended” |
| Unsaved changes | Leave a partly filled sub-account form. The console asks you to confirm leaving |

Environment changes reach signed-in staff within 30 seconds, or sooner when
they switch back to the window. Session, reference, and administration calls
are never slowed or failed, so an administrator can always turn the controls
off again. After an idle or ended session, signing in again returns to the
same screen, and an account application in progress is kept for that user in
that browser tab.

## Tests

Python Playwright walkthroughs sign in as the personas above. They use only
roles, labels, and visible text, take 1440×900 screenshots into
`test-output/screenshots/` (git-ignored), and make 127 checks in total.

| Script | Covers |
| --- | --- |
| `recon.py` | Sign-in page, validation, wrong password, landing |
| `walk_members.py` | Search (every query type), member overview, SSN reveal, accounts, ledger filters, notes, activity, sign-out |
| `walk_opening.py` | The full opening flow and every business outcome in the catalogue |
| `walk_admin.py` | Teller and admin denials, password confirmation, each Administration section, manager access |
| `walk_faults.py` | Slow loading, timeout, outage, all five dialogs, banner, timeout while opening with a safe retry, admin-ended session and resume, idle timeout |

The walkthroughs expect the dev server on `http://localhost:5173`. They read
passwords from `STAFF_CREDENTIALS.local.md` and never print them.

```bash
pip install playwright bcrypt
python -m playwright install chromium

npm run dev                          # terminal 1, in target-app/
python tests/ui/run_all.py           # terminal 2, in target-app/
```

| Command | Arguments | What it does |
| --- | --- | --- |
| `python tests/ui/run_all.py [script ...]` | Optional walkthrough file names, for example `walk_faults.py`. Default: all five, in the order above. | Resets scenario data and environment controls, runs the walkthroughs, resets again, and exits non-zero if any failed |
| `python tests/ui/reset_scenarios.py [--environment]` | `--environment` also turns off every Environment control. Without it, only the scenario members are reset. | Signs in as `dwhitfield` and calls the audited `admin_reset_scenarios` RPC |

## Layout

```
src/
  auth/          sign-in, session restore, idle timeout, session-ended pages
  environment/   unexpected-dialog host
  layout/        app shell: sidebar, top bar, breadcrumbs, quick find
  lib/           RPC client (fault injection, error mapping), types, formatting
  pages/         members, opening flow, admin, reference pages, state pages
  components/    buttons, forms, tables, modals, toasts, feedback states
  styles/        tokens, base, components, shell, pages
supabase/
  migrations/    schema, helpers, member / opening / admin APIs, public wrappers
  seed/          reproducible seed SQL (staff SQL is generated, git-ignored)
scripts/         staff provisioning (provision_staff.py)
tests/ui/        Playwright walkthroughs and scenario reset
```
