# Requirement audit

Name/deployment update: configured remote HTTPS RFCU origins are supported while each run remains restricted to its selected origin. Name lookup has a separate schema 1.1 capability and unique-result checkpoint; ambiguity is a business outcome. Genuine discovery and different-name replay were verified against the Netlify deployment, with no LLM calls in replay. See [name verification](../evidence/name-lookup-verification.json). Existing schema 1.0 ID capabilities remain supported.

Audited against implemented code, actual run evidence and tests on September 23, 2026. A check means the stated implementation was exercised; qualifications identify the limits. The original target-app source remains unchanged.

- [x] Starts from RFCU login page
- [x] Login performed through actual UI
- [x] Credentials loaded from STAFF_CREDENTIALS.local.md
- [x] Credentials excluded from Git
- [x] Credentials absent from artifacts/logs/evidence — text secret audit and visual screenshot-mask review
- [x] Authenticated session preserved
- [x] Goal-driven LLM loop — developer selects Codex CLI or OpenAI API in automation.env.local
- [x] Real UI interaction
- [x] Genuine discovery run — Codex CLI, 9 decisions; no fabricated model evidence
- [x] Typed/versioned capability artifact
- [x] Typed inputs
- [x] Typed outputs
- [x] Robust locator strategy — ordered semantic fallbacks; rejects ambiguity
- [x] Deterministic replay without LLM
- [x] Replay authenticates through UI
- [x] Success checkpoint — authenticated requested member's S00 current balance
- [x] Business outcome handling — MEMBER_NOT_FOUND exercised
- [x] Recoverable error handling — bounded retry exercised with labeled injected transient UI condition
- [x] Hard failure handling — permission, login validation and rejected credentials exercised
- [x] Session-expiration handling — explicit state/redirect detection; real UI sign-out test, no automatic reauthentication
- [x] Configurable allowlist — local origin, member-bound routes, action classes and browser request filtering
- [x] Risky action handling — rejected before execution; no financial commitment workflow
- [x] Sensitive-data redaction
- [x] Structured logs
- [x] Failure evidence — masked screenshot plus structured state
- [x] Human intervention request
- [x] Same-session human takeover mechanism — tested through console by an explicitly simulated operator
- [x] Resume after human control state — same page/context and authentication verified
- [x] Human-action recording mechanism — real browser events recorded with values omitted; test provenance retained
- [x] Heterogeneity design — SurfaceAdapter seam; browser implementation only
- [x] Multi-tenant reuse design — described in REPORT, no tenant registry implemented
- [x] README demo path
- [x] REPORT.md with exact seven headings
- [x] /evidence discovery run
- [x] /evidence successful replay
- [x] /evidence exceptional replay
- [x] /evidence handoff run — real mechanism with explicitly simulated operator
- [ ] Completed manual human handoff evidence — the requested manual attempt timed out without takeover; automated tests are not proof of human participation

## Validation and deliberate limits

The 19 unit/DOM/provider-contract tests, eight browser integration cases, console takeover test, typecheck and target build pass. A clean source copy installed both dependency trees, built and passed tests under Node 22, then replayed successfully and returned the expected not-found outcome without model credentials. It reused the existing configured synthetic Supabase backend; provisioning a new database from scratch was not independently repeated.

OpenAI API support is implemented and transport/schema/error handling are contract-tested, but live API discovery is unverified without a developer-provided key. Real admin-driven idle expiry/revocation was not exercised; UI session loss and state classification were. Desktop/native adapters, tenant overrides, account opening, production operator authentication and distributed execution are intentionally omitted. See [REPORT.md](../REPORT.md) and the [evidence index](../evidence/README.md).
