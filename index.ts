import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_MAX_CHARS,
	DEFAULT_MAX_LINES,
	HARD_MAX_CHARS,
	HARD_MAX_LINES,
	ObserverManager,
	type ObserverFrom,
	type Trigger,
} from "./observer.ts";

const STATE_ENTRY = "cmux-observer-state";

const triggerSchema = Type.Object({
	type: StringEnum(["literal", "regex"] as const, { description: "Literal substring or JavaScript regular expression" }),
	pattern: Type.String({ minLength: 1, description: "Substring or regex pattern to match against one completed line" }),
});

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: value,
	};
}

export default function cmuxObserverExtension(pi: ExtensionAPI) {
	let manager: ObserverManager | undefined;

	function requireManager(): ObserverManager {
		if (!manager) throw new Error("cmux observer is not initialized for this Pi session");
		return manager;
	}

	pi.registerTool({
		name: "cmux_observer_start",
		label: "Start cmux observer",
		description:
			"Start passive polling of an existing cmux terminal surface. The target remains interactive. Returns a session-scoped handle. from=now suppresses existing screen content; from=screen includes it. Repeated starts for the same target reuse the active observer.",
		promptSnippet: "Observe incremental output from an existing cmux terminal without repeated full-screen snapshots",
		promptGuidelines: [
			"Use cmux_observer_start, cmux_observer_read, and cmux_observer_wait instead of repeated cmux read-screen snapshots when monitoring an existing terminal.",
		],
		parameters: Type.Object({
			surface: Type.String({ minLength: 1, description: "Explicit cmux surface ref or UUID" }),
			workspace: Type.Optional(Type.String({ minLength: 1, description: "Optional cmux workspace ref or UUID" })),
			from: Type.Optional(StringEnum(["now", "screen"] as const, { description: "Initial observation point (default: now)" })),
		}),
		async execute(_toolCallId, params) {
			const from = (params.from ?? "now") as ObserverFrom;
			const result = await requireManager().start(params.surface, from, params.workspace);
			pi.appendEntry(STATE_ENTRY, { action: "start", ...result, surface: params.surface, workspace: params.workspace, from });
			return toolResult(result);
		},
	});

	pi.registerTool({
		name: "cmux_observer_read",
		label: "Read cmux observer",
		description: `Read only new normalized completed lines from an observer. The cursor is stored outside model context. Results are capped at ${HARD_MAX_LINES} lines and ${HARD_MAX_CHARS} characters; defaults are ${DEFAULT_MAX_LINES} lines and ${DEFAULT_MAX_CHARS} characters. gap=true means output may be missing.`,
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_LINES, description: `Default ${DEFAULT_MAX_LINES}` })),
			maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_CHARS, description: `Default ${DEFAULT_MAX_CHARS}` })),
		}),
		async execute(_toolCallId, params) {
			return toolResult(await requireManager().read(params.handle, params.maxLines, params.maxChars));
		},
	});

	pi.registerTool({
		name: "cmux_observer_wait",
		label: "Wait for cmux output",
		description:
			"Wait for a literal or regex trigger in unread completed terminal lines. Returns only the matching line, or a timeout/ended status. It does not consume the read cursor or inject unrelated observed output.",
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			triggers: Type.Array(triggerSchema, { minItems: 1, maxItems: 20 }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000, description: "Default 30000, maximum 120000" })),
		}),
		async execute(_toolCallId, params, signal) {
			return toolResult(
				await requireManager().wait(params.handle, params.triggers as Trigger[], params.timeoutMs ?? 30_000, signal),
			);
		},
	});

	pi.registerTool({
		name: "cmux_observer_stop",
		label: "Stop cmux observer",
		description: "Stop polling a cmux observer. Buffered unread lines remain available until this Pi session shuts down.",
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }) }),
		async execute(_toolCallId, params) {
			const result = await requireManager().stop(params.handle);
			pi.appendEntry(STATE_ENTRY, { action: "stop", ...result });
			return toolResult(result);
		},
	});

	pi.registerCommand("cmux-observers", {
		description: "List active and ended cmux observer handles",
		handler: async (_args, ctx) => {
			const observers = requireManager().list();
			if (observers.length === 0) {
				ctx.ui.notify("No cmux observers in this session", "info");
				return;
			}
			ctx.ui.notify(
				observers
					.map((observer) => `${observer.handle} ${observer.surface} ${observer.ended ? `ended (${observer.endReason})` : "active"}`)
					.join("\n"),
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		manager = new ObserverManager({ sessionId: ctx.sessionManager.getSessionId() });
		await manager.initialize();
	});

	pi.on("session_shutdown", async () => {
		const active = manager;
		manager = undefined;
		await active?.shutdown();
	});
}
