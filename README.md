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

Terminal 1, from the root:

```sh
npm run dev
```

This starts RFCU at **http://localhost:5173/login** and the operator console at **http://localhost:4310**. For RFCU alone: `npm --prefix target-app run dev`. For the operator alone: `npm run operator`.

Terminal 2:

```sh
npm run discovery -- --goal "Log in to RFCU, look up member 1030966, and return their current savings balance." --start-url http://localhost:5173/login --member-id 1030966 --evidence-group discovery
npm run replay -- --capability get-member-savings-balance --member-id 1000021 --evidence-group replay-success
npm run replay -- --capability get-member-savings-balance --member-id 9999999 --evidence-group replay-error
```

Discovery really observes the page after each executed action; it does not generate a script first. Each successful discovery writes `artifacts/get-member-savings-balance.json` and increments its artifact version. A previously discovered artifact is included, so replay can be demonstrated immediately without model access. Do not run two operator-server jobs simultaneously; the server returns `RUN_ACTIVE` until the current one finishes.

The first discovery in the evidence returned USD `23693.68`; replay for the different seeded member returned USD `1663.00`. These are observed synthetic balances, not hard-coded expected values. The nonexistent member returns:

```json
{"status":"business_outcome","code":"MEMBER_NOT_FOUND","message":"No member matches the requested ID","runId":"..."}
```

A restricted record demonstrates a hard failure:

```sh
npm run replay -- --capability get-member-savings-balance --member-id 1000672 --evidence-group replay-error
```

Six-digit IDs are rejected before launching a browser. CLI exit codes: success/business outcome `0`, runtime failure `1`, setup/request error `2`.

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

`GET /api/capabilities` exposes the typed catalog; `POST /api/runs` starts discovery or replay; `GET /api/runs/:id` returns sanitized events and the structured result. All write requests require `Content-Type: application/json` and `X-RFCU-Client: operator`; browser origins and Host are restricted to the loopback console.

```json
{
  "mode": "replay",
  "capabilityId": "get-member-savings-balance",
  "inputs": {"member_id": "1000021"},
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
npm run audit:secrets
```

`npm test` requires the installed browser but no RFCU backend or model. Integration tests require RFCU running, seeded scenarios and local staff credentials; they perform real UI login/replay and cover not-found, permission denial, empty/invalid login, session ending and a labeled transient UI fault with bounded recovery. They do not reset scenarios, open accounts, or change the database directly.

`npm run test:operator` also requires the operator server running with no active job. It drives the console’s Start/Take control/live-image click/Resume controls using a **simulated operator**, records that provenance, and verifies successful continuation with zero model calls. This does not claim that a human performed the test.

- `artifacts/`: reusable capabilities.
- `evidence/discovery/`: genuine provider decisions, observations, executed actions and artifact.
- `evidence/replay-success/`, `evidence/replay-error/`, `evidence/handoff/`: real run logs/results and sanitized diagnostics.
- `evidence/verification/`, `evidence/verification-results.json`: integration verification.
- [evidence/README.md](evidence/README.md): evidence index and provenance.
- [docs/REQUIREMENTS_CHECKLIST.md](docs/REQUIREMENTS_CHECKLIST.md): requirement audit.

Raw Playwright traces/HAR, storage state and full DOM snapshots are deliberately disabled: they can contain authentication payloads and complete member records. Logs retain allowlisted observations, symbolic actions and required output amounts. Failure diagnostics include masked screenshots plus structured page state. `audit:secrets` checks all local staff passwords against tracked source, artifacts and text evidence; screenshots require visual mask review.

## Security and limits

This is a local synthetic-UAT demonstration, not a production banking integration. The policy binds the run to one local origin, the supplied member, read-only member routes, approved controls and symbolic credential targets. Risky actions stop before execution. Page content is untrusted, and model decisions are validated before execution. The operator server is loopback-only, without production operator authentication or distributed persistence. Do not expose it to a network. Live frames contain synthetic member information for the authorized local operator and are not saved. The focused observation/redaction profile is RFCU-specific; another application needs its own tested profile.

Account opening, desktop adapters, automatic artifact repair, cross-tenant deployment, raw traces and automatic reauthentication are intentionally omitted. See the seven-section [REPORT.md](REPORT.md) for trade-offs and next steps.
