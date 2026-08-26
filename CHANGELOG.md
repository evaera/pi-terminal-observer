# Changelog

## Unreleased

- Rename the package to `pi-terminal-observer`, its tools to `terminal_observer_*`, and its inspection command to `/terminal-observers`.
- Add Paseo terminal capture alongside the existing cmux screen backend, with Paseo selected first by a nonblank `PASEO_AGENT_ID`.
- Add `terminal_observer_ask` for concise, bounded, non-consuming Luna-backed questions with grounded evidence and foreground usage reporting.
- Add independent background semantic watches with sequential bounded batching, line-wise cleaning, stable live-row tracking, strict two-step grounded confirmation, one bounded malformed-response retry, fixed terminal-free lifecycle wakes, adaptive backoff, shared rate/token budgets, context-safe listing, active/completed limits, explicit lifecycle states, and durable per-watch usage entries.
- Make semantic watches recognize standalone satisfying output beside command echoes, reconsider a bounded rolling evidence overlap when later output arrives, require exact output-line quotes, use an explicit dedicated verifier schema, and expose bounded stage-specific parse diagnostics without turning safe schema drift into lifecycle failure.
- Add bounded non-consuming recent and since-cursor observer evidence APIs while preserving read, wait, raw, and stop behavior.
- Document the preferred ask/watch/wait/read hierarchy, model availability behavior, security boundaries, and watch persistence limits.

## 0.1.0

- Add incremental observation of existing cmux terminal surfaces.
- Add explicit start, read, wait, and stop tools with bounded private storage.
- Add gap detection, persisted cursors, lifecycle cleanup, and strict output limits.
