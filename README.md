# Computer-use automation for back-office banking apps

An LLM operates a web app through its accessibility tree to reach a goal once. That run is compiled into a typed, versioned **capability** artifact. After that, the capability replays deterministically, with typed inputs and no model in the loop.

Replay classifies every run as one of four results: success, business outcome, needs a human, or failed. When it needs a person, it hands the *same* live browser session to a human and resumes afterwards.

The target is the **RFCU Member Services Console**, a synthetic credit-union back-office app built for this project. It is hosted at **<https://rashed-federal-credit-union.netlify.app>**, so you can try everything here without setting up a database. Its source is in [`target-app/`](target-app/README.md). The main demo flow is *log in → search member → open member → read savings balance*.

| Document | What it covers |
| --- | --- |
| [`REPORT.md`](REPORT.md) | Design write-up: architecture, artifact schema, error handling, handoff, safety, cuts |
| [`evidence/README.md`](evidence/README.md) | Six recorded runs (discovery, replays, handoff) and how to read them |
| [`target-app/README.md`](target-app/README.md) | The target console: setup, database, test scenarios, UI tests |

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [Environment variables](#environment-variables)
- [Demo walkthrough](#demo-walkthrough)
- [Tests](#tests)
- [Repository layout](#repository-layout)

## How it works

```
discover:  goal + URL ─► LLM picks one action per turn from the redacted accessibility tree
                      ─► runtime checks policy, acts, verifies ─► artifacts/<id>.v<N>.json
replay:    artifact + typed inputs ─► deterministic steps + checkpoints (no LLM) ─► result JSON
```

| Result status | Meaning | Replay exit code |
| --- | --- | --- |
| `success` | Goal reached, all outputs read and typed | `0` |
| `business_outcome` | A valid answer that isn't the happy path, such as `member_not_found` | `2` |
| `needs_human` | Something that needs judgement, such as a compliance attestation dialog | `3` |
| `failed` | Hard failure, such as `TARGET_NOT_FOUND`, `INVALID_INPUT` or `POLICY_VIOLATION` | `1` |

## Quick start

**Requirements**

- Node 20.19+
- For discovery only: one LLM provider. The default is the [Claude Code](https://claude.com/claude-code) CLI, installed and logged in. Replay and the tests never call a model.

**1. Install**

```bash
npm install
npx playwright install chromium
```

**2. Set credentials.** Copy [`.env.example`](.env.example) to `.env` and fill in `CUA_USERNAME` and `CUA_PASSWORD`. For RFCU, use any row of [`target-app/STAFF_CREDENTIALS.local.md`](target-app/STAFF_CREDENTIALS.local.md), for example `aokafor`.

```dotenv
CUA_USERNAME=aokafor
CUA_PASSWORD=<password from the credentials file>
```

> The RFCU staff credentials file is committed on purpose. RFCU is not a real app, and its staff accounts are synthetic test accounts. Never do this for a real site.

**3. Replay the committed capability** against the hosted console:

```bash
npm run replay -- --artifact artifacts/rfcu.member.savings-balance.v1.json --input member_number=1057101 \
  --origin https://rashed-federal-credit-union.netlify.app
```

You should get `"status": "success"` with `current_savings_balance` on stdout. The v1 artifact was recorded on a local copy of the console, so `--origin` points it at the hosted one.

**4. Discover a new capability** with the LLM:

```bash
npm run discover -- --url https://rashed-federal-credit-union.netlify.app/login \
  --goal "Log in, find member 1030966, and return their current savings balance."
```

Artifacts you discover this way record the hosted origin, so their replays don't need `--origin`.

> **The hosted console is shared.** Everyone who clones this repo uses the same database. The only command here that changes it is `npm run demo:env`, which switches demo dialogs on or off for all users. Always finish with `npm run demo:env -- reset`. If a replay unexpectedly escalates with `compliance_attestation`, someone left the dialog on: run that reset.

To run the console yourself instead, see [`target-app/README.md`](target-app/README.md#run-it).

## Command reference

All commands run through npm, so put `--` between the script name and its arguments: `npm run replay -- --artifact ...`. Unknown flags are rejected.

### `npm run discover`

Runs the LLM against a live site until it reaches the goal, then compiles the verified actions into a new artifact.

| Argument | Required | Default | What it does |
| --- | --- | --- | --- |
| `--url <url>` | yes | – | Full URL where the run starts, for example `https://rashed-federal-credit-union.netlify.app/login`. Its origin selects the app profile, and its path becomes the artifact's entry path. |
| `--goal "<text>"` | yes | – | The task in plain English. Literal values in it (a member number, a name, a search term) become typed **inputs** of the artifact, so the same capability works for any value later. |
| `--llm <provider>` | no | `CUA_LLM`, else `claude` | Which model decides each step: `claude`, `codex` or `openai`. See [Choosing the LLM](#choosing-the-llm). |
| `--app <profile>` | no | matched by the URL's origin | App profile to use, by file name in `automation/apps/` without `.json`: `rfcu`, `youtube` or `public-web`. Only needed when you want a profile other than the one that allows the URL's origin. |
| `--max-steps <n>` | no | `20` | Maximum number of model turns. If the goal isn't reached by then, the run ends as `failed`. |
| `--out <dir>` | no | `runs/<run-id>` | Where evidence is written: event log, observations, screenshots, result. |
| `--headed` | no | off (headless) | Shows the browser window. |
| `--operator` | no | off | If the run gets stuck, pause and wait for a human instead of stopping. See [Human handoff](#human-handoff). |
| `--cdp-port <port>` | no | off | Opens the browser's DevTools protocol on `127.0.0.1:<port>`, so an operator tool can attach to the same live session. Only use it together with `--operator`. |

**Output.** The artifact is written to `artifacts/<id>.v<N>.json`, where `N` is the next free version, so existing artifacts are never overwritten. The summary JSON on stdout includes the `outputs` the model read (partial values too, if the run stops early) and a ready-to-run `replay` command, which is also saved in the artifact as `usage.replay`.

**Exit codes.** `0` success, `3` needs a human, `1` failed.

### `npm run replay`

Runs a saved artifact deterministically, with no model.

| Argument | Required | Default | What it does |
| --- | --- | --- | --- |
| `--artifact <file>` | yes | – | Path to the capability JSON, for example `artifacts/rfcu.member.savings-balance.v1.json`. |
| `--input name=value` | per artifact | – | One value for each input the artifact declares. Repeat the flag for several inputs. Values are checked against the input's pattern before a browser opens. A missing, unknown or malformed input fails with `INVALID_INPUT`. Quote values that contain spaces: `--input "member_name=Mei V. Garcia"`. |
| `--origin <url>` | no | the artifact's recorded origin | Runs the same capability against another deployment of the app, for example `https://rashed-federal-credit-union.netlify.app` for an artifact recorded on a local copy. The origin must be in the app profile's allow-list. |
| `--app <profile>` | no | the profile whose `id` matches the artifact | App profile to use, by file name in `automation/apps/` without `.json`. |
| `--out <dir>` | no | `runs/<run-id>` | Where evidence is written. Output values are masked there. |
| `--headed` | no | off (headless) | Shows the browser window. Needed if a person will take over in that window. |
| `--operator` | no | off | On an escalation, pause for up to 15 minutes while a human works in the same session, then resume. Without it, the run ends with `needs_human` and an intervention request. |
| `--cdp-port <port>` | no | off | Opens the browser's DevTools protocol on `127.0.0.1:<port>`, so an operator tool can attach. Only use it together with `--operator`. |

**Output channels.**

- **stdout:** the result JSON, including the real output values, because stdout is the channel to the caller.
- **stderr:** progress.
- **`--out` directory:** evidence, with output values masked.

**Exit codes.** `0` success, `2` business outcome, `3` needs a human, `1` failed.

### `npm run demo:env -- <mode>` (RFCU only)

Changes the console's **Administration → Environment controls** so a replay meets a real dialog. It signs in as an administrator (see `CUA_ADMIN_*` below) and reads the Supabase URL and key from `target-app/.env.local`.

| Mode | Effect |
| --- | --- |
| `attestation` | Shows the BSA/AML attestation dialog on the member screen. Replay must escalate to a human. |
| `maintenance` | Shows a harmless maintenance notice on the member screen. Replay acknowledges it and records a recovery. |
| `reset` | Turns all environment controls off. Always run this after a demo. |

### `npm run demo:operator` (RFCU only)

A scripted stand-in for a human operator, used to record the handoff evidence without anyone at the keyboard. It waits up to 180 s for the run's intervention request, attaches to the live browser, completes the attestation and signals resume.

| Argument | Required | Default | What it does |
| --- | --- | --- | --- |
| `--run <dir>` | yes | – | The replay's evidence directory, the same path you passed to its `--out`. The operator watches it for `intervention-1.json` and writes `RESUME` there. |
| `--cdp <url>` | no | `http://127.0.0.1:9333` | DevTools endpoint of the running replay. It must match the replay's `--cdp-port`. |

### Other scripts

| Command | What it does |
| --- | --- |
| `npm test` | Offline test suite: no LLM, Supabase or network (see [Tests](#tests)) |
| `npm run typecheck` | TypeScript type check with no output files |

## Environment variables

Put these in `.env` at the repository root (git-ignored, loaded on every run) or set them in your shell. Shell values take precedence over `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CUA_USERNAME`, `CUA_PASSWORD` | unset | Sign-in for the site being automated. Flows refer to them as `{{secret.username}}` and `{{secret.password}}`. |
| `CUA_ADMIN_USERNAME`, `CUA_ADMIN_PASSWORD` | the `dwhitfield` row of the RFCU credentials file | Administrator used by `npm run demo:env` only |
| `CUA_LLM` | `claude` | Discovery provider when `--llm` isn't given: `claude`, `codex` or `openai` |
| `CUA_MODEL` | per provider (see below) | Model for whichever provider you choose |
| `OPENAI_API_KEY` | unset | Required for `--llm openai` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Alternative OpenAI-compatible endpoint |
| `CUA_CLAUDE_BIN`, `CUA_CODEX_BIN` | `claude`, `codex` | Paths to the CLIs if they aren't on your PATH |
| `CUA_MAX_TREE_CHARS` | `20000` | How many characters of the accessibility tree the model sees per turn. Raise it for large pages. |

### How secrets are handled

- Each app profile lists the secret names it needs, for example `"secrets": ["username", "password"]`. Secret `name` is always read from `CUA_<NAME>`. Profiles for public sites list none, so your credentials are never loaded there.
- If a required variable is missing, the run stops before opening a browser and names it:

  ```
  error: app "rfcu-member-services" needs CUA_PASSWORD: set it in your environment or in .env (see .env.example)
  ```

- The model and the artifacts only ever see `{{secret.*}}`, never the values. Secret variables are also removed from the environment given to the `claude` and `codex` subprocesses, and logs and evidence redact them.
- In Bash, quote passwords with single quotes so characters like `$` are kept literally: `export CUA_PASSWORD='...'`.

### Choosing the LLM

All three providers get the same prompt and schema and return the same validated action, so an artifact doesn't depend on which model discovered it. The provider is recorded in the artifact's `provenance.model`.

| `--llm` | Needs | Default model |
| --- | --- | --- |
| `claude` | Claude Code CLI, logged in (`claude --version`) | `sonnet` |
| `codex` | Codex CLI, logged in with ChatGPT or an API key (`codex --version`) | Codex's configured default |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1` |

- **Codex is the slowest:** it starts a small agent for every turn, so allow about 15–30 s per turn.
- **Codex safety:** it runs in an empty temporary folder with a read-only sandbox, is told not to use tools, and never receives secret values. Only the redacted page tree and the goal are sent to any provider.

## Demo walkthrough

Every command below replays the committed v1 artifact against the hosted console. Each outcome matches a recorded run in [`evidence/`](evidence/README.md).

```bash
npm run replay -- --artifact artifacts/rfcu.member.savings-balance.v1.json \
  --origin https://rashed-federal-credit-union.netlify.app --input member_number=<member>
```

| Scenario | `<member>` | Expected result |
| --- | --- | --- |
| Success | `1057101` | `success` with `current_savings_balance`, exit 0 |
| Business outcome | `9999999` (doesn't exist) | `business_outcome` / `member_not_found`, exit 2 |
| Hard failure | `1000021` (no savings account) | `failed` / `TARGET_NOT_FOUND` at step `s7`, exit 1, plus `failure.png` and `failure.aria.txt` |

### Discovery with any goal

The goal is free text, and the model decides which values in it become inputs. A goal that names a member produces a `member_name` input instead of `member_number`:

```bash
npm run discover -- --url https://rashed-federal-credit-union.netlify.app/login \
  --goal "Log in, find member Amber L. Adams, and return their current total balance."

npm run replay -- --artifact artifacts/rfcu.member.total-current-balance.v1.json --input "member_name=Mei V. Garcia"
```

Values the model *reads* on screen, such as the member number shown after a name search, are never baked into the artifact. On replay, a name that matches several members returns `business_outcome` / `multiple_matches`, and a name that matches nobody returns `member_not_found`.

The same engine works on public sites that have a profile in `automation/apps/`:

```bash
npm run replay -- --artifact artifacts/youtube.search.first-video-link.v1.json --input "search_query=lofi study music"
```

To automate a site that isn't covered, add its origin to a profile in `automation/apps/` or create a new profile.

### Human handoff

The attestation dialog is a real dialog in the console, and automation must not answer it on a person's behalf.

`demo:env` signs in to the console's Supabase backend directly, so it needs `target-app/.env.local` (see [`target-app/README.md`](target-app/README.md#run-it)). It switches the dialog on for everyone using the hosted console, so always run the `reset` at the end.

```bash
npm run demo:env -- attestation

npm run replay -- --artifact artifacts/rfcu.member.savings-balance.v1.json --input member_number=1057101 \
  --origin https://rashed-federal-credit-union.netlify.app --headed --operator --cdp-port 9333
# Replay pauses and prints HUMAN INTERVENTION REQUIRED.
# Complete the attestation in the browser window, then press Enter in the terminal.
# Replay records your clicks, takes control back, and finishes.

npm run demo:env -- reset
```

To run the handoff unattended, as in [`evidence/04-replay-handoff`](evidence/04-replay-handoff/), start these in two terminals:

```bash
npm run replay -- --artifact artifacts/rfcu.member.savings-balance.v1.json --input member_number=1057101 \
  --origin https://rashed-federal-credit-union.netlify.app --operator --cdp-port 9333 --out runs/handoff
npm run demo:operator -- --run runs/handoff --cdp http://127.0.0.1:9333
```

For a recoverable interruption instead, run `npm run demo:env -- maintenance`. Replay acknowledges the notice and records a recovery, as in [`evidence/06-replay-recoverable`](evidence/06-replay-recoverable/). Finish with `npm run demo:env -- reset`.

## Tests

```bash
npm test             # 32 tests, about 45 s, no LLM, Supabase or network
npm run typecheck
```

| File | Covers |
| --- | --- |
| `automation/tests/flow.test.ts` | Starts a small fixture app, runs discovery with a scripted decision function in place of the model, then replays the artifact into every result: success, business outcome, recoverable, needs_human, live handoff over CDP, hard failure, invalid input and policy violation |
| `automation/tests/safety.test.ts` | Redaction, allow-list, risk classification, templates, output parsing and the committed artifact |
| `automation/tests/llm.test.ts` | Provider selection, the OpenAI strict-mode schema, and the OpenAI transport with the network mocked |
| `automation/tests/search.test.ts` | Search-style flows: first-result links, `href` extraction and empty results |

The target console has its own Python UI walkthroughs; see [`target-app/README.md`](target-app/README.md#tests).

## Repository layout

```
automation/
  cli.ts         discover and replay commands (argument parsing)
  discover.ts    LLM observe → decide → act loop, and compilation into an artifact
  replay.ts      deterministic executor and error taxonomy
  schema.ts      artifact schema (Zod): locators, checkpoints, conditions, result contract
  llm.ts         model transports (claude | codex | openai): one structured decision per turn
  surface.ts     Playwright web surface (the only file that knows about the browser)
  handoff.ts     control transfer to a human on the same session, and the action recorder
  safety.ts      app profiles, allow-list, risk classification, secrets, redaction
  runlog.ts      evidence writer (everything is redacted before it is written)
  apps/          app profiles: rfcu.json, youtube.json, public-web.json
  demo/          demo-only helpers: environment.ts (fault injection), operator.ts (scripted operator)
  tests/         offline tests against a fixture app
artifacts/       capability artifacts (<id>.v<version>.json)
evidence/        curated recorded runs
target-app/      the RFCU Member Services Console (React + Supabase)
runs/            output of your own runs (git-ignored)
```
