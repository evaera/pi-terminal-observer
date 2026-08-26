# pi-terminal-observer

A terminal surface observer for [Pi](https://github.com/earendil-works/pi). It lets the agent and human share existing interactive terminal surfaces without repeatedly copying full screen snapshots into model context.

`pi-terminal-observer` is passive. It does not create terminals, launch or control processes inside them, send input, change focus, or take ownership of a surface. The main model receives terminal content only when it explicitly reads new lines, waits for a matching trigger, asks a bounded question, or receives a grounded semantic watch notification.

## Requirements

- Pi 0.81.1 or newer. Direct model calls use the `@earendil-works/pi-ai/compat` API verified by this package's type check; treat a future compat removal or signature change as a build-time upgrade tripwire.
- Node.js 22.19.0 or newer
- cmux with CLI/socket access, or the Paseo CLI, available to the Pi process

A nonblank `PASEO_AGENT_ID` selects Paseo even if inherited cmux identity variables are also present.

## Supported terminal surfaces

- [x] cmux terminal surfaces, captured through `cmux read-screen`
- [x] Paseo managed terminals, captured through `${PASEO_CLI:-paseo} terminal capture`

The `surface` argument is a cmux surface ref or a Paseo terminal ID. `workspace` is cmux-only and is ignored under Paseo.

## Installation

Install directly from GitHub:

```sh
pi install git:github.com/evaera/pi-cmux-observer
```

For local development, install the project directory instead:

```sh
pi install /path/to/pi-terminal-observer
```

Run `/reload` after changing an existing installation. The extension registers brief usage guidance and exposes complete tool descriptions and schemas through Pi's custom-tool mechanism.

## Usage

### Start observing

cmux:

```json
{"surface":"surface:24","workspace":"workspace:9","from":"now"}
```

Paseo:

```json
{"surface":"<terminal-id>","from":"now"}
```

Call `terminal_observer_start`. `from` defaults to `now`, which suppresses existing screen contents. Use `screen` to include the current normalized screen and scrollback. Repeated starts for the same target reuse the active handle.

### Read incremental lines

```json
{"handle":"...","mode":"compact","maxLines":50,"maxChars":4000}
```

Call `terminal_observer_read`. The observer owns and persists the read cursor outside model context. A read advances it and returns terminal lines as plain text under a concise status header:

```text
[terminal observer | mode=compact | cursor=24 | lines=8->4 | omitted=4 | more=no | ended=no | gap=no]
Building package
[... 3 progress updates omitted ...]
Build complete
ready
```

`mode` defaults to `compact`. Compact mode strips ANSI and terminal control noise, conservatively collapses consecutive duplicate and same-signature progress lines, and shortens large package-install listings. Explicit omission markers and counts describe collapsed lines or entries, while warnings, errors, beginning and ending summaries, and useful tail output remain visible.

Use `mode: "raw"` when exact output matters. Raw mode does not clean or collapse stored line text. Its only addition is the plain-text status envelope. Reads consume the cursor, so select raw on that read before compact rendering discards presentation detail from model-facing output:

```json
{"handle":"...","mode":"raw"}
```

Structured cursor, gap, lifecycle, original line, and compaction-count data remain available in tool result details for clients that inspect them. Default limits are 50 lines and 4,000 observed characters. Hard limits are 500 lines and 20,000 observed characters per call.

### Ask about recent output

```json
{"handle":"...","question":"Did the build finish successfully?"}
```

Call `terminal_observer_ask` for a concise answer based on the newest evidence gathered backwards within at most 80 recent compact lines and 8,000 characters. It makes a direct, tool-free Luna request at low thinking and returns only the answer, up to three short exact evidence quotes, status, model, usage, and gap metadata. It does not consume the ordinary read cursor. Optional `maxLines` and `maxChars` can lower the evidence bounds. If Luna is unavailable, ask returns a clearly labeled `model-unavailable` result with up to three deterministic compact evidence lines and does not invent an answer.

Luna is discovered from Pi's authenticated runtime model registry using an exact allowlist, in priority order: `cloudflare-ai-gateway/gpt-5.6-luna`, `openai/gpt-5.6-luna`, then `azure-openai-responses/gpt-5.6-luna`. Substring matches and other providers are never selected. If no allowlisted authenticated model exists, ask returns its labeled deterministic evidence fallback while watches fail closed.

### Watch for a semantic condition

```json
{"action":"start","handle":"...","condition":"the build has completed successfully","timeoutMs":1800000}
```

Call `terminal_observer_watch` with `action: "start"` to create a background semantic watch. Start returns its ID immediately. Each watch begins at the latest output and owns an independent cursor, so it does not consume ordinary reads or interfere with sibling watches. Meaningful new output is processed sequentially in bounded front-to-back chunks and debounced for about 750 ms before evaluation. A finite burst gets up to three consecutive minimum-backoff drain chunks, then adaptive doubling resumes even if a producer sustains the backlog. The fast-drain window resets after the backlog clears. No model request is made while there is no new output. Each evaluation retains at most 12 recently evaluated cleaned completed lines and 1,200 characters. Mutable live rows are never retained because they may be overwritten. The completed-line overlap is reconsidered only alongside later completed output or a later stable live-row revision, preventing one low-confidence decision from permanently consuming a possible match without causing idle model calls. New evidence keeps priority within the unchanged 80-line and 8,000-character prompt bounds.

The decision prompt requires line-by-line evaluation: a standalone output line can prove the condition even when a typed shell command echo appears in the same chunk. Evidence must quote the exact complete satisfying output line, not command text or a command substring. Grounding deliberately compares cleaned display lines after trimming surrounding whitespace, so an indented output quote can match its displayed line while a substring embedded in a command cannot. The prompt identifies the sole current live row by index; its reserved `[stable live row]` marker cannot be fabricated by completed terminal output. Confirmed evidence is stored as normalized cleaned display text, without observer markers or terminal controls. A watch creates a candidate only when strict JSON reports a high-confidence match and this normalized exact-line grounding succeeds. A distinct stricter verifier must confirm it against the same stable evidence. Each watch line is cleaned independently while retaining one-to-one cursor mapping, then JSON-encoded as untrusted data; nested requests have no tools. One malformed structured response is retried once within the same budgets and never fires. Repeated schema drift remains an active fail-closed non-match with bounded stage-specific diagnostics rather than ending the watch immediately. A 500,000-token per-watch cap, 2,000,000-token shared session cap, wall-clock timeout, and shared request-rate gate let the default 30-minute adaptive cadence run plausibly while remaining hard-bounded. Unavailable, aborted, or over-budget calls end with fixed public summaries.

Use `{"action":"list"}` to inspect bounded untrusted evidence, gap state, evaluation/token totals, statuses, and the last decision's bounded confidence, reason code, and short summary. The default returns all active watches plus five recent completed watches; `watchId`, `status`, and `limit` (maximum 25) filter it. Conditions are truncated to 120 characters, evidence fields are shortened, and serialized entries have a 20,000-byte hard bound. Use `{"action":"cancel","watchId":"..."}` to cancel. At most 16 watches may be active per session and 4 per handle; only the newest 100 completed watches are retained. Timeout defaults to 30 minutes and is capped at 24 hours. Fixed terminal-free follow-up messages wake the main agent for `matched`, `timed-out`, `ended`, and `error`, with the outcome distinguished safely. Reload/shutdown cancels timers and in-flight calls without a later wake. Watches do not persist across process restarts. Background usage is appended durably as excluded `terminal-observer-state` entries after each completion, but Pi does not add it to foreground tool-call usage totals.

### Wait for a trigger

```json
{
  "handle":"...",
  "triggers":[{"type":"literal","pattern":"ready"}],
  "timeoutMs":30000
}
```

Call `terminal_observer_wait`. Regex triggers use JavaScript regular expression syntax. Wait returns only a matching line or timeout status. It does not consume the read cursor or inject unrelated terminal output.

Preferred hierarchy: use **ask** to understand current status, **watch** for future semantic conditions, **wait** for exact literal or regex conditions, and **read** for broader evidence or exact/raw output.

### Stop observing

```json
{"handle":"..."}
```

Call `terminal_observer_stop`. Buffered lines remain readable until Pi session shutdown.

`/terminal-observers` lists handles without sending terminal content to the model.

## Architecture

Both supported capture commands return finite snapshots rather than streams of future terminal output. To observe new output, the extension:

1. Poll `cmux read-screen --surface ... --scrollback`, or Paseo `terminal capture ... --scrollback --json`, every 250 ms.
2. Keep snapshots inside the extension process, never in Pi model context.
3. Normalize CR/LF and keep the mutable final rendered row separate with revision and stability tracking. It remains excluded from ordinary reads but lets semantic operations notice stable prompt-only transitions.
4. Diff each snapshot against the previous snapshot, including suffix/prefix overlap for scrollback rollover.
5. Append only new lines to a bounded JSONL spool.
6. Expose bounded non-consuming recent and since-cursor views to ask and independent watches.
7. Return observed text only from an explicit operation or a grounded watch notification. Read rendering happens after spooling and cursor advancement, so compact mode does not affect stored data, diffing, triggers, or wait behavior.

This is screen-diff observation, not raw PTY mirroring. It can miss output that appears and disappears between polls. Terminal rewrites or clears can also make continuity ambiguous. The API returns `gap: true` instead of claiming a lossless stream.

## Storage and lifecycle

- Handles are scoped to the current Pi session and use random 128-bit identifiers.
- Runtime files live under `~/.local/state/pi/terminal-observer/<session>/<handle>/`.
- Directories are mode `0700`. `state.json` and `events.jsonl` are mode `0600`.
- Each handle has a 1 MiB bounded spool. High-volume output can outrun it before a watch drains every chunk; old records are removed and reads or watches report a gap.
- A single completed terminal line over the watch's 8,000-character evidence limit cannot be advanced safely, so that watch fails closed with a fixed error wake.
- Cursor, sequence, surface, lifecycle, and dropped-output metadata are stored in `state.json`, outside model context.
- Screen-diff gaps remain sticky and visible to semantic operations until an ordinary read acknowledges them. Semantic access never consumes the ordinary gap flag.
- Stale session directories are removed after 24 hours when an extension session initializes.
- Three consecutive screen-read failures mark an observer ended.
- `session_shutdown` cancels semantic watches and model requests, waits for in-flight screen reads, stops polling, and marks every observer ended.
- Start and stop metadata use `pi.appendEntry()`, which is durable but excluded from model context.

## Safety

The observer does not focus targets, send terminal input, or mutate terminal state. It invokes only cmux `read-screen` or Paseo `terminal capture` after startup. Runtime data is local, private, bounded, and removed by TTL. Terminal content is JSON-encoded as untrusted evidence in tool-free nested model requests. Watch decisions require valid structured output, high confidence, and a literal quote grounded in the supplied lines.

## Development

```sh
npm install
npm run check
npm test
npm pack --dry-run
```

For a live loading check:

```sh
pi -e /path/to/pi-terminal-observer --offline --list-models
```

## License

MIT
