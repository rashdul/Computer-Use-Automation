# Report

## 1. Architecture

One TypeScript process with two entry points, no services or queues. The hard problem is the contract between discovery, the artifact and replay; a single process is enough to show it.

```
discover:  goal + URL ─► redacted accessibility tree ─► LLM picks ONE action ─► runtime checks policy,
                          resolves the target, acts, records what worked ─► compile ─► artifacts/<id>.v<N>.json
replay:    artifact + typed inputs ─► per step: poll(conditions ▸ unexpected dialog ▸ target) ─► act ─► checkpoint
                          ─► success checks ─► { success | business_outcome | needs_human | failed }
```

- **The model decides, the runtime acts.** Each turn the model returns one schema-enforced action. The runtime checks policy, resolves the target to exactly one element, acts, and reports errors back on the next turn. The artifact is compiled from verified actions, never from the transcript, so model mistakes (in the recorded run: a caption containing `[money]`, a success checkpoint not on the page) never reach it.
- **The accessibility tree is the perception layer.** Roles and accessible names are what a person perceives. They survive CSS and markup changes, and desktop platforms expose the same structure (UI Automation, AT-SPI). The model never sees selectors.
- **The model sits behind one function type** with three transports (Claude Code CLI, the default and the one used for the evidence; Codex CLI; OpenAI Responses API). All share one prompt, schema and validator, so an artifact does not depend on which model found it.
- **One seam per concern.** Only `surface.ts` knows Playwright; only `apps/<app>.json` knows the app. The engine has nothing RFCU-specific.

## 2. Artifact schema

One Zod definition (`automation/schema.ts`) is both the TypeScript type and the runtime validator.

```
Capability { id, version, app { id, surface, recordedOrigin, entryPath },
             inputs  [{ name, type, pattern }]        outputs [{ name, type: money|number|text }]
             secrets ["username", "password"]         // names only
             steps   [{ id, intent, action, target { locators[] }, value?, expect[], approval? }]
             success Checkpoint[]    conditions Condition[]    provenance { goal, model, runId } }
```

- **A contract for a calling agent, not a step list.** Inputs are checked against their pattern before the UI is touched; outputs are parsed to their type (money becomes a number); the result statuses are a closed set.
- **Parameterized at compile time.** The model types a literal ("1030966"); the compiler replaces it with `{{member_number}}` in values, locator names, URL checkpoints and the goal. It refuses artifacts that would contain a secret or declare an unused input or output.
- **Targets describe what a person sees, never the data they read.** Locators are `role` (with optional heading level), `label`, `text`, `link`, `content` (the Nth prose paragraph of a region), `cell` (by row name, or the row whose key column holds an input, plus column header) and `field` (the value after a caption, for unlinked label/value `<div>`s). Values read on screen are rejected as targets; copied titles, paragraphs or row values are replaced by the structural target that finds the same element. These checks run at compile time and before every replay (`INVALID_ARTIFACT`).
- **Fallbacks are verified, not guessed.** Alternatives are kept only if they resolve to the same single element. Replay never picks among several matches unless the goal asked for an ordinal ("the first result").
- **Conditions belong to the app.** "Member not found", maintenance notices and session expiry are written once in the app profile and copied into each artifact, so every artifact can be reviewed on its own.

## 3. Determinism & error handling

Replay never calls a model. Each step polls every 250 ms until its timeout, in priority order: (1) **known conditions**, handled by their `kind`; (2) **an unexpected dialog**, which escalates (a known condition appearing at the same moment is classified first, a race found in evidence 06); (3) **the target**, which must resolve to exactly one element. Then the step's checkpoints must hold, and at the end the success checkpoints and every typed output. So "member not found" is reported as itself, not as "element not found", and a slow page is simply waited out.

| Result | Examples | Response |
| --- | --- | --- |
| `business_outcome` | `member_not_found`, `permission_denied`, `multiple_matches` | Return `{ outcome: { id, message } }`: a valid answer, not an error (evidence 03) |
| recoverable | maintenance notice, printer offline, request timeout | Run the profile's recovery clicks, retry up to `maxRecoveries`, record it (evidence 06) |
| `needs_human` | BSA/AML attestation, session ended, any unknown dialog | Hand off if an operator is attached, else return an intervention request (evidence 04) |
| `failed` | `TARGET_NOT_FOUND`, `CHECKPOINT_FAILED`, `POLICY_VIOLATION`, `INVALID_INPUT`, `INVALID_ARTIFACT`, outage | Stop with `{ code, stepId, expected, observed, url }`, a blurred screenshot and a redacted snapshot (evidence 05) |

**Drift** is secondary: using a fallback locator is logged as an early warning, a missing target reports match counts per locator, and a changed URL shape fails its checkpoint rather than reading the wrong screen.

**Known weakness.** Evidence 05 fails because the member has no "Regular Share Savings" account. That is arguably a business outcome, but the artifact cannot tell "no such account" from "the UI changed". A reviewer should add a condition (`account_not_found`); the system must not guess.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The artifact says *what* to act on in perceptual terms, never *how*. `WebSurface` implements `observe / resolve / act / detect / screenshot`; other surfaces implement the same interface and the artifact is unchanged. Legacy web adds a `frame` scope (table layouts are why `cell` and `field` exist). Desktop maps `role`, `name` and `label` onto UI Automation / AT-SPI properties. Surfaces with no accessibility tree (Citrix, green screens) resolve `text` and `field` with OCR anchors and act by coordinates; polling, checkpoints and conditions stay the same.

**Multi-tenant reuse.** The unit of reuse is the vendor app, not the tenant. A capability is recorded once against the app's profile; tenants differ in origin (already a replay parameter, checked against the allow-list), labels and version. Next would be per-tenant overlays (`tenants/<tenant>/<app>.json`) that add origins, override locators or conditions by id and pin versions, so a relabelled button is a one-line override, not a re-recording. Drift is managed by aggregating fallback and failure signals per tenant and version, canary replays, and re-discovering only the failing step as a reviewed new version. None of this is built.

## 5. Escalation & handoff

**Detecting "stuck".** In replay: an `escalate` condition or an unknown dialog. In discovery: the model escalates, or three actions fail in a row.

**Routing.** The run writes `intervention-N.json` (capability, step, reason, URL, masked screenshot, redacted snapshot, how to attach). Without an operator, replay returns `needs_human` with that request, ready for a work queue.

**Control transfer.** Exactly one controller (`automation` or `human`) is recorded in `control.json`, checked before every action. With `--operator`, control flips to the human, who works in the *same* browser session through the headed window or a tool attached over CDP on `127.0.0.1`. An in-page recorder logs which controls were used, never what was typed. Enter or a `RESUME` file hands control back; the screen is re-checked and the step retries. Evidence 04 shows the cycle, with a disclosed script as the operator. Human steps in discovery are never compiled: an unattended capability must not depend on unrecorded steps. **Mocked:** the operator console (queue, assignment, streaming, auth in front of CDP).

## 6. Safety

- **Allow-list.** Profiles list allowed origins and action types. Navigations outside the origins are blocked, including server redirects, and replay re-checks each artifact against the *current* policy before opening a browser.
- **Risky actions are blocked by default and approved per action when allowed.** Controls like submit, open account, transfer, attest or sign out are refused unless the run uses `--allow-writes`, which requires an operator. Each such click then pauses for approval in the live session, showing the exact control and page, and is recorded as `approval: true`. Every replay asks again; unattended replays stop as `needs_human`, and a denial fails as `APPROVAL_DENIED`.
- **Secrets** are read from `CUA_<NAME>` variables (a secrets manager in production) and never reach the model, artifact or logs, which see only `{{secret.*}}`; they are also stripped from model subprocesses. RFCU's staff credentials are committed because its accounts are synthetic.
- **Redaction** happens before anything is written or sent to the model: SSNs, phones, emails, amounts, dates and secret values are masked, and screenshots are blurred. Saved results keep output shapes, not values.
- **Limits.** Names and free text are not redacted (production needs NER redaction and a zero-retention model). The risky-control check is a label heuristic, so the real backstop is a read-only staff role. Only navigations are restricted, not the app's own API calls. CDP gives full browser control, so it opens only with `--cdp-port`, on localhost.

## 7. Cuts

**Left out on purpose:** non-web surfaces; recorded evidence for more than one capability and for the Codex/OpenAI transports; an operator console, queue, tenant overlays and artifact registry; session reuse (every replay signs in); automatic re-discovery; recording key presses during handoff that cause no click or change.

**Next, in order:** (1) a `draft → approved` review gate for unattended replay; (2) per-tenant overlays and version pinning; (3) conditions for "record present, sub-account missing"; (4) NER redaction for names and free text; (5) a bounded, policy-checked single-step LLM repair for failed locators, logged and never silent; (6) stability scores from the locator and failure signals the logs already capture.
