# Report

## 1. Architecture

One TypeScript process with two entry points, and no services or queues. The hard problem is the contract between discovery, the artifact and replay, and a single process is enough to show it.

```
discover:  goal + URL ─► redacted accessibility tree ─► LLM picks ONE action ─► runtime checks policy,
                          resolves the target, acts, records what worked ─► ... ─► compile ─► artifacts/<id>.v<N>.json
replay:    artifact + typed inputs ─► per step: poll(conditions ▸ unexpected dialog ▸ target) ─► act ─► checkpoint
                          ─► success checks ─► { success | business_outcome | needs_human | failed }
```

- **The model decides and the runtime acts.** Each turn the model returns one schema-enforced action. The runtime checks it against policy, resolves the target to exactly one element, acts, and reports any error back on the next turn. The artifact is compiled from actions the runtime executed and verified, never from the transcript. In the recorded run the model made two mistakes (a caption containing `[money]`, and a success checkpoint that wasn't on the page), and both were caught before anything reached the artifact.
- **The accessibility tree, not the DOM or pixels, is the perception layer.** Roles and accessible names are what a person perceives. They survive CSS and markup changes, and desktop platforms expose the same structure (UI Automation, AT-SPI). The model never sees selectors.
- **The model is behind one function type** (`DecideFn`), with three transports: the Claude Code CLI (the default, used for the evidence), the Codex CLI and the OpenAI Responses API. All of them share one prompt, schema and validator, so an artifact doesn't depend on which model discovered it.
- **One seam per concern.** `surface.ts` is the only code that knows about Playwright. `apps/rfcu.json` holds everything app-specific. The engine (`discover`, `replay`, `handoff`) has nothing specific to RFCU.

## 2. Artifact schema

Defined with Zod in `automation/schema.ts`, so one definition is both the TypeScript type and the runtime validator.

```
Capability { id, version, app { id, surface, recordedOrigin, entryPath },
             inputs  [{ name, type, pattern }]        outputs [{ name, type: money|number|text }]
             secrets ["username", "password"]         // names only
             steps   [{ id, intent, action, target { locators[] }, value?, expect: Checkpoint[] }]
             success Checkpoint[]    conditions Condition[]    provenance { goal, model, runId } }
```

- **It is a contract for a calling agent, not a step list.** Typed inputs are checked against their pattern before the UI is touched. Typed outputs are parsed (money becomes a number with a currency). A closed set of result statuses tells the caller what it can get back.
- **Parameterization happens at compile time.** The model types the literal member number. The compiler replaces every occurrence with `{{member_number}}`, in step values, locator names, URL checkpoints and the recorded goal. It refuses to save an artifact that would contain a secret, or that declares an input or output it never uses. Values the agent *read* on screen are rejected as targets, so it has to use "the single link in the results table" instead. That is what lets a goal given by name produce a capability that works for any name.
- **Locators describe what a person sees:** `role` (optionally with heading `level`), `label`, `text`, `link`, `content` (the Nth prose paragraph of a region), and two for legacy layouts. `cell` reads a table value by row name, or by the row whose key column holds an input, and the column header. `field` reads the value right after a caption, because the console renders "Current balance" and the amount as two unlinked sibling `<div>`s. The first recorded run got stuck at exactly that point.
- **Targets never contain the data they read.** When the model copies a title, a paragraph or a row of values, the recorder replaces it with the structural target that finds the *same* element (first paragraph in main, the level-1 heading, the row whose key column holds the input), logged as `target.generalized`. Anything still containing copied output is rejected, and the same checks run at compile time and before every replay (`INVALID_ARTIFACT`).
- **Fallbacks are verified, not guessed.** At record time the compiler generates alternative locators and keeps only those that resolve to the *same single element*. Replay tries them in order and logs which one was used. It never picks among several matches, unless the goal explicitly asked for an ordinal such as "the first result".
- **Conditions come from the app, not the flow.** "Member not found", maintenance notices and session expiry belong to the vendor app. They are written once in the app profile and copied into each artifact, so each artifact can be reviewed on its own.

## 3. Determinism & error handling

Replay never calls a model. Each step polls every 250 ms until its timeout, checking in priority order:

1. **Known conditions** from the profile, handled according to their `kind`.
2. **An unexpected open dialog**, which escalates. A known condition that appears at the same moment is classified first. Evidence run 06 exposed that race.
3. **The step's target**, which must resolve to exactly one element.

After acting, the step's checkpoints must hold. At the end, the `success` checkpoints must hold and every output must parse to its type. So "member not found" is reported as what it is rather than as "element not found", and a slow page is simply waited out.

| Result | Examples | Response |
| --- | --- | --- |
| `business_outcome` | `member_not_found`, `permission_denied`, `multiple_matches` | Stop and return `{ outcome: { id, message } }`. It is a valid answer, not an error (evidence 03) |
| recoverable (recorded in `recoveries[]`) | maintenance notice, password-expiry notice, printer offline, request timeout | Run the profile's recovery clicks, wait for the condition to clear, and retry up to `maxRecoveries` times (evidence 06) |
| `needs_human` | BSA/AML attestation, signed in elsewhere, session ended, any unknown dialog | Hand off to an operator if one is attached, otherwise return an intervention request (evidence 04) |
| `failed` | `TARGET_NOT_FOUND`, `CHECKPOINT_FAILED`, `OUTPUT_UNPARSEABLE`, `RECOVERY_EXHAUSTED`, `POLICY_VIOLATION`, `INVALID_INPUT`, `INVALID_ARTIFACT`, service outage | Stop with `{ code, stepId, expected, observed, url }`, a blurred screenshot and a redacted accessibility snapshot (evidence 05) |

**Drift** (the secondary concern): falling back to a secondary locator is logged as an early warning while replay still succeeds. A missing target reports how many elements each locator matched, and a changed URL shape fails its checkpoint instead of reading the wrong screen.

**A known weakness.** Evidence 05 fails because member 1000021 has no "Regular Share Savings" account. Arguably that is a business outcome, but the artifact can't tell "the account doesn't exist" from "the UI changed". The fix is for a reviewer to add a condition (account list shown, no such row → `account_not_found`). The system must not guess.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The artifact says *what* to act on in perceptual terms (role and name, caption and value, row and column), never *how* to find it. `WebSurface` implements `observe / resolve / act / detect / screenshot`, and other surfaces would implement the same interface without changing the artifact:

- **Legacy web** (framesets, nested tables): the same surface plus a `frame` scope. Table layouts are why `cell` and `field` exist.
- **Desktop** (UI Automation, AT-SPI): `role`, `name` and `label` map directly onto automation properties.
- **No accessibility tree** (Citrix, green screens): a screenshot + OCR surface resolves `text` and `field` as text anchors with a spatial rule, and acts by coordinates. Polling, checkpoints and conditions don't change.

**Multi-tenant reuse.** The unit of reuse is the vendor app, not the tenant. A capability is recorded once against the vendor app's profile. Tenants differ in origin (already a replay parameter, checked against the allow-list), labels and version. The next step is a per-tenant overlay (`tenants/<tenant>/<app>.json`) that adds origins, overrides specific locators or conditions by id, and pins capability versions. A relabelled button then becomes a one-line override instead of a re-recording. Drift would be managed by aggregating fallback and failure signals per tenant and app version, running scheduled canary replays, and re-discovering only the failing step, reviewed as a new artifact version. None of this is built yet.

## 5. Escalation & handoff

**Detecting "stuck".** In replay: an `escalate` condition or any unexpected dialog. In discovery: the model chooses to escalate, or three actions fail in a row. Running out of steps ends as `failed`.

**Routing.** The run writes `intervention-N.json` with the capability, step, reason, URL, a masked screenshot, a redacted snapshot and how to attach. Without an operator, replay returns `needs_human` carrying that request, ready for a work queue.

**Control transfer.** Exactly one controller (`automation` or `human`) is recorded in `control.json`, and automation checks it before every action. With `--operator`, control flips to `human`. The person works in the *same* browser session, through the headed window or a tool attached over CDP on `127.0.0.1`. An in-page recorder logs which controls were used, and never what was typed. Pressing Enter or writing a `RESUME` file hands control back. The screen is then re-checked for conditions and the current step retries. Evidence 04 shows the full cycle, with a script standing in for the operator (disclosed in `evidence/README.md`).

Human steps taken during discovery are deliberately not compiled: an unattended capability must not depend on steps nobody recorded. **Mocked:** the operator console. A real one would add a queue, assignment, live streaming and authentication in front of CDP.

## 6. Safety

- **Allow-list.** The app profile lists allowed origins and action types (`click, fill, select, press, extract`). Every top-level navigation outside the origins is blocked, and there's no free navigation or script execution. Replay re-checks the artifact against the *current* policy before launching a browser.
- **Risky actions are blocked by default, and confirmed per action when explicitly allowed.** Controls named like submit, open account, transfer, attest, reveal or sign out are refused unless the run uses `--allow-writes`, which requires an attached operator. Each such action then pauses with a screenshot and an approval request in the live session, and is recorded with `approval: true`. Every replay asks again: an edited artifact cannot drop the flag, unattended replays stop as `needs_human`, and a denial fails as `APPROVAL_DENIED`. The approval is per action and shows the exact control and page, so the person is not just clicking "yes" to a generic prompt.
- **Secrets** are listed by name in the profile and read from `CUA_<NAME>` environment variables, in production from a secrets manager. They never reach the model, the artifact or the logs, which only see `{{secret.*}}`. They are also stripped from the environment of the model subprocesses. (RFCU's staff credentials are committed because the accounts are synthetic.)
- **Redaction** happens before anything is written or sent to the model. SSNs, phone numbers, emails, amounts, numeric dates and secret values are masked, and screenshots blur them along with table cells and inputs. Saved results keep output *shapes*, not values.
- **Limits.**
  - Names and free-text notes aren't redacted, so they reach the model and screenshots. Production needs NER-based redaction and a zero-retention model endpoint.
  - The risky-control check is a label heuristic, so a mislabelled button gets past it. The real backstop is running capabilities under a read-only staff role.
  - Only top-level navigations are restricted, not the app's own API calls.
  - The CDP endpoint gives full browser control. It opens only when `--cdp-port` is passed, and binds to localhost.

## 7. Cuts

**Left out on purpose:** surfaces other than the web; recorded evidence for more than one capability, and for the Codex and OpenAI transports (the one recorded discovery run used Claude); an operator console UI, queue, tenant overlays and artifact registry; session reuse (every replay signs in); automatic re-discovery; recording key presses during handoff that cause no click or change (such as Enter to submit a form), although the resulting navigation is logged.

**Next, in order:**

1. A reviewer workflow (`draft → approved`) that gates unattended replay.
2. Per-tenant overlays and version pinning.
3. Business-outcome conditions for "record present but sub-account missing".
4. NER redaction for names and free text.
5. A bounded, policy-checked single-step LLM repair when a locator fails, logged and never applied silently.
6. Stability scoring across runs, from the locator and failure signals the logs already capture.
