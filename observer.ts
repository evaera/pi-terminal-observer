import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_LINES = 50;
export const DEFAULT_MAX_CHARS = 4_000;
export const HARD_MAX_LINES = 500;
export const HARD_MAX_CHARS = 20_000;
export const DEFAULT_SPOOL_BYTES = 1024 * 1024;
export const DEFAULT_POLL_MS = 250;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type ObserverFrom = "now" | "screen";

export interface Trigger {
	type: "literal" | "regex";
	pattern: string;
}

interface RecordLine {
	seq: number;
	text: string;
}

interface PersistedState {
	version: 1;
	handle: string;
	sessionId: string;
	surface: string;
	workspace?: string;
	createdAt: number;
	updatedAt: number;
	readCursor: number;
	firstSeq: number;
	nextSeq: number;
	droppedThrough: number;
	ended: boolean;
	endReason?: string;
}

export interface ObserverReadResult {
	lines: string[];
	cursor: number;
	hasMore: boolean;
	ended: boolean;
	gap: boolean;
	gapReason?: string;
}

export type ObserverReadMode = "compact" | "raw";

export interface RenderedObserverRead {
	text: string;
	mode: ObserverReadMode;
	sourceLineCount: number;
	renderedLineCount: number;
	omittedLineCount: number;
}

const IMPORTANT_LINE = /\b(?:errors?|warnings?|warns?|failed|failures?|fatals?|exceptions?|panics?)\b/iu;
const PROGRESS_TOKEN = /(?:\d{1,3}(?:\.\d+)?%|\b\d+\s*\/\s*\d+\b|\[[#=*>.\- ]{3,}\])/u;
const PNPM_PROGRESS = /^\s*Progress:\s*resolved\s+\d+,\s*reused\s+\d+,\s*downloaded\s+\d+,\s*added\s+\d+\s*$/iu;
const PACKAGE_ENTRY = /^\s*@?[a-z0-9][a-z0-9._/-]*(?:==|===|~=|>=|<=|@|\s+v?)[0-9][^\s,]*(?:\s.*)?$/iu;
const TREE_PACKAGE_ENTRY = /^\s*[├└]─+\s*@?[a-z0-9][a-z0-9._/-]*(?:==|===|~=|>=|<=|@)[0-9][^\s,]*(?:\s.*)?$/iu;
const SPEC_PACKAGE_ENTRY = /^\s*\+\s+@?[a-z0-9][a-z0-9._/-]*(?:==|===|~=|>=|<=|@)[0-9][^\s,]*(?:\s.*)?$/iu;
const PACKAGE_CONTEXT = /^\s*(?:packages(?:\s*:|\s+[+-]\d)|(?:dev|optional|peer)?dependencies\s*:|installing packages\s*:)/iu;
const PACKAGE_LIST = /^(.*\b(?:installing collected packages|resolved dependencies)\s*:\s*)(.+)$/iu;

function isFinalByte(code: number): boolean {
	return code >= 0x40 && code <= 0x7e;
}

function skipControlString(line: string, start: number, bellTerminated: boolean): number {
	let index = start;
	while (index < line.length) {
		const code = line.charCodeAt(index);
		if ((bellTerminated && code === 0x07) || code === 0x9c) return index + 1;
		if (code === 0x1b && line.charCodeAt(index + 1) === 0x5c) return index + 2;
		index += 1;
	}
	return index;
}

function skipCsi(line: string, start: number): number {
	let index = start;
	while (index < line.length) {
		if (isFinalByte(line.charCodeAt(index))) return index + 1;
		index += 1;
	}
	return index;
}

/** Strip ECMA-48 terminal controls while retaining printable text, including OSC 8 link labels. */
export function cleanTerminalLine(line: string): string {
	let output = "";
	let index = 0;
	while (index < line.length) {
		const code = line.charCodeAt(index);
		if (code === 0x1b) {
			const next = line.charCodeAt(index + 1);
			if (next === 0x5b) index = skipCsi(line, index + 2);
			else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				index = skipControlString(line, index + 2, next === 0x5d);
			} else {
				index += 1;
				while (index < line.length && line.charCodeAt(index) >= 0x20 && line.charCodeAt(index) <= 0x2f) index += 1;
				if (index < line.length) index += 1;
			}
			continue;
		}
		if (code === 0x9b) {
			index = skipCsi(line, index + 1);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			index = skipControlString(line, index + 1, code === 0x9d);
			continue;
		}
		if (code === 0x09) output += "    ";
		else if ((code >= 0x20 && code !== 0x7f && code < 0x80) || code >= 0xa0) output += line[index];
		index += 1;
	}
	return output;
}

function joinedLength(lines: string[]): number {
	return lines.reduce((length, line) => length + line.length, Math.max(0, lines.length - 1));
}

function shorterThan(replacement: string[], original: string[]): boolean {
	return joinedLength(replacement) < joinedLength(original);
}

function progressSignature(line: string): string | undefined {
	if (PNPM_PROGRESS.test(line)) {
		return line.replace(/\d+/gu, "<count>").trim().toLowerCase();
	}
	if (!PROGRESS_TOKEN.test(line)) return undefined;
	return line
		.replace(/\[[#=*>.\- ]{3,}\]/gu, "<bar>")
		.replace(/\d{1,3}(?:\.\d+)?%/gu, "<percent>")
		.replace(/\b\d+\s*\/\s*\d+\b/gu, "<fraction>")
		.trim()
		.toLowerCase();
}

function compactPackageList(line: string): { lines: string[]; omitted: number } | undefined {
	const match = PACKAGE_LIST.exec(line);
	if (!match) return undefined;
	const packages = match[2]!.split(/,\s*/u);
	if (packages.length < 8) return undefined;
	const omitted = packages.length - 5;
	const replacement = [
		`${match[1]}${packages.slice(0, 3).join(", ")}`,
		`[... ${omitted} package entries omitted ...]`,
		packages.slice(-2).join(", "),
	];
	return shorterThan(replacement, [line]) ? { lines: replacement, omitted } : undefined;
}

export function compactTerminalLines(lines: string[]): { lines: string[]; omittedLineCount: number } {
	const cleaned = lines.map(cleanTerminalLine);
	const output: string[] = [];
	let omittedLineCount = 0;
	let index = 0;

	while (index < cleaned.length) {
		const line = cleaned[index]!;
		const inlinePackages = !IMPORTANT_LINE.test(line) ? compactPackageList(line) : undefined;
		if (inlinePackages) {
			output.push(...inlinePackages.lines);
			omittedLineCount += inlinePackages.omitted;
			index += 1;
			continue;
		}

		let end = index + 1;
		while (end < cleaned.length && cleaned[end] === line) end += 1;
		const repeatedReplacement = [line, `[... ${end - index - 1} repeated ${end - index === 2 ? "line" : "lines"} omitted ...]`];
		if (end - index > 1 && !IMPORTANT_LINE.test(line) && shorterThan(repeatedReplacement, cleaned.slice(index, end))) {
			output.push(...repeatedReplacement);
			omittedLineCount += end - index - 1;
			index = end;
			continue;
		}

		const signature = progressSignature(line);
		if (signature && !IMPORTANT_LINE.test(line)) {
			end = index + 1;
			while (end < cleaned.length && progressSignature(cleaned[end]!) === signature && !IMPORTANT_LINE.test(cleaned[end]!)) end += 1;
			const omitted = end - index - 1;
			const replacement = [`[... ${omitted} progress updates omitted ...]`, cleaned[end - 1]!];
			if (end - index >= 3 && shorterThan(replacement, cleaned.slice(index, end))) {
				output.push(...replacement);
				omittedLineCount += omitted;
				index = end;
				continue;
			}
		}

		const hasPackageContext = index > 0 && PACKAGE_CONTEXT.test(cleaned[index - 1]!);
		const isPackageEntry = (candidate: string) => TREE_PACKAGE_ENTRY.test(candidate)
			|| SPEC_PACKAGE_ENTRY.test(candidate)
			|| (hasPackageContext && PACKAGE_ENTRY.test(candidate.replace(/^\s*(?:[+~-]\s+|[├└]─+\s*)/u, "")));
		if (isPackageEntry(line) && !IMPORTANT_LINE.test(line)) {
			end = index + 1;
			while (end < cleaned.length && isPackageEntry(cleaned[end]!) && !IMPORTANT_LINE.test(cleaned[end]!)) end += 1;
			if (end - index >= 6) {
				const omitted = end - index - 4;
				const replacement = [
					...cleaned.slice(index, index + 2),
					`[... ${omitted} package entries omitted ...]`,
					...cleaned.slice(end - 2, end),
				];
				if (shorterThan(replacement, cleaned.slice(index, end))) {
					output.push(...replacement);
					omittedLineCount += omitted;
					index = end;
					continue;
				}
			}
		}

		output.push(line);
		index += 1;
	}

	return { lines: output, omittedLineCount };
}

export function renderObserverRead(result: ObserverReadResult, mode: ObserverReadMode = "compact"): RenderedObserverRead {
	const compacted = mode === "compact"
		? compactTerminalLines(result.lines)
		: { lines: result.lines, omittedLineCount: 0 };
	const counts = mode === "compact"
		? `${result.lines.length}->${compacted.lines.length}`
		: String(result.lines.length);
	const status = [
		"cmux observer",
		`mode=${mode}`,
		`cursor=${result.cursor}`,
		`lines=${counts}`,
		...(compacted.omittedLineCount > 0 ? [`omitted=${compacted.omittedLineCount}`] : []),
		`more=${result.hasMore ? "yes" : "no"}`,
		`ended=${result.ended ? "yes" : "no"}`,
		`gap=${result.gap ? "yes" : "no"}`,
	].join(" | ");
	const metadata = [`[${status}]`, ...(result.gapReason ? [`[gap: ${cleanTerminalLine(result.gapReason)}]`] : [])];
	const body = compacted.lines.length > 0 ? compacted.lines.join("\n") : "[no new output]";
	return {
		text: `${metadata.join("\n")}\n${body}`,
		mode,
		sourceLineCount: result.lines.length,
		renderedLineCount: compacted.lines.length,
		omittedLineCount: compacted.omittedLineCount,
	};
}

export interface ObserverWaitResult {
	matched: boolean;
	timedOut: boolean;
	line?: string;
	lineTruncated?: boolean;
	cursor: number;
	trigger?: Trigger;
	ended: boolean;
	gap: boolean;
}

export interface ObserverInfo {
	handle: string;
	surface: string;
	workspace?: string;
	cursor: number;
	ended: boolean;
	endReason?: string;
}

export interface ObserverManagerOptions {
	sessionId: string;
	baseDir?: string;
	cmuxBin?: string;
	pollMs?: number;
	spoolBytes?: number;
	ttlMs?: number;
	readScreen?: (surface: string, workspace?: string) => Promise<string>;
}

function serializeRecord(record: RecordLine): string {
	return `${JSON.stringify(record)}\n`;
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const file = await open(temporary, "w", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
	await chmod(path, 0o600);
}

export function normalizeSnapshot(text: string): string[] {
	const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	if (lines.length === 0) return [];
	// The last rendered row may still be changing (prompt, progress bar, partial line).
	// Delay it until a later row appears so model-facing output favors completed lines.
	return lines.slice(0, -1).map((line) => line.replace(/[\t ]+$/u, ""));
}

export function diffSnapshots(previous: string[], current: string[]): { lines: string[]; gap: boolean } {
	if (previous.length === 0) return { lines: current, gap: false };
	if (current.length >= previous.length && previous.every((line, index) => current[index] === line)) {
		return { lines: current.slice(previous.length), gap: false };
	}

	let best = 0;
	for (let start = 0; start < previous.length; start += 1) {
		if (previous[start] !== current[0]) continue;
		const length = Math.min(previous.length - start, current.length);
		let matched = 0;
		while (matched < length && previous[start + matched] === current[matched]) matched += 1;
		if (matched === previous.length - start && matched > best) best = matched;
	}
	if (best > 0) return { lines: current.slice(best), gap: false };
	return { lines: current, gap: true };
}

class Observer {
	readonly handle: string;
	readonly surface: string;
	readonly workspace?: string;
	private readonly dir: string;
	private readonly statePath: string;
	private readonly eventsPath: string;
	private readonly maxBytes: number;
	private readonly pollMs: number;
	private readonly readScreen: (surface: string, workspace?: string) => Promise<string>;
	private state: PersistedState;
	private records: RecordLine[] = [];
	private previous: string[] = [];
	private timer?: NodeJS.Timeout;
	private pollTask?: Promise<void>;
	private consecutiveErrors = 0;
	private pendingGapReason?: string;
	private revision = 0;
	private waiters = new Set<() => void>();
	private mutation: Promise<unknown> = Promise.resolve();

	constructor(options: {
		handle: string;
		sessionId: string;
		surface: string;
		workspace?: string;
		dir: string;
		maxBytes: number;
		pollMs: number;
		readScreen: (surface: string, workspace?: string) => Promise<string>;
	}) {
		this.handle = options.handle;
		this.surface = options.surface;
		this.workspace = options.workspace;
		this.dir = options.dir;
		this.statePath = join(this.dir, "state.json");
		this.eventsPath = join(this.dir, "events.jsonl");
		this.maxBytes = options.maxBytes;
		this.pollMs = options.pollMs;
		this.readScreen = options.readScreen;
		const now = Date.now();
		this.state = {
			version: 1,
			handle: options.handle,
			sessionId: options.sessionId,
			surface: options.surface,
			workspace: options.workspace,
			createdAt: now,
			updatedAt: now,
			readCursor: 0,
			firstSeq: 1,
			nextSeq: 1,
			droppedThrough: 0,
			ended: false,
		};
	}

	private withLock<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.mutation.then(operation, operation);
		this.mutation = next.catch(() => undefined);
		return next;
	}

	async start(from: ObserverFrom): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		await chmod(this.dir, 0o700);
		const snapshot = normalizeSnapshot(await this.readScreen(this.surface, this.workspace));
		this.previous = snapshot;
		if (from === "screen") await this.appendUnlocked(snapshot);
		await this.persist();
		this.timer = setInterval(() => this.schedulePoll(), this.pollMs);
		this.timer.unref();
	}

	info(): ObserverInfo {
		return {
			handle: this.handle,
			surface: this.surface,
			workspace: this.workspace,
			cursor: this.state.readCursor,
			ended: this.state.ended,
			endReason: this.state.endReason,
		};
	}

	private schedulePoll(): void {
		if (this.pollTask || this.state.ended) return;
		const task = this.poll();
		this.pollTask = task;
		void task.finally(() => {
			if (this.pollTask === task) this.pollTask = undefined;
		}).catch(() => undefined);
	}

	private async poll(): Promise<void> {
		try {
			const current = normalizeSnapshot(await this.readScreen(this.surface, this.workspace));
			this.consecutiveErrors = 0;
			await this.withLock(async () => {
				if (this.state.ended) return;
				const delta = diffSnapshots(this.previous, current);
				this.previous = current;
				if (delta.gap) this.markGap("screen snapshots no longer overlap; output may have been dropped or rewritten");
				if (delta.lines.length > 0) await this.appendUnlocked(delta.lines);
				else if (Date.now() - this.state.updatedAt >= 60_000) await this.persist();
			});
		} catch (error) {
			this.consecutiveErrors += 1;
			if (this.consecutiveErrors >= 3) {
				if (this.timer) clearInterval(this.timer);
				this.timer = undefined;
				await this.withLock(async () => {
					if (this.state.ended) return;
					this.state.ended = true;
					this.state.endReason = `surface unavailable: ${error instanceof Error ? error.message : String(error)}`;
					await this.persist();
				});
				this.notifyWaiters();
			}
		}
	}

	private markGap(reason: string): void {
		this.pendingGapReason = reason;
	}

	private async appendUnlocked(lines: string[]): Promise<void> {
		for (const text of lines) this.records.push({ seq: this.state.nextSeq++, text });
		let bytes = this.records.reduce((total, record) => total + Buffer.byteLength(serializeRecord(record)), 0);
		while (this.records.length > 0 && bytes > this.maxBytes) {
			const dropped = this.records.shift()!;
			bytes -= Buffer.byteLength(serializeRecord(dropped));
			this.state.droppedThrough = Math.max(this.state.droppedThrough, dropped.seq);
		}
		this.state.firstSeq = this.records[0]?.seq ?? this.state.nextSeq;
		if (this.state.readCursor < this.state.droppedThrough) {
			this.markGap(`bounded spool dropped output through cursor ${this.state.droppedThrough}`);
		}
		await this.persist();
		this.notifyWaiters();
	}

	private async persist(): Promise<void> {
		this.state.updatedAt = Date.now();
		await atomicPrivateWrite(this.eventsPath, this.records.map(serializeRecord).join(""));
		await atomicPrivateWrite(this.statePath, `${JSON.stringify(this.state)}\n`);
	}

	private notifyWaiters(): void {
		this.revision += 1;
		for (const wake of this.waiters) wake();
		this.waiters.clear();
	}

	async read(maxLines: number, maxChars: number): Promise<ObserverReadResult> {
		return this.withLock(async () => {
			let gap = false;
			let gapReason: string | undefined;
			if (this.state.readCursor < this.state.firstSeq - 1 || this.pendingGapReason) {
				gap = true;
				gapReason = this.pendingGapReason ?? `output before cursor ${this.state.firstSeq - 1} is unavailable`;
				this.state.readCursor = Math.max(this.state.readCursor, this.state.firstSeq - 1);
				this.pendingGapReason = undefined;
			}

			const available = this.records.filter((record) => record.seq > this.state.readCursor);
			const lines: string[] = [];
			let chars = 0;
			let lastCursor = this.state.readCursor;
			for (const record of available) {
				if (lines.length >= maxLines) break;
				const remaining = maxChars - chars;
				if (remaining <= 0) break;
				let text = record.text;
				if (text.length > remaining) text = text.slice(0, remaining);
				lines.push(text);
				chars += text.length;
				lastCursor = record.seq;
				if (text.length < record.text.length) {
					gap = true;
					gapReason = "a line exceeded maxChars and was truncated";
					break;
				}
			}
			this.state.readCursor = lastCursor;
			await this.persist();
			return {
				lines,
				cursor: this.state.readCursor,
				hasMore: this.records.some((record) => record.seq > this.state.readCursor),
				ended: this.state.ended,
				gap,
				gapReason,
			};
		});
	}

	private findMatch(after: number, triggers: Trigger[]): { record: RecordLine; trigger: Trigger; start: number; end: number } | undefined {
		for (const record of this.records) {
			if (record.seq <= after) continue;
			for (const trigger of triggers) {
				if (trigger.type === "literal") {
					const start = record.text.indexOf(trigger.pattern);
					if (start >= 0) return { record, trigger, start, end: start + trigger.pattern.length };
				}
				if (trigger.type === "regex") {
					let expression: RegExp;
					try {
						expression = new RegExp(trigger.pattern, "u");
					} catch (error) {
						throw new Error(`Invalid trigger regex ${JSON.stringify(trigger.pattern)}: ${error instanceof Error ? error.message : String(error)}`);
					}
					const match = expression.exec(record.text);
					if (match) return { record, trigger, start: match.index, end: match.index + match[0].length };
				}
			}
		}
		return undefined;
	}

	async wait(triggers: Trigger[], timeoutMs: number, signal?: AbortSignal): Promise<ObserverWaitResult> {
		if (triggers.length === 0) throw new Error("At least one trigger is required");
		for (const trigger of triggers) if (!trigger.pattern) throw new Error("Trigger patterns must not be empty");
		let cursor = this.state.readCursor;
		if (cursor < this.state.firstSeq - 1) cursor = this.state.firstSeq - 1;
		const deadline = Date.now() + timeoutMs;

		while (true) {
			const match = this.findMatch(cursor, triggers);
			if (match) {
				const lineTruncated = match.record.text.length > HARD_MAX_CHARS;
				let start = 0;
				if (lineTruncated) {
					start = Math.max(0, match.start - Math.floor(HARD_MAX_CHARS / 4));
					if (match.end > start + HARD_MAX_CHARS) start = Math.max(0, match.end - HARD_MAX_CHARS);
				}
				return {
					matched: true,
					timedOut: false,
					line: match.record.text.slice(start, start + HARD_MAX_CHARS),
					lineTruncated: lineTruncated || undefined,
					cursor: match.record.seq,
					trigger: match.trigger,
					ended: this.state.ended,
					gap: lineTruncated || cursor < this.state.firstSeq - 1 || Boolean(this.pendingGapReason),
				};
			}
			if (this.state.ended || Date.now() >= deadline) {
				return {
					matched: false,
					timedOut: !this.state.ended,
					cursor: this.state.readCursor,
					ended: this.state.ended,
					gap: cursor < this.state.firstSeq - 1 || Boolean(this.pendingGapReason),
				};
			}
			const revision = this.revision;
			await new Promise<void>((resolve, reject) => {
				const remaining = Math.max(1, deadline - Date.now());
				const timer = setTimeout(done, Math.min(remaining, this.pollMs * 2));
				const onAbort = () => done(new Error("Observer wait cancelled"));
				const wake = () => done();
				const observer = this;
				function done(error?: Error): void {
					clearTimeout(timer);
					observer.waiters.delete(wake);
					signal?.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve();
				}
				if (signal?.aborted) return done(new Error("Observer wait cancelled"));
				this.waiters.add(wake);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (this.revision !== revision) done();
			});
		}
	}

	async stop(reason = "stopped"): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.withLock(async () => {
			if (!this.state.ended) {
				this.state.ended = true;
				this.state.endReason = reason;
				await this.persist();
			}
		});
		await this.pollTask?.catch(() => undefined);
		this.notifyWaiters();
	}
}

export class ObserverManager {
	private readonly sessionId: string;
	private readonly sessionDir: string;
	private readonly baseDir: string;
	private readonly cmuxBin: string;
	private readonly pollMs: number;
	private readonly spoolBytes: number;
	private readonly ttlMs: number;
	private readonly customReadScreen?: (surface: string, workspace?: string) => Promise<string>;
	private observers = new Map<string, Observer>();
	private byTarget = new Map<string, string>();

	constructor(options: ObserverManagerOptions) {
		this.sessionId = options.sessionId;
		this.baseDir = options.baseDir ?? join(homedir(), ".local", "state", "pi", "cmux-observer");
		this.sessionDir = join(this.baseDir, options.sessionId);
		this.cmuxBin = options.cmuxBin ?? "cmux";
		this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		this.spoolBytes = options.spoolBytes ?? DEFAULT_SPOOL_BYTES;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.customReadScreen = options.readScreen;
	}

	async initialize(): Promise<void> {
		await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
		await chmod(this.baseDir, 0o700);
		await this.cleanupExpired();
		await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
		await chmod(this.sessionDir, 0o700);
	}

	private async cleanupExpired(): Promise<void> {
		const cutoff = Date.now() - this.ttlMs;
		for (const name of await readdir(this.baseDir).catch(() => [] as string[])) {
			const path = join(this.baseDir, name);
			try {
				let newestActivity = (await stat(path)).mtimeMs;
				for (const handle of await readdir(path).catch(() => [] as string[])) {
					try {
						const state = JSON.parse(await readFile(join(path, handle, "state.json"), "utf8")) as { updatedAt?: unknown };
						if (typeof state.updatedAt === "number") newestActivity = Math.max(newestActivity, state.updatedAt);
					} catch {
						// Ignore incomplete handles and use directory metadata as the fallback.
					}
				}
				if (newestActivity < cutoff) await rm(path, { recursive: true, force: true });
			} catch {
				// Another process may have cleaned it first.
			}
		}
	}

	private targetKey(surface: string, workspace?: string): string {
		return `${workspace ?? ""}\u0000${surface}`;
	}

	private async readScreen(surface: string, workspace?: string): Promise<string> {
		if (this.customReadScreen) return this.customReadScreen(surface, workspace);
		const args = ["read-screen"];
		if (workspace) args.push("--workspace", workspace);
		args.push("--surface", surface, "--scrollback");
		const result = await execFileAsync(this.cmuxBin, args, {
			encoding: "utf8",
			timeout: 3_000,
			maxBuffer: 8 * 1024 * 1024,
		});
		return result.stdout;
	}

	async start(surface: string, from: ObserverFrom, workspace?: string): Promise<{ handle: string; reused: boolean }> {
		if (!surface.trim()) throw new Error("surface is required");
		const key = this.targetKey(surface, workspace);
		const existingHandle = this.byTarget.get(key);
		if (existingHandle) {
			const existing = this.observers.get(existingHandle);
			if (existing && !existing.info().ended) return { handle: existingHandle, reused: true };
		}
		const handle = randomBytes(16).toString("hex");
		const observer = new Observer({
			handle,
			sessionId: this.sessionId,
			surface,
			workspace,
			dir: join(this.sessionDir, handle),
			maxBytes: this.spoolBytes,
			pollMs: this.pollMs,
			readScreen: (targetSurface, targetWorkspace) => this.readScreen(targetSurface, targetWorkspace),
		});
		await observer.start(from);
		this.observers.set(handle, observer);
		this.byTarget.set(key, handle);
		return { handle, reused: false };
	}

	private require(handle: string): Observer {
		const observer = this.observers.get(handle);
		if (!observer) throw new Error(`Unknown or expired observer handle: ${handle}`);
		return observer;
	}

	async read(handle: string, maxLines = DEFAULT_MAX_LINES, maxChars = DEFAULT_MAX_CHARS): Promise<ObserverReadResult> {
		return this.require(handle).read(
			Math.max(1, Math.min(HARD_MAX_LINES, maxLines)),
			Math.max(1, Math.min(HARD_MAX_CHARS, maxChars)),
		);
	}

	async wait(handle: string, triggers: Trigger[], timeoutMs: number, signal?: AbortSignal): Promise<ObserverWaitResult> {
		return this.require(handle).wait(triggers, Math.max(0, Math.min(120_000, timeoutMs)), signal);
	}

	async stop(handle: string, reason = "stopped"): Promise<ObserverInfo> {
		const observer = this.require(handle);
		await observer.stop(reason);
		this.byTarget.delete(this.targetKey(observer.surface, observer.workspace));
		return observer.info();
	}

	list(): ObserverInfo[] {
		return [...this.observers.values()].map((observer) => observer.info());
	}

	async shutdown(): Promise<void> {
		await Promise.all([...this.observers.values()].map((observer) => observer.stop("Pi session shutdown")));
		this.observers.clear();
		this.byTarget.clear();
	}
}
