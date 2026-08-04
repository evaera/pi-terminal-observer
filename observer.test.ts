import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readToolResult } from "./index.ts";
import {
	cleanTerminalLine,
	compactTerminalLines,
	DEFAULT_MAX_CHARS,
	DEFAULT_MAX_LINES,
	diffSnapshots,
	normalizeSnapshot,
	ObserverManager,
	renderObserverRead,
} from "./observer.ts";

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition was not met before timeout");
}

test("normalization delays the mutable final rendered row", () => {
	assert.deepEqual(normalizeSnapshot("done  \r\npartial\r\n"), ["done"]);
	assert.deepEqual(normalizeSnapshot("prompt only\n"), []);
});

test("snapshot diff handles append, scrollback rollover, and gaps", () => {
	assert.deepEqual(diffSnapshots(["a", "b"], ["a", "b", "c"]), { lines: ["c"], gap: false });
	assert.deepEqual(diffSnapshots(["a", "b", "c"], ["b", "c", "d"]), { lines: ["d"], gap: false });
	assert.deepEqual(diffSnapshots(["a"], ["z"]), { lines: ["z"], gap: true });
	assert.deepEqual(diffSnapshots(["a"], []), { lines: [], gap: true });
});

test("compact rendering cleans control noise and marks deterministic omissions", () => {
	const input = [
		"\u001b[32mDownloading package metadata from registry 10%\u001b[0m",
		"Downloading package metadata from registry 20%",
		"Downloading package metadata from registry 30%",
		"WARNING: retry at 31%",
		"Building [###---] 40%",
		"Building [####--] 60%",
		"Building [######] 100%",
		"done\u0007",
		"a repeated line long enough to benefit",
		"a repeated line long enough to benefit",
		"a repeated line long enough to benefit",
	];
	const compacted = compactTerminalLines(input);
	assert.deepEqual(compacted.lines, [
		"[... 2 progress updates omitted ...]",
		"Downloading package metadata from registry 30%",
		"WARNING: retry at 31%",
		"[... 2 progress updates omitted ...]",
		"Building [######] 100%",
		"done",
		"a repeated line long enough to benefit",
		"[... 2 repeated lines omitted ...]",
	]);
	assert.equal(compacted.omittedLineCount, 6);

	const rendered = renderObserverRead({
		lines: input,
		cursor: 18,
		hasMore: true,
		ended: false,
		gap: true,
		gapReason: "older output unavailable\u0007",
	});
	assert.match(rendered.text, /^\[cmux observer \| mode=compact \| cursor=18 \| lines=11->8 \| omitted=6 \| more=yes \| ended=no \| gap=yes\]/u);
	assert.match(rendered.text, /\[gap: older output unavailable\]/u);
	assert.doesNotMatch(rendered.text, /\u001b|\u0007/u);
	assert.equal(rendered.omittedLineCount, 6);
});

test("terminal cleaning handles OSC links, 7-bit and C1 CSI, and control strings", () => {
	assert.equal(cleanTerminalLine("\u001b]8;;https://example.com\u0007visible link\u001b]8;;\u001b\\"), "visible link");
	assert.equal(cleanTerminalLine("a\u001b[31mred\u001b[0m b\u009b32mgreen\u009b0m"), "ared bgreen");
	assert.equal(cleanTerminalLine("before\u001bPprivate\u0007payload\u001b\\after"), "beforeafter");
	assert.equal(cleanTerminalLine("before\u0090private\u0007payload\u009cafter"), "beforeafter");
	assert.equal(cleanTerminalLine("tab\there\u0007"), "tab    here");
});

test("progress compaction requires a shared signature and preserves important plurals", () => {
	const counters = ["CPU 10%", "Disk 20%", "Memory 30%"];
	assert.deepEqual(compactTerminalLines(counters), { lines: counters, omittedLineCount: 0 });
	const important = ["2 errors at 10%", "3 warnings at 20%", "4 failures at 30%", "5 exceptions at 40%"];
	assert.deepEqual(compactTerminalLines(important), { lines: important, omittedLineCount: 0 });

	const pnpm = [
		"Progress: resolved 100, reused 10, downloaded 20, added 5",
		"Progress: resolved 150, reused 20, downloaded 35, added 15",
		"Progress: resolved 200, reused 30, downloaded 50, added 25",
	];
	assert.deepEqual(compactTerminalLines(pnpm), {
		lines: ["[... 2 progress updates omitted ...]", pnpm[2]!],
		omittedLineCount: 2,
	});
});

test("duplicate compaction never expands short runs", () => {
	assert.deepEqual(compactTerminalLines(["x", "x", "x"]), { lines: ["x", "x", "x"], omittedLineCount: 0 });
	assert.deepEqual(compactTerminalLines(["short", "short"]), { lines: ["short", "short"], omittedLineCount: 0 });
});

test("dependency install blocks preserve edges and summaries with explicit counts", () => {
	const packages = [
		"+ @scope/alpha 1.0.0",
		"+ beta 2.0.0",
		"+ gamma 3.0.0",
		"+ delta 4.0.0",
		"+ epsilon 5.0.0",
		"+ zeta 6.0.0",
		"+ eta 7.0.0",
		"+ theta 8.0.0",
	];
	const compacted = compactTerminalLines(["Packages: +8", ...packages, "Done in 2.1s"]);
	assert.deepEqual(compacted.lines, [
		"Packages: +8",
		...packages.slice(0, 2),
		"[... 4 package entries omitted ...]",
		...packages.slice(-2),
		"Done in 2.1s",
	]);
	assert.equal(compacted.omittedLineCount, 4);

	const packageTree = Array.from({ length: 8 }, (_, index) => {
		const branch = index === 7 ? "└──" : "├──";
		return `${branch} package-name-long-${index + 1}@1.${index}.0`;
	});
	const compactedTree = compactTerminalLines(packageTree);
	assert.deepEqual(compactedTree.lines, [
		...packageTree.slice(0, 2),
		"[... 4 package entries omitted ...]",
		...packageTree.slice(-2),
	]);
	assert.equal(compactedTree.omittedLineCount, 4);

	const uvPackages = [
		"aiohappyeyeballs", "annotated-types", "anyio", "certifi", "click", "distro", "fastapi", "h11",
		"httpcore", "httpx", "idna", "pydantic", "sniffio", "starlette", "typing-extensions",
	];
	const uv = `Installing collected packages: ${uvPackages.join(", ")}`;
	const uvCompacted = compactTerminalLines([uv]);
	assert.deepEqual(uvCompacted.lines, [
		`Installing collected packages: ${uvPackages.slice(0, 3).join(", ")}`,
		"[... 10 package entries omitted ...]",
		uvPackages.slice(-2).join(", "),
	]);
	assert.equal(uvCompacted.omittedLineCount, 10);
});

test("version-shaped ordinary output is not treated as a package block", () => {
	const steps = Array.from({ length: 8 }, (_, index) => `Step ${index + 1} complete`);
	assert.deepEqual(compactTerminalLines(steps), { lines: steps, omittedLineCount: 0 });

	const tests = Array.from({ length: 8 }, (_, index) => `test_case_${index + 1} 1.0 passed`);
	assert.deepEqual(compactTerminalLines(tests), { lines: tests, omittedLineCount: 0 });

	const addedSteps = steps.map((line) => `+ ${line}`);
	assert.deepEqual(compactTerminalLines(addedSteps), { lines: addedSteps, omittedLineCount: 0 });

	const treeSteps = steps.map((line, index) => `${index === steps.length - 1 ? "└──" : "├──"} ${line}`);
	assert.deepEqual(compactTerminalLines(treeSteps), { lines: treeSteps, omittedLineCount: 0 });
});

test("raw rendering preserves exact stored lines inside the plain-text envelope", () => {
	const lines = ["\u001b[31mERROR\u001b[0m", "tab\there", "repeated", "repeated"];
	const rendered = renderObserverRead({ lines, cursor: 4, hasMore: false, ended: true, gap: false }, "raw");
	assert.equal(
		rendered.text,
		`[cmux observer | mode=raw | cursor=4 | lines=4 | more=no | ended=yes | gap=no]\n${lines.join("\n")}`,
	);
	assert.equal(rendered.omittedLineCount, 0);
	assert.equal(rendered.renderedLineCount, 4);
});

test("read tool result exposes plain text and compatible structured details", () => {
	const result = { lines: ["first", "second"], cursor: 2, hasMore: false, ended: false, gap: false };
	assert.deepEqual(readToolResult(result, "raw"), {
		content: [{ type: "text", text: "[cmux observer | mode=raw | cursor=2 | lines=2 | more=no | ended=no | gap=no]\nfirst\nsecond" }],
		details: { ...result, mode: "raw", renderedLineCount: 2, omittedLineCount: 0 },
	});
});

test("default read bounds are context-conservative and preserve cursor pagination", async () => {
	assert.equal(DEFAULT_MAX_LINES, 50);
	assert.equal(DEFAULT_MAX_CHARS, 4_000);
	const baseDir = await mkdtemp(join(tmpdir(), "cmux-observer-defaults-"));
	const completed = Array.from({ length: 60 }, (_, index) => `line-${index}`);
	const manager = new ObserverManager({
		sessionId: "session-defaults",
		baseDir,
		readScreen: async () => `${completed.join("\n")}\nprompt\n`,
	});
	await manager.initialize();
	const { handle } = await manager.start("surface:test", "screen");
	const first = await manager.read(handle);
	assert.deepEqual(first.lines, completed.slice(0, 50));
	assert.equal(first.cursor, 50);
	assert.equal(first.hasMore, true);
	const second = await manager.read(handle);
	assert.deepEqual(second.lines, completed.slice(50));
	assert.equal(second.cursor, 60);
	assert.equal(second.hasMore, false);
	await manager.shutdown();
});

test("observer reads incrementally, waits without consuming, and keeps private files", async () => {
	const baseDir = await mkdtemp(join(tmpdir(), "cmux-observer-test-"));
	let screen = "existing\nprompt\n";
	const manager = new ObserverManager({
		sessionId: "session-test",
		baseDir,
		pollMs: 10,
		readScreen: async () => screen,
	});
	await manager.initialize();
	const { handle } = await manager.start("surface:test", "now");
	assert.match(handle, /^[0-9a-f]{32}$/);
	assert.deepEqual(await manager.start("surface:test", "screen"), { handle, reused: true });
	assert.deepEqual((await manager.read(handle)).lines, []);

	screen = "existing\ncommand\nfirst output\nREADY 42\nprompt\n";
	const waited = await manager.wait(handle, [{ type: "regex", pattern: "READY \\d+" }], 1_000);
	assert.equal(waited.matched, true);
	assert.equal(waited.line, "READY 42");

	const first = await manager.read(handle, 2, 1_000);
	assert.deepEqual(first.lines, ["command", "first output"]);
	assert.equal(first.hasMore, true);
	const second = await manager.read(handle, 10, 1_000);
	assert.deepEqual(second.lines, ["READY 42"]);
	assert.equal(second.hasMore, false);

	const dir = join(baseDir, "session-test", handle);
	assert.equal((await stat(dir)).mode & 0o777, 0o700);
	assert.equal((await stat(join(dir, "state.json"))).mode & 0o777, 0o600);
	assert.equal((await stat(join(dir, "events.jsonl"))).mode & 0o777, 0o600);
	assert.match(await readFile(join(dir, "state.json"), "utf8"), /"readCursor":3/);

	await manager.shutdown();
});

test("bounded spool and per-read character limits report gaps", async () => {
	const baseDir = await mkdtemp(join(tmpdir(), "cmux-observer-bounds-"));
	let screen = "base\nprompt\n";
	const manager = new ObserverManager({
		sessionId: "session-bounds",
		baseDir,
		pollMs: 10,
		spoolBytes: 120,
		readScreen: async () => screen,
	});
	await manager.initialize();
	const { handle } = await manager.start("surface:test", "now");
	screen = `base\n${Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n")}\nprompt\n`;
	await eventually(async () => JSON.parse(await readFile(join(baseDir, "session-bounds", handle, "state.json"), "utf8")).nextSeq >= 21);
	const bounded = await manager.read(handle, 100, 1_000);
	assert.equal(bounded.gap, true);
	assert.ok(bounded.lines.length < 20);
	assert.ok((await stat(join(baseDir, "session-bounds", handle, "events.jsonl"))).size <= 120);

	screen += "abcdefghij\nprompt2\n";
	await eventually(async () => JSON.parse(await readFile(join(baseDir, "session-bounds", handle, "state.json"), "utf8")).nextSeq >= 22);
	const limited = await manager.read(handle, 10, 4);
	assert.ok(limited.lines.join("").length <= 4);
	assert.equal(limited.gap, true);
	await manager.shutdown();
});

test("wait returns a bounded segment containing a late match and reports truncation", async () => {
	const baseDir = await mkdtemp(join(tmpdir(), "cmux-observer-long-wait-"));
	let screen = "base\nprompt\n";
	const manager = new ObserverManager({
		sessionId: "session-long-wait",
		baseDir,
		pollMs: 10,
		readScreen: async () => screen,
	});
	await manager.initialize();
	const { handle } = await manager.start("surface:test", "now");
	screen = `base\n${"x".repeat(21_000)}MATCH_HERE\nprompt\n`;
	const result = await manager.wait(handle, [{ type: "literal", pattern: "MATCH_HERE" }], 1_000);
	assert.equal(result.matched, true);
	assert.equal(result.lineTruncated, true);
	assert.equal(result.gap, true);
	assert.ok(result.line?.includes("MATCH_HERE"));
	assert.ok((result.line?.length ?? 0) <= 20_000);
	await manager.shutdown();
});

test("shutdown waits for an in-flight screen read and prevents post-stop appends", async () => {
	const baseDir = await mkdtemp(join(tmpdir(), "cmux-observer-shutdown-"));
	let calls = 0;
	let release: ((value: string) => void) | undefined;
	const manager = new ObserverManager({
		sessionId: "session-shutdown",
		baseDir,
		pollMs: 10,
		readScreen: async () => {
			calls += 1;
			if (calls === 1) return "base\nprompt\n";
			return new Promise<string>((resolve) => {
				release = resolve;
			});
		},
	});
	await manager.initialize();
	const { handle } = await manager.start("surface:test", "now");
	await eventually(() => calls >= 2);
	let completed = false;
	const shutdown = manager.shutdown().then(() => {
		completed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(completed, false);
	release?.("base\nlate output\nprompt\n");
	await shutdown;
	const statePath = join(baseDir, "session-shutdown", handle, "state.json");
	const atShutdown = JSON.parse(await readFile(statePath, "utf8"));
	await new Promise((resolve) => setTimeout(resolve, 30));
	const later = JSON.parse(await readFile(statePath, "utf8"));
	assert.equal(atShutdown.ended, true);
	assert.equal(atShutdown.nextSeq, 1);
	assert.equal(later.nextSeq, 1);
});

test("three consecutive screen failures end the observer and wake waits", async () => {
	const baseDir = await mkdtemp(join(tmpdir(), "cmux-observer-failure-"));
	let calls = 0;
	const manager = new ObserverManager({
		sessionId: "session-failure",
		baseDir,
		pollMs: 10,
		readScreen: async () => {
			calls += 1;
			if (calls === 1) return "base\nprompt\n";
			throw new Error("surface closed");
		},
	});
	await manager.initialize();
	const { handle } = await manager.start("surface:test", "now");
	const result = await manager.wait(handle, [{ type: "literal", pattern: "never" }], 1_000);
	assert.equal(result.matched, false);
	assert.equal(result.ended, true);
	assert.equal(result.timedOut, false);
	assert.equal(manager.list()[0]?.ended, true);
	assert.match(manager.list()[0]?.endReason ?? "", /surface closed/);
	await manager.shutdown();
});
