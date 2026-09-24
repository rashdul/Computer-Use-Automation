# RFCU Computer-Use Automation

A working vertical slice for the interface.ai take-home: **natural-language goal → real RFCU login → live LLM discovery → versioned capability → deterministic replay → typed result**.

The existing RFCU Member Services app is preserved. The implemented capability returns the **current balance of the requested member’s primary savings share (S00)**, rather than total deposits or available funds. RFCU uses seven-digit member numbers.

## Architecture

```
CLI / local operator console
         │
         ├─ Discovery → Codex CLI OR OpenAI API → one decision per observation
         │                                      │
         └─ Replay → saved capability ───────────┤ (no model calls)
                                                ▼
                              policy → session → Playwright surface
                                                ▼
                                  RFCU login → member → S00

Shared: typed schemas, ordered locators, checkpoints, redacted evidence,
        control ownership, same-context operator intervention.
```

`automation/` contains the new runtime and a loopback Express operator server. `target-app/` remains the React/Vite/Supabase application. The automation does not call RFCU RPCs, query the database, inject storage, or insert cookies. See [the repository inspection](docs/REPOSITORY_INSPECTION.md) and [REPORT.md](REPORT.md).

## Prerequisites and installation

- Node.js **22+**, npm, and a Playwright-supported OS. The existing target app’s Supabase packages declare Node 22 as their minimum.
- An RFCU Supabase project provisioned with the existing migrations, seed data and staff identities; network access to that project.
- For discovery, **either** an authenticated Codex CLI **or** your own OpenAI API key. Replay needs neither.

From the repository root:

```sh
npm ci
npm --prefix target-app ci
npx playwright install chromium
```

On Linux, `npx playwright install --with-deps chromium` installs browser system dependencies too. If a browser download is unavailable, an installed Chrome/Edge can be selected with `RFCU_BROWSER_CHANNEL=chrome` or `msedge` in the automation environment file.

### Target application setup

If the original RFCU environment is already configured, retain it. On a fresh clone:

1. Follow [target-app/README.md](target-app/README.md#database) to apply SQL migrations and seeds to **your own synthetic UAT project**. Provision staff using the existing `target-app/scripts/provision_staff.py`; apply its generated staff SQL after reference seed `01` and before seed `03`. Python and `bcrypt` are required only for provisioning. Never apply test seeds to a real institution.
2. Copy `target-app/.env.example` to `target-app/.env.local`, then set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Do not use a service-role key in the browser.
3. Keep provisioned staff credentials at **`target-app/STAFF_CREDENTIALS.local.md`**. The provisioner writes a Markdown table. Alternatively, copy `target-app/STAFF_CREDENTIALS.example.md` to that local filename and fill in an **existing provisioned** staff account:

   ```text
   Username: YOUR_LOCAL_USERNAME
   Password: YOUR_LOCAL_PASSWORD
   ```

   This file does not create a staff account. Use a Member Service Representative for the demonstrated capability. With the provisioner’s table, the loader selects the first MSR unless `RFCU_STAFF_USERNAME` selects another row. Both formats are tested. The real file, generated staff SQL, and all local environment files are Git-ignored.

The root `.env` used for earlier database provisioning is not read by the automation. No database password is needed by discovery or replay. There is no offline replacement for the real RFCU backend; unit/DOM tests run without it.

### Choose the discovery provider

Copy `automation.env.example` to **`automation.env.local`**. On PowerShell use `Copy-Item`; on macOS/Linux use `cp`.

**Option A — your Codex login**

```text
DISCOVERY_PROVIDER=codex
RFCU_ORIGIN=http://localhost:5173
OPERATOR_PORT=4310
```

Install the [official Codex CLI](https://developers.openai.com/codex/cli/) if needed, then run:

```sh
codex login
codex login status
```

Use a current CLI supporting `exec --ephemeral --ignore-user-config --output-schema`. The provider invokes one decision in an empty temporary directory, disables shell/web tools, and passes only the sanitized goal, rendered observation and completed steps. It does not copy your Codex authentication into this repository. `CODEX_MODEL` optionally selects a model; otherwise your CLI's default applies. `CODEX_BIN` can specify the executable path if it is not on PATH.

**Option B — your OpenAI API key**

```text
DISCOVERY_PROVIDER=openai
OPENAI_API_KEY=YOUR_OWN_API_KEY
OPENAI_MODEL=gpt-4.1
RFCU_ORIGIN=http://localhost:5173
OPERATOR_PORT=4310
```

The adapter uses [Responses structured output](https://developers.openai.com/api/docs/guides/structured-outputs), with `store:false`, a 120-second deadline, and schema validation before any action. API billing/access belongs to the developer. Never put a model key or RFCU password in source files. The checked-in genuine discovery evidence used Codex; the OpenAI transport has a contract test, but no live API-key run was performed in this workspace.

## Exact demo path

### Local or deployed RFCU

`RFCU_ORIGIN` selects the single application the automation may operate. It defaults to `http://localhost:5173`; it can also be the **HTTPS origin of your deployed RFCU**, for example `https://your-rfcu.example`. A trailing slash is accepted. Do not include `/login` in this environment value. Remote HTTP is rejected. An optional comma-separated `RFCU_ALLOWED_ORIGINS` further restricts which configured deployment may be selected; it does not permit a run to move between origins.

The operator console stays on localhost. For a deployed target, `npm run operator` is sufficient. Set `RFCU_BACKEND_ORIGIN` if that deployment uses a different backend from `target-app/.env.local`. The adapter still expects the RFCU application, its routes and its semantic controls; this is not unrestricted automation of arbitrary websites. Credentials must belong to that target deployment.

Restart the operator after environment changes. Capabilities remain bound to the origin where they were discovered: rediscover on a new deployment before replaying there. A localhost artifact is intentionally rejected against a different origin.

### Search by member name

In the console choose **Search by → Name**, enter the member's name, then choose discovery or replay. Select `get-member-savings-balance-by-name` from the catalog for its saved replay; the existing `get-member-savings-balance` capability continues to use a seven-digit ID.

```sh
npm run discovery -- --goal "Log in to RFCU and return the current savings balance for the supplied member name" --member-name "FULL MEMBER NAME" --profile savings --capability get-member-savings-balance-by-name
npm run replay -- --capability get-member-savings-balance-by-name --member-name "ANOTHER MEMBER NAME"
```

Use an actual name from your synthetic RFCU data. First name, last name or a fuller name can be searched, but execution proceeds only when the UI reports **exactly one match**. A partial name returning several members produces `MEMBER_AMBIGUOUS`; retry with a more specific name or use the member-number capability. No result produces `MEMBER_NOT_FOUND`. The adapter reads the member ID from that unique rendered result and then restricts all member/account routes to it. It does not choose the first result or query the database.

The focused savings name capabilities use schema `1.1` and an explicit `member_resolved` checkpoint. The member name and resolved member number are parameterized in artifacts/logs; resolved names are not sent to the model. Schema `1.0` ID capabilities remain supported. Supply exactly one of `member_id` and `member_name` through the API; the CLI equivalent is `--member-id` or `--member-name`.

### Start and run the ID demonstration

Terminal 1, from the root:

```sh
npm run dev
```

This starts RFCU at **http://localhost:5173/login** and the operator console at **http://localhost:4310**. For RFCU alone: `npm --prefix target-app run dev`. For the operator alone: `npm run operator`.

Terminal 2:

```sh
npm run discovery -- --goal "Log in to RFCU, look up member 1030966, and return their current savings balance." --start-url http://localhost:5173/login --member-id 1030966 --profile savings --capability get-member-savings-balance --evidence-group discovery
npm run replay -- --capability get-member-savings-balance --member-id 1000021 --evidence-group replay-success
npm run replay -- --capability get-member-savings-balance --member-id 9999999 --evidence-group replay-error
```

Discovery really observes the page after each executed action; it does not generate a script first. Each successful discovery writes `artifacts/get-member-savings-balance.json` and increments its artifact version. A previously discovered artifact is included, so replay can be demonstrated immediately without model access. Do not run two operator-server jobs simultaneously; the server returns `RUN_ACTIVE` until the current one finishes.

The first discovery in the evidence returned USD `23693.68`; replay for the different seeded member returned USD `1663.00`. These are observed synthetic balances, not hard-coded expected values. The nonexistent member returns:

```json
{
  "status": "business_outcome",
  "code": "MEMBER_NOT_FOUND",
  "message": "No member matches the requested ID",
  "runId": "..."
}
```

A restricted record demonstrates a hard failure:

```sh
npm run replay -- --capability get-member-savings-balance --member-id 1000672 --evidence-group replay-error
```

Six-digit IDs are rejected before launching a browser. CLI exit codes: success/business outcome `0`, runtime failure `1`, setup/request error `2`.

### General RFCU workflows and approval

The default discovery profile is **general**. In the console choose a goal example or write your own, give the capability a unique ID, and supply parameters under **Additional inputs (JSON)**. Choose **Search by ? No member** for product/reference or administration tasks. For replay, select a saved capability and click **Use selected capability**, then fill its declared parameters. A different goal requires discovery first; replay executes the selected artifact, not a newly typed goal.

```sh
npm run discovery -- --goal "Log in and return the product codes, rates and minimum opening deposits from Product rates" --capability read-product-rates
npm run replay -- --capability read-product-rates --evidence-group replay-success
npm run discovery -- --goal "Log in, find the supplied member, open Accounts through Member record navigation, and return the visible deposit accounts and current balances as a table" --member-id 1000021 --capability list-member-accounts
npm run replay -- --capability list-member-accounts --member-id 1030966
npm run discovery -- --goal "Log in, find the supplied member, prepare a new note using category and note_body, verify the fields and stop without saving" --member-id 1000021 --input category=Service --input "note_body=Demonstration note; do not save" --capability prepare-member-note
npm run replay -- --capability prepare-member-note --member-id 1030966 --input category=Service --input "note_body=Different demonstration note; do not save"
```

For longer or private inputs, use `--inputs-file .runtime/inputs.json` instead of command-line values. This must be a JSON object of named strings, for example `{"member_id":"1000021","category":"Service","note_body":"Demonstration note"}`. Keep that file local and ignored. Supplied values become symbolic references in artifacts; unused or missing replay parameters are rejected. Input names use snake_case. Checkboxes take the strings `"true"` or `"false"`; selects take the visible option label.

The general profile covers the existing RFCU member, account, note, product, activity, account-opening and administration routes. It supports click, fill, select, check, navigate, wait and extraction of text, money, numbers, booleans or explicit table columns. Staff permissions still apply. This is a general execution framework for RFCU, not a claim that every combination of form, role and business rule has been verified. SSN reveal and bulk private-record extraction remain excluded.

**Changes require human approval.** If a goal requests saving a note, opening an account or changing administration settings, the console pauses at the action and displays **Approve once** / **Deny and stop** alongside the live page. Inspect the actual form before approving. Approval binds to that action, URL and current form values; editing the form invalidates it. It is never saved in a capability, so replay asks again. Administrative inputs that may autosave also require approval. The browser permits at most one page-scoped mutation RPC for the approved action. An attempted mutation is not automatically retried after a failure because its outcome may be uncertain.

Starting a run authorizes its normal UI login; it does not authorize financial or member-data changes. Preparation-only goals finish before Save/Confirm and report success after checking the prepared fields. The browser closes when a run finishes, so use a goal requesting a save if you want to inspect the paused live form and approve it. Do not approve changes just to run the test suite: tests prepare forms and deny real submissions; successful approval is exercised against an isolated DOM fixture.

Use `--profile savings` to rediscover the narrower, legacy S00 workflow. Saved schema `1.0`/`1.1` artifacts select this profile automatically during replay; new general capabilities use schema `2.0`. All artifacts are bound to their discovery origin, including the checked-in examples. Rediscover after switching between local and deployed RFCU.

### Account-opening review verification

The general runtime can prepare account-opening forms and stop before **Open account**. To exercise that boundary without a model or a data write:

```sh
npm run test:opening -- --fixture
```

This is explicitly a scripted test of the real RFCU UI, not LLM discovery evidence. It uses the existing note capability's UI login/member-search prefix, then selects Regular Share Savings, individual ownership, no opening deposit, paper statements and supplied compliance fields. It checks the final review screen and denies a separate attempted Open account action. It neither signs nor acknowledges disclosures. It requires the configured synthetic deployment and its saved note capability.

Earlier account-opening attempts stopped on a route checkpoint and a provider usage/rate limit. A later genuine Codex run succeeded: `331f46f1-dfed-48f9-8dbc-f1ba6954a3d6` made 16 model decisions and saved `artifacts/prepare-account-opening.json`, stopping at Review and open. `npm run test:opening` without `--fixture` tests that discovered artifact; `--fixture` remains explicitly scripted verification. Neither path approves account creation.

### Authentication and session behavior

Every run creates a clean browser context and opens `/login`. The model selects login targets in discovery; replay resolves the recorded targets. Only the browser adapter resolves `RFCU_STAFF_USERNAME` and `RFCU_STAFF_PASSWORD`, then fills the real fields and clicks Sign in. An authenticated-shell checkpoint must pass before member work. The same page/context continues throughout the run and any intervention.

Invalid credentials and login validation errors stop explicitly. A redirect back to login or `/session-expired` returns `SESSION_EXPIRED`; the runtime does **not** silently reauthenticate or repeat earlier steps. Native staff authentication and sessionStorage remain entirely under RFCU’s control. The browser is closed when the run finishes; this is not a server-side logout/revocation guarantee.

### Human takeover

```sh
npm run replay -- --capability get-member-savings-balance --member-id 1000021 --handoff-demo --evidence-group handoff
```

1. Open **http://localhost:4310**. The runtime injects a clearly labeled demonstration dialog **after actual UI login** and pauses.
2. Click **Take control**. Ownership changes from `paused` to `human`.
3. Click **Resolve demonstration block** in the live RFCU image. This forwards a mouse action to the **same Playwright page**, not a new browser. The console only permits harmless dialog/retry controls. Optional `--headed` also exposes the actual browser window for wider manual interaction.
4. Click **Resume automation**. Resume checks the current route/session and that the dialog is gone, then reruns the pending step’s precondition. Do not leave the browser on a different workflow. The result records the intervention count.

No automation actions execute while the human owns the page. Operator clicks and input events are recorded with values redacted. There is a 15-minute operator timeout; an RFCU idle expiry during handoff still stops the run. The simulated part is the blocking dialog; ownership transfer, browser/session preservation, clicks, resume and subsequent replay are real. Keep the operator server running throughout handoff: process restart cannot restore a live browser session.

## Capability/API contract

`GET /api/capabilities` exposes the typed catalog; `POST /api/runs` starts discovery or replay; `GET /api/runs/:id` returns sanitized events, pending approval and the structured result. `POST /api/runs/:id/approval` accepts `{ "id": "PENDING_APPROVAL_ID", "approved": true }` for the local human operator?s decision. General discovery accepts arbitrary named-string `inputs` and an optional `profile` (`general` by default). All write requests require `Content-Type: application/json` and `X-RFCU-Client: operator`; browser origins and Host are restricted to the loopback console.

```json
{
  "mode": "replay",
  "capabilityId": "get-member-savings-balance",
  "inputs": { "member_id": "1000021" },
  "evidenceGroup": "replay-success"
}
```

The server returns `202` with `runId`. Poll its status endpoint. The success output is `{savings_balance:{amount:"1663.00",currency:"USD"}}`; amounts are decimal strings to preserve cents. The saved artifact has symbolic inputs/secrets, ordered locator strategies, retry bounds, pre/postconditions, and final ownership/account/output checkpoints. It contains neither passwords nor actual member IDs/balances.

## Tests and evidence

```sh
npm test
npm run typecheck
npm run build
npm run test:integration
npm run test:operator
npm run test:names
npm run test:general
npm run test:opening -- --fixture
npm run audit:secrets
```

`npm run test:general` replays the product-rate and prepared-note capabilities, then verifies that denying a real Save note action performs no mutation. It requires those general capabilities discovered on the configured origin and local staff credentials. Its operator decision is explicitly an automated denial, not human approval.

`npm test` requires the installed browser but no RFCU backend or model. Integration tests require RFCU running, seeded scenarios, local staff credentials and `RFCU_ORIGIN` matching the tested artifact. The included focused ID artifact targets localhost; the included name/general artifacts target the deployed HTTPS RFCU. Rediscover for your own deployment before testing there. Integration tests they perform real UI login/replay and cover not-found, permission denial, empty/invalid login, session ending and a labeled transient UI fault with bounded recovery. They do not reset scenarios, open accounts, or change the database directly.

`npm run test:names` verifies name replay, ambiguity and not-found against the configured RFCU deployment, using names read through the actual UI and kept only in memory. It requires a name capability discovered for that deployment. To generate it first using the configured model and then run these checks, use `npm run test:names -- --discover`; this performs genuine discovery and may incur model usage.

`npm run test:operator` also requires the operator server running with no active job. It drives the console’s Start/Take control/live-image click/Resume controls using a **simulated operator**, records that provenance, and verifies successful continuation with zero model calls. This does not claim that a human performed the test.

- `artifacts/`: reusable capabilities.
- `evidence/discovery/`: genuine provider decisions, observations, executed actions and artifact.
- `evidence/replay-success/`, `evidence/replay-error/`, `evidence/handoff/`: real run logs/results and sanitized diagnostics.
- `evidence/verification/`, `evidence/verification-results.json`: integration verification.
- [evidence/README.md](evidence/README.md): evidence index and provenance.
- [docs/REQUIREMENTS_CHECKLIST.md](docs/REQUIREMENTS_CHECKLIST.md): requirement audit.

Raw Playwright traces/HAR, storage state and full DOM snapshots are deliberately disabled: they can contain authentication payloads and complete member records. Logs retain allowlisted observations, symbolic actions and required output amounts. Failure diagnostics include masked screenshots plus structured page state. `audit:secrets` checks all local staff passwords against tracked source, artifacts and text evidence; screenshots require visual mask review.

## Security and limits

This is a local synthetic-UAT demonstration, not a production banking integration. The policy binds the run to one configured RFCU origin, the supplied or uniquely resolved member, RFCU route allowlists, approved controls and symbolic credential targets. Data-changing controls pause for single-use human approval; network writes are denied without the corresponding runtime permit. Page content is untrusted, and model decisions are validated before execution. The operator server is loopback-only, without production operator authentication or distributed persistence. Do not expose it to a network. Live frames contain synthetic member information for the authorized local operator and are not saved. The focused observation/redaction profile is RFCU-specific; another application needs its own tested profile.

Desktop adapters, automatic artifact repair, cross-tenant deployment, raw traces and automatic reauthentication are intentionally omitted. General form execution and approval cover account-opening/admin surfaces, but live financial/admin writes and an exhaustive workflow matrix have not been verified. See the seven-section [REPORT.md](REPORT.md) for trade-offs and next steps.
