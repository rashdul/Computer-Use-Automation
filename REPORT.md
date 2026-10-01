# Report

## 1. Architecture

The system is one TypeScript process with two entry points. There are no services or queues. The real problem here is the contract between discovery, the artifact and replay, and a single process is enough to show it.

```
discover:  goal + URL ─► [observe: redacted accessibility tree] ─► LLM picks ONE action ─► runtime checks policy,
                          resolves the target, acts, and records what worked ─► ... ─► compile ─► artifacts/<id>.v<N>.json
replay:    artifact + typed inputs ─► for each step: poll(conditions ▸ unexpected dialog ▸ target) ─► act ─► checkpoint
                          ─► success checks ─► RunResult { success | business_outcome | needs_human | failed }
```

Key decisions:

- **The model decides and the runtime acts.** Each turn the model gets the goal, the history and a redacted accessibility snapshot, and returns one structured action (JSON-schema enforced). The runtime then:
  - checks the action against policy,
  - resolves the target, which must match exactly one element,
  - acts, and
  - reports errors back to the model on the next turn.

  The artifact is compiled from actions the runtime executed and verified, never from the transcript. In the recorded run the model made two errors (a caption with `[money]` in it, and a success checkpoint that wasn't on the page). Both were caught by this loop before anything reached the artifact.
- **Accessibility tree, not the DOM or pixels, as the perception layer.** Roles and accessible names are what a person perceives. Desktop platforms expose the same structure (UI Automation, AT-SPI), and it survives CSS and markup changes. The model never sees selectors.
- **LLM transport.** The model is behind one function type (`DecideFn`), and three transports implement it:
  - Claude through the Claude Code CLI (`claude -p`, every tool disabled). This is the default and was used for the evidence runs.
  - OpenAI models through the Codex CLI (`codex exec`, empty folder, read-only sandbox).
  - The OpenAI Responses API.

  All three use the same prompt and schema. OpenAI's strict mode needs every field listed as required, so a strict variant of the schema is generated automatically. Replies go through the same validator, so the artifact does not depend on which model discovered it.
- **One seam per concern.**
  - `surface.ts` is the only code that knows about Playwright.
  - `apps/rfcu.json` holds everything app-specific: the allow-list, risky controls and known runtime conditions.
  - The engine itself (`discover`, `replay`, `handoff`) contains nothing specific to RFCU.

## 2. Artifact schema

The schema is defined with Zod in `automation/schema.ts`, so it is both the TypeScript type and the runtime validator. Its structure:

```
Capability { schemaVersion, id, version, name, description,
             app        { id, surface: "web", recordedOrigin, entryPath },
             inputs     [{ name, type, description, pattern }],       // what the caller supplies
             secrets    ["username", "password"],                     // names only; resolved at run time
             outputs    [{ name, type: money|number|text, currency }], // what the caller gets back
             steps      [{ id, intent, action, target, value?, output?, extract?: text|href, expect: Checkpoint[], timeoutMs }],
             success    Checkpoint[],                                 // must hold at the end
             conditions Condition[],                                  // copied from the app profile at compile time
             provenance { discoveredAt, runId, goal (parameterized), model, llmCalls } }
Target     { description, locators: Locator[] }   // ordered: primary, then verified fallbacks
Locator    role{role,name?,exact?} | label{label} | text{text} | field{field} | cell{row,column}
           | link{hrefPrefix, position?: "first"}                         (+ optional within{role,name})
           role without a name = "the single <role> in <within>" (e.g. the one result in a search table)
usage      { replay }   // the ready-to-run replay command, generated at compile time
Checkpoint url{pattern} | visible{target}
Condition  { id, kind: business|recoverable|escalate|fatal, when: Locator, message, recover?: Locator[], maxRecoveries }
```

Why it has this shape:

- **It is a contract for a calling agent, not a step list.** Typed inputs (with a pattern, checked before the UI is touched), typed outputs (money is parsed to a number with a currency), and a closed set of result statuses tell an agent what it may call and what it gets back.
- **Parameterization happens at compile time.** The model types the literal member number. The compiler replaces every occurrence with `{{member_number}}`: in step values, in locator names (`link "{{member_number}}"`), in URL checkpoints (`/members/{{member_number}}/accounts/{{member_number}}-S01`) and in the recorded goal. It refuses to save an artifact if any secret value would be persisted, or if a declared input or output is never used. Values the agent *read* on screen (record IDs not given in the goal) are rejected as targets during discovery. Instead the agent uses a "single match in container" target, and any such IDs left in URL checkpoints become `*`. That is what lets a goal by name produce a capability that works for any name.
- **Locators say what a person sees.** Six strategies:
  - `role` for anything with a role and a name.
  - `label` for form fields.
  - `text` as a fallback.
  - `cell` addresses a table value by its row name and column header text. The column index is looked up at run time, so a column being reordered or added does not shift the value that is read.
  - `field` reads the value shown right after a caption. It exists because the console renders "Current balance" and the amount as two sibling `<div>`s with no programmatic link, which is common in legacy apps. The first recorded run got stuck at exactly that point.
  - `link` matches a link by where it points (`hrefPrefix`, such as `/watch?`), for search results whose titles change between runs. Like every locator it fails on more than one match, unless it explicitly says `position: "first"`. An extract step with `extract: "href"` returns the link's absolute destination URL instead of its visible text.
- **Fallbacks are verified, not guessed.** At record time the compiler generates alternatives (label ↔ role, loose-name role, text) and keeps only those that resolve to the *same single element*. Replay tries them in order, never accepts more than one match, and logs which strategy index was used.
- **Conditions come from the app, not the flow.** "Member not found", the maintenance notice and session expiry belong to the vendor app, not to one capability. They are written once in the app profile and copied into each artifact, so an artifact is self-contained and can be reviewed on its own.

## 3. Determinism & error handling

Replay never calls a model. Each step polls every 250 ms until its timeout, checking three things in priority order:

1. **Known conditions** from the profile. If one is present, it is handled according to its `kind`.
2. **An open dialog** that the flow does not expect. This escalates. If a known condition appeared at the same moment, it is classified first. Evidence run 06 exposed that race and led to this fix.
3. **The step's target** resolving to exactly one element.

After the action, the step's checkpoints must hold (with conditions still watched). At the end, the `success` checkpoints must hold and every declared output must be present and parse to its type. So "member not found" is recognised as what it is, not reported as "element not found", and a slow page is just waited out within the step's timeout.

| Result | Examples | Response |
| --- | --- | --- |
| `business_outcome` | `member_not_found`, `permission_denied` (restricted record), `multiple_matches` (a "single match" target matched several, e.g. a shared name) | Stop and return `{ outcome: { id, message } }`. It is a valid answer for the caller, not an error (evidence 03) |
| recoverable (only visible in `recoveries[]`) | maintenance notice, password-expiry notice, printer offline, request timeout | Run the profile's recovery clicks, wait for the condition to clear, retry up to `maxRecoveries` times, and record it (evidence 06) |
| `needs_human` | BSA/AML attestation, "signed in on another workstation", session ended or idle, any unknown dialog | Hand off to an operator if one is attached. Otherwise stop with an intervention request (evidence 04) |
| `failed` | `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, `CHECKPOINT_FAILED`, `OUTPUT_UNPARSEABLE`, `RECOVERY_EXHAUSTED`, fatal conditions such as a service outage, `POLICY_VIOLATION`, `INVALID_INPUT` | Stop with `{ code, stepId, expected, observed, url }`, a screenshot with sensitive values blurred, and a redacted accessibility snapshot (evidence 05) |

**Drift** (the secondary concern) is handled in three ways:

- When a fallback strategy is used, that is logged. It is an early drift signal while replay still succeeds.
- A missing target reports how many elements each strategy matched.
- A changed URL shape fails its checkpoint instead of reading the wrong screen.

**A known weakness.** Evidence 05 fails because member 1000021 has no "Regular Share Savings" account. That is arguably a business outcome ("no such account"), but the artifact cannot tell "the account doesn't exist" apart from "the UI changed". The right fix is a reviewer adding a condition, for example "account list shown and no such row" → `account_not_found`. The system must not guess.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The artifact describes *what* to act on in perceptual terms (a role and name, a caption and its value, a row and column). It never says *how* to find it on a given surface. `WebSurface` implements `observe / resolve / act / detect / screenshot`. Other surfaces would implement the same interface without changing the artifact:

- **Legacy web** (framesets, nested tables): the same Playwright surface plus a `frame` scope in `within`. Table layouts are why the `cell` and `field` strategies exist.
- **Desktop** (Windows UI Automation, AT-SPI): `role`, `name` and `label` map directly onto automation properties. `field` becomes "the element after the caption in the parent's children".
- **No accessibility tree at all** (Citrix, green screens): a screenshot + OCR surface would resolve `text` and `field` as text anchors with a spatial rule ("value to the right of the caption"), and act by coordinates. Replay's poll, checkpoints and conditions do not change. `app.surface` records which kind of surface an artifact was recorded on.

**Multi-tenant reuse.** The unit of reuse is the vendor app, not the tenant:

- `apps/<vendor-app>.json` holds the conditions and risky-control vocabulary shared by every tenant running that product.
- A capability is recorded once against the vendor app. Tenants differ in origin (already a replay parameter, checked against the allow-list), branding, labels and version.
- Next step: a per-tenant overlay (`tenants/<tenant>/<app>.json`) that adds origins, overrides specific locator names or conditions by id, and pins capability versions. Replay would merge base artifact + overlay deterministically, so a relabelled button is a one-line override rather than a re-recording.
- Drift would be managed through (a) the fallback-usage and failure-code signals above, aggregated per tenant and app version; (b) scheduled canary replays against a test member per tenant; and (c) re-discovery run only for the failing step, with the result reviewed as a new artifact version rather than silently patched. None of this infrastructure is built (see Cuts).

## 5. Escalation & handoff

**Detecting "stuck".**

- In replay: an `escalate` condition, or any unexpected dialog.
- In discovery: the model chooses `escalate`, or three failed actions in a row (a dead end). Running out of the step or time budget ends the run as `failed` rather than escalating.

**Routing the request.** The run writes `intervention-N.json` containing the capability or goal, the step id and intent, the reason, the URL, a masked screenshot, a redacted snapshot, and how to attach and resume. Without an operator, replay returns `needs_human` with that request, which is the routing payload for a work queue.

**Taking control.** There is exactly one controller at a time (`automation` or `human`), persisted in `control.json`. Automation checks it before every action.

With `--operator`, control flips to `human` and the run waits. The person works in the *same* browser: the headed window, or any tool attached to the CDP endpoint on `127.0.0.1`. A persistent context makes the session the browser's default context, so an attached tool sees the same page, cookies and storage. An in-page recorder logs which control was used (role, name, path) and never what was typed (only its length). Navigations are logged too.

Resume comes from Enter in the terminal or a `RESUME` file. The file stands in for an operator console's "hand back" button. Control flips back to automation, the screen is checked again for conditions, and the current step retries with a fresh timeout.

Evidence 04 shows the whole cycle. Its operator was a script attached over CDP, which is disclosed in `evidence/README.md`.

**By design, discovery work done by a human is not compiled.** An unattended capability must not depend on steps nobody recorded.

**Mocked:** the operator console. `RESUME` plus CDP is the minimal real mechanism. A real console would add a queue, assignment, live streaming, and authentication in front of CDP.

## 6. Safety

- **Allow-list** (in the app profile):
  - Origins are checked before `goto`, and Playwright routing blocks every top-level navigation outside them (link clicks, redirects and scripts included). A blocked navigation fails the step.
  - Action types are listed explicitly (`click, fill, select, press, extract`). There is no free navigation and no script execution.
  - Replay re-checks the whole artifact against the *current* policy before it launches a browser.
- **Risky actions are blocked, not confirmed.** Controls whose accessible name matches the profile's risky vocabulary (submit, save, transfer, attest, reveal, sign out, open account, …) are refused in discovery (the model is told and must choose something else) and rejected at artifact load. This capability class is read-only. Where a flow truly needs such a step, the safe path is a human via handoff, not a confirmation prompt that trains people to click "yes".
- **Secrets** are listed by name in each app profile (for example `["username", "password"]`) and read from generic `CUA_<NAME>` environment variables (`CUA_USERNAME`, `CUA_PASSWORD`), so nothing is tied to one app. They are read from the environment or a git-ignored `.env` into memory only, and removed from the environment passed to the model CLIs. In production the same variables would be filled from a secrets manager. RFCU's own staff credentials file will be in GitHub because RFCU is not an actual app: its staff accounts are synthetic. The model and the artifact only ever see `{{secret.*}}` references. Logs record the template, not the value, and the compiler refuses to save an artifact that contains a secret.
- **Redaction** is applied before anything is written or sent to the model:
  - Known secret values, SSNs, phone numbers, emails, amounts and numeric dates are masked.
  - Screenshots blur those same patterns plus table cells, definition values and inputs, using CSS blur so dialogs stay readable.
  - Persisted results keep output *shapes*, not values. The model never sees balances; the runtime reads the value it selected.
- **Limits:**
  - Personal names and free-text notes are not redacted; there is no pattern that finds them. They appear in accessibility trees (seen by the model) and in screenshots. A production system needs NER-based redaction and a model endpoint with zero data retention.
  - The risky-control check is a heuristic on labels, so a mislabelled button gets past it. The real backstop is least privilege: run capabilities under a read-only staff role.
  - Only top-level navigations are restricted; the app's own API calls are not.
  - The CDP endpoint gives full control of the browser. It is opened only when `--cdp-port` is passed, and binds to localhost.

## 7. Cuts

**Left out on purpose:**

- one surface (web)
- one capability with recorded evidence (the LLM runs in the evidence all used Claude)
- no operator console UI, queue, tenant overlays or artifact registry
- no session reuse (every replay signs in)
- no automatic re-discovery
- no stretch goals

**Also cut:**

- Human steps taken during discovery are not merged into the artifact.
- The recorder captures clicks and changes, but not keyboard-only navigation.

**Next, in order:**

1. A reviewer workflow (`draft → approved`) that gates unattended replay.
2. Per-tenant overlays and version pinning.
3. Business-outcome conditions for "record present but sub-account missing".
4. NER redaction for names and free text.
5. A bounded, policy-checked single-step LLM repair when a locator fails, logged as evidence and never applied silently.
6. Multi-run stability scoring from the strategy and failure signals the logs already capture.
