import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diffSnapshots, normalizeSnapshot, ObserverManager } from "./observer.ts";

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
