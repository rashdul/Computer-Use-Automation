# Evidence

These runs were recorded on 2026-09-24 against the RFCU console (`target-app/`) running locally at `http://localhost:5173`, backed by its Supabase UAT project. All member data is synthetic. Every file here went through the redactor. Secrets, SSNs, phone numbers, emails, amounts and numeric dates are masked. Screenshots blur the same values plus table cells, definition values and inputs.

| Run | What it shows | Result |
| --- | --- | --- |
| [`01-discovery`](01-discovery/) | A real LLM discovery run (Claude Sonnet 5 through `claude -p`). The goal was *"Log in, find member 1030966, and return their current savings balance."* | `success` after 11 model calls. It wrote [`artifacts/rfcu.member.savings-balance.v1.json`](../artifacts/rfcu.member.savings-balance.v1.json) |
| [`02-replay-success`](02-replay-success/) | Deterministic replay for a *different* member (1057101), with no model involved | `success`. 8 steps and 3 success checkpoints verified in about 4 s |
| [`03-replay-member-not-found`](03-replay-member-not-found/) | Replay with member 9999999 | `business_outcome` / `member_not_found`, exit code 2 |
| [`04-replay-handoff`](04-replay-handoff/) | The console showed the BSA/AML attestation dialog during replay. It needs human judgement, so replay escalated and a human took over the same live session, then handed control back | `success`, with 1 handoff and 4 recorded human actions |
| [`05-replay-hard-failure`](05-replay-hard-failure/) | Member 1000021 has no "Regular Share Savings" account, so step `s7` cannot find its target | `failed` / `TARGET_NOT_FOUND` with the step, what was expected, what was observed, a screenshot and an accessibility snapshot |
| [`06-replay-recoverable`](06-replay-recoverable/) | The console showed a "Scheduled maintenance tonight" notice. It is a known interstitial, so replay acknowledged it and carried on | `success`, with 1 recovery (`maintenance_notice`) |

## Reading a run

- `events.jsonl` is the structured log, one event per line. Discovery logs `llm.decision` (the model's one-sentence reason and its chosen action), `action.done`, `action.error`, `policy.blocked` and `done.rejected`. Replay logs `step.start`, `step.action` (which locator strategy matched, and the value template rather than the resolved value), `condition.detected`, `recovery`, `handoff.*`, `human.action` and `success.verified`.
- `console.txt` is the same run as it printed to the terminal.
- `observations/NN.txt` (discovery only) is the redacted accessibility tree the model saw on each turn.
- `result.json` follows the result contract. Output values are replaced by `[redacted]`. The real values went to the caller on stdout and were not persisted.
- `intervention-1.json`, `handoff-1.png`, `handoff-1.aria.txt`, `RESUME` and `control.json` belong to the handoff: the request that was routed to the operator, the state of the screen at that moment, the operator's resume signal, and who controls the session now.

## What was simulated

- **The human in 04.** A script ([`automation/demo/operator.ts`](../automation/demo/operator.ts)) played the operator so this evidence could be produced unattended. It waited for `intervention-1.json` and attached to the *same* running browser over CDP (`127.0.0.1:9333`). There it clicked "Attest now", ticked the confirmation box and clicked "Submit attestation", then wrote `RESUME`. The run recorded those clicks the same way it records a person's clicks in the headed window. To do it by hand, see [Human handoff](../README.md#human-handoff) in the main README.
- **The dialogs in 04 and 06.** They are real console dialogs. [`automation/demo/environment.ts`](../automation/demo/environment.ts) switched them on through the console's own Administration → Environment controls and reset them afterwards.
- **The model's first attempts in 01.** Nothing here was staged. On turn 8 the model included `[money]` in a caption, and the runtime reported that the locator matched 0 elements. The model corrected it on turn 9. On turn 10 its first `done` proposed a success checkpoint that was not on the page, and the compiler rejected it until turn 11.
