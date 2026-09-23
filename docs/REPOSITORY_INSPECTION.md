# Existing RFCU application (before automation changes)

Inspected the repository file inventory, application source, SQL migrations/seeds, provisioning script, UI walkthroughs, build/deployment configuration, and assignment PDF before implementation. The working tree was clean. No discovery agent, capability format, deterministic replay engine, or live handoff manager existed.

## Architecture and data

`target-app` is a standalone Vite/React/TypeScript SPA. React Router owns navigation; TanStack Query caches typed RPC responses. Handwritten components and CSS provide the navy/gray banking console. Netlify serves the built SPA with an index fallback. No server application exists in this repository: Supabase provides Auth and Postgres RPC.

Migrations define private `core` tables: branches, staff, permissions/role permissions, members, relationships, alerts, notes, products, accounts, account parties, transactions, account openings, audit log, environment settings and test scenarios. Accounts belong to a member, have product/suffix/status, and separate current/available/hold amounts. Primary savings is the membership share S00. Seed generators produce synthetic member/contact/ledger data; every member has S00. Account opening is transactional and idempotent by request UUID. Public invoker wrappers call private functions that enforce staff/session/permissions and record access. Automation must not use these APIs or database tables.

## Routes

Public: `/login`, `/session-expired`. Protected root redirects to `/members`.
Member routes: `/members`, `/members/:memberNumber` (overview), `/accounts`, `/accounts/:accountNumber`, `/notes`, `/access-log` under the member. Opening routes: `/open-account`, `/members/:memberNumber/accounts/new`, `/review`, `/confirmation/:confirmation`. Reference pages: `/products`, `/activity`. Administration: `/admin` plus `/environment`, `/staff`, `/permissions`, `/products`, `/audit`, `/test-data`. There is a catch-all not-found page.

## Authentication

Login is a labeled Username/Password form and Sign in button. The app converts the username to its internal email form, uses Supabase password authentication, then loads staff context. Protected routes use `RequireAuth`. The app itself stores its tokens in tab-scoped sessionStorage with automatic refresh. Automation will neither read nor write that storage. A 30-second heartbeat detects revoked sessions and reloads environment settings. IdleMonitor warns and signs out through the normal app. Session-expired pages distinguish idle, revoked and disabled states. Administration requires a fresh password check. Sign-out clears queries and per-user drafts.

The local credential file is a Markdown table with Username, Name, Role, Branch, Password columns (25 rows). It is ignored by the existing `*.local.*` rule, untracked, and will also get an explicit ignore entry. No values are copied into this document.

## Member workflow and existing tests

Search is a labeled search input with a Search submit button, URL query parameters, server validation, loading state and explicit zero-result message. Results expose a member-number link. Details show identity/contact data, alerts, account preview and member tabs. Accounts groups deposits/loans; account detail labels current balance separately from available balance and ledger entries. Use a seven-digit member input and verify S00/account ownership before extracting current balance; the assignment's six-digit example does not fit this application.

Existing Python Playwright walkthroughs cover authentication, members, account opening, admin, and injected faults. They are procedural QA scripts, not learned capabilities. `support.py` loads local credentials and drives the login UI. `reset_scenarios.py` is an administrative test reset and will not be called by the new automation. Environment controls support latency, service failures, five dialogs and session expiry. Existing account-opening drafts and audit trails remain unchanged.

## Implementation boundary

Add a root TypeScript automation package with a Playwright surface, shared policy/session/evidence components, discovery-only model providers, a model-free replay executor, and a loopback operator server. Preserve all target application code. No backend shortcuts, database reads, new test IDs, or authentication changes are needed.
