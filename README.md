# pi-cmux-observer

A context-efficient [Pi](https://github.com/earendil-works/pi) extension for incrementally observing existing cmux terminal surfaces.

`pi-cmux-observer` keeps full terminal snapshots outside model context. The model receives terminal content only when it explicitly reads new lines or waits for a matching trigger.

## Requirements

- Pi 0.81.1 or newer
- Node.js 22.19.0 or newer
- cmux with CLI/socket access available to the Pi process

## Installation

Install directly from GitHub:

```sh
pi install git:github.com/evaera/pi-cmux-observer
```

For local development, install the project directory instead:

```sh
pi install /path/to/pi-cmux-observer
```

Run `/reload` after changing an existing installation. The extension registers brief usage guidance and exposes complete tool descriptions and schemas through Pi's custom-tool mechanism.

## Usage

### Start observing

```json
{"surface":"surface:24","workspace":"workspace:9","from":"now"}
```

Call `cmux_observer_start`. `from` defaults to `now`, which suppresses existing screen contents. Use `screen` to include the current normalized screen and scrollback. Repeated starts for the same surface and workspace reuse the active handle.

### Read incremental lines

```json
{"handle":"...","mode":"compact","maxLines":50,"maxChars":4000}
```

Call `cmux_observer_read`. The observer owns and persists the read cursor outside model context. A read advances it and returns terminal lines as plain text under a concise status header:

```text
[cmux observer | mode=compact | cursor=24 | lines=8->4 | omitted=4 | more=no | ended=no | gap=no]
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

### Wait for a trigger

```json
{
  "handle":"...",
  "triggers":[{"type":"literal","pattern":"ready"}],
  "timeoutMs":30000
}
```

Call `cmux_observer_wait`. Regex triggers use JavaScript regular expression syntax. Wait returns only a matching line or timeout status. It does not consume the read cursor or inject unrelated terminal output.

### Stop observing

```json
{"handle":"..."}
```

Call `cmux_observer_stop`. Buffered lines remain readable until Pi session shutdown.

`/cmux-observers` lists handles without sending terminal content to the model.

## Architecture

`cmux pipe-pane` returns a finite snapshot rather than a stream of future terminal output. To observe new output, the extension:

1. Poll `cmux read-screen --surface ... --scrollback` every 250 ms.
2. Keep snapshots inside the extension process, never in Pi model context.
3. Normalize CR/LF and delay the mutable final rendered row until it becomes a completed row.
4. Diff each snapshot against the previous snapshot, including suffix/prefix overlap for scrollback rollover.
5. Append only new lines to a bounded JSONL spool.
6. Return observed text only from an explicit read or a matching wait. Read rendering happens after spooling and cursor advancement, so compact mode does not affect stored data, diffing, triggers, or wait behavior.

This is screen-diff observation, not raw PTY mirroring. It can miss output that appears and disappears between polls. Terminal rewrites or clears can also make continuity ambiguous. The API returns `gap: true` instead of claiming a lossless stream.

## Storage and lifecycle

- Handles are scoped to the current Pi session and use random 128-bit identifiers.
- Runtime files live under `~/.local/state/pi/cmux-observer/<session>/<handle>/`.
- Directories are mode `0700`. `state.json` and `events.jsonl` are mode `0600`.
- Each handle has a 1 MiB bounded spool. Old records are removed and the next read reports a gap.
- Cursor, sequence, surface, lifecycle, and dropped-output metadata are stored in `state.json`, outside model context.
- Stale session directories are removed after 24 hours when an extension session initializes.
- Three consecutive screen-read failures mark an observer ended.
- `session_shutdown` waits for in-flight reads, stops polling, and marks every observer ended.
- Start and stop metadata use `pi.appendEntry()`, which is durable but excluded from model context.

## Safety

The observer does not focus surfaces, send terminal input, or mutate cmux state. It invokes only `cmux read-screen` after startup. Runtime data is local, private, bounded, and removed by TTL.

## Development

```sh
npm install
npm run check
npm test
npm pack --dry-run
```

For a live loading check:

```sh
pi -e /path/to/pi-cmux-observer --offline --list-models
```

## License

MIT
