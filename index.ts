import { StringEnum } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_MAX_CHARS,
	DEFAULT_MAX_LINES,
	HARD_MAX_CHARS,
	HARD_MAX_LINES,
	ObserverManager,
	createRuntimeReadScreen,
	isPaseoAgentRuntime,
	renderObserverRead,
	type ObserverFrom,
	type ObserverReadMode,
	type ObserverReadResult,
	type Trigger,
} from "./observer.ts";
import {
	askObserver,
	DEFAULT_WATCH_TIMEOUT_MS,
	MAX_WATCH_TIMEOUT_MS,
	SemanticWatchManager,
	type SemanticComplete,
} from "./semantic.ts";

const STATE_ENTRY = "terminal-observer-state";

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

export function readToolResult(result: ObserverReadResult, mode: ObserverReadMode = "compact") {
	const rendered = renderObserverRead(result, mode);
	return {
		content: [{ type: "text" as const, text: rendered.text }],
		details: {
			...result,
			mode: rendered.mode,
			renderedLineCount: rendered.renderedLineCount,
			omittedLineCount: rendered.omittedLineCount,
		},
	};
}

export function selectLunaModel<T extends { provider: string; id: string }>(models: T[]): T | undefined {
	const priority = [
		["cloudflare-ai-gateway", "gpt-5.6-luna"],
		["openai", "gpt-5.6-luna"],
		["azure-openai-responses", "gpt-5.6-luna"],
	] as const;
	return priority.map(([provider, id]) => models.find((model) => model.provider === provider && model.id === id)).find((model): model is T => model !== undefined);
}

export function createExtensionWatchManager(pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">, manager: ObserverManager, semanticComplete: SemanticComplete) {
	const wake = (message: string, watch: { id: string; status: string }) => {
		pi.sendMessage({ customType: "terminal-observer-watch", content: message, display: true, details: { id: watch.id, status: watch.status } }, { triggerTurn: true, deliverAs: "followUp" });
	};
	return new SemanticWatchManager({
		manager,
		complete: semanticComplete,
		onMatch: wake,
		onOutcome: wake,
		onUsage(watchId, completion) {
			pi.appendEntry(STATE_ENTRY, { action: "watch-usage", watchId, model: completion.model, usage: completion.usage });
		},
	});
}

export default function terminalObserverExtension(pi: ExtensionAPI) {
	let manager: ObserverManager | undefined;
	let watches: SemanticWatchManager | undefined;
	let sessionContext: ExtensionContext | undefined;

	const semanticComplete: SemanticComplete = async (prompt, signal) => {
		const ctx = sessionContext;
		if (!ctx) throw new Error("terminal observer semantic model is not initialized");
		const model = selectLunaModel(ctx.modelRegistry.getAvailable());
		if (!model) throw new Error("No authenticated allowlisted Luna model is available (cloudflare-ai-gateway, openai, or azure-openai-responses gpt-5.6-luna)");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(`Luna authentication unavailable: ${auth.error}`);
		const response = await complete(model, {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
			maxTokens: 800,
			reasoningEffort: "low",
		});
		if (response.stopReason === "aborted") throw new Error("Luna request aborted");
		if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Luna request failed");
		return {
			text: response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n"),
			usage: response.usage,
			model: `${model.provider}/${model.id}`,
		};
	};

	function requireManager(): ObserverManager {
		if (!manager) throw new Error("terminal observer is not initialized for this Pi session");
		return manager;
	}

	function requireWatches(): SemanticWatchManager {
		if (!watches) throw new Error("terminal observer watches are not initialized");
		return watches;
	}

	pi.registerTool({
		name: "terminal_observer_start",
		label: "Start terminal observer",
		description:
			"Start passive polling of an existing shared terminal surface: a cmux terminal surface, or a Paseo managed terminal when PASEO_AGENT_ID is nonblank. The human and agent can continue using the target interactively. The observer does not create the terminal, launch commands inside it, send input, change focus, or take ownership. Returns a session-scoped handle. from=now suppresses existing screen content; from=screen includes it. Repeated starts for the same target reuse the active observer.",
		promptSnippet: "Passively observe incremental output from an existing shared cmux or Paseo terminal surface", 
		promptGuidelines: [
			"Use terminal_observer_start, terminal_observer_read, and terminal_observer_wait instead of repeated terminal snapshots when monitoring an existing terminal.",
		],
		parameters: Type.Object({
			surface: Type.String({ minLength: 1, description: "cmux surface ref/UUID, or Paseo terminal ID" }),
			workspace: Type.Optional(Type.String({ minLength: 1, description: "Optional cmux workspace ref/UUID; ignored for Paseo terminals" })),
			from: Type.Optional(StringEnum(["now", "screen"] as const, { description: "Initial observation point (default: now)" })),
		}),
		async execute(_toolCallId, params) {
			const from = (params.from ?? "now") as ObserverFrom;
			const workspace = isPaseoAgentRuntime() ? undefined : params.workspace;
			const result = await requireManager().start(params.surface, from, workspace);
			pi.appendEntry(STATE_ENTRY, { action: "start", ...result, surface: params.surface, workspace, from });
			return toolResult(result);
		},
	});

	pi.registerTool({
		name: "terminal_observer_read",
		label: "Read terminal observer",
		description: `Read only new normalized completed lines from an observer as plain text with a concise status header. mode=compact (default) removes terminal control noise and conservatively shortens repeated, same-signature progress, and large package-list output. mode=raw preserves stored line text exactly. Reads consume the cursor, so select raw on the read where exact output is needed. The cursor is stored outside model context. Results are capped at ${HARD_MAX_LINES} lines and ${HARD_MAX_CHARS} characters; defaults are ${DEFAULT_MAX_LINES} lines and ${DEFAULT_MAX_CHARS} characters. gap=yes means output may be missing.`,
		promptGuidelines: ["Prefer ask for current semantic status, watch for future semantic conditions, wait for exact literal/regex triggers, and read for broader evidence or exact/raw output."],
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			mode: Type.Optional(StringEnum(["compact", "raw"] as const, { description: "Output rendering mode (default: compact); choose raw on this consuming read to preserve exact stored line text" })),
			maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_LINES, description: `Default ${DEFAULT_MAX_LINES}` })),
			maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_CHARS, description: `Default ${DEFAULT_MAX_CHARS}` })),
		}),
		async execute(_toolCallId, params) {
			const result = await requireManager().read(params.handle, params.maxLines, params.maxChars);
			return readToolResult(result, (params.mode ?? "compact") as ObserverReadMode);
		},
	});

	pi.registerTool({
		name: "terminal_observer_ask",
		label: "Ask about terminal output",
		description: "Ask a concise natural-language question about bounded recent compact terminal evidence using Luna at low thinking. Does not consume the ordinary read cursor. Prefer this for understanding status; use watch for future semantic conditions, wait for exact literals/regex, and read for broader or exact/raw evidence.",
		promptSnippet: "Ask concise questions about recent terminal status without consuming the read cursor",
		promptGuidelines: ["Use ask for understanding current status, watch for future semantic conditions, wait for exact literal/regex triggers, and read for broader evidence or exact/raw output."],
		parameters: Type.Object({
			handle: Type.String({ minLength: 1 }),
			question: Type.String({ minLength: 1, maxLength: 2_000 }),
			maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 80, description: "Recent evidence lines, default 80" })),
			maxChars: Type.Optional(Type.Integer({ minimum: 200, maximum: 8_000, description: "Recent evidence characters, default 8000" })),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await askObserver(requireManager(), semanticComplete, params.handle, params.question, signal, params.maxLines, params.maxChars);
			return { ...toolResult(result), usage: result.usage };
		},
	});

	pi.registerTool({
		name: "terminal_observer_watch",
		label: "Watch semantic terminal condition",
		description: "Start, list, or cancel background semantic watches. Start returns immediately and evaluates only newly observed output with an independent cursor. A high-confidence, directly grounded and confirmed match wakes the agent via a terminal-free follow-up message. Watches explicitly retain matched, timed-out, cancelled, ended, or error status until session shutdown. Default timeout is 30 minutes, maximum 24 hours.",
		promptSnippet: "Watch newly observed terminal output for a natural-language condition in the background",
		promptGuidelines: ["Use watch for future semantic conditions; use ask for current status, wait for exact literal/regex triggers, and read for broader evidence or exact/raw output."],
		parameters: Type.Object({
			action: StringEnum(["start", "list", "cancel"] as const),
			handle: Type.Optional(Type.String({ minLength: 1, description: "Required for start" })),
			condition: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: "Natural-language condition required for start" })),
			context: Type.Optional(Type.String({ maxLength: 2_000, description: "Optional trusted explanatory context for start" })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_WATCH_TIMEOUT_MS, description: `Default ${DEFAULT_WATCH_TIMEOUT_MS}` })),
			watchId: Type.Optional(Type.String({ minLength: 1, description: "Required for cancel; optional exact-ID filter for list" })),
			status: Type.Optional(StringEnum(["active", "matched", "timed-out", "cancelled", "ended", "error"] as const, { description: "Optional list filter" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Maximum list entries, default 25" })),
		}),
		async execute(_toolCallId, params) {
			const activeWatches = requireWatches();
			if (params.action === "list") return toolResult(activeWatches.listForTool({ watchId: params.watchId, status: params.status, limit: params.limit }));
			if (params.action === "cancel") {
				if (!params.watchId) throw new Error("watchId is required for cancel");
				return toolResult(activeWatches.cancel(params.watchId));
			}
			if (!params.handle || !params.condition) throw new Error("handle and condition are required for start");
			return toolResult(activeWatches.start(params.handle, params.condition, params.context, params.timeoutMs));
		},
	});

	pi.registerTool({
		name: "terminal_observer_wait",
		label: "Wait for terminal output",
		description:
			"Wait for a literal or regex trigger in unread completed terminal lines. Returns only the matching line, or a timeout/ended status. It does not consume the read cursor or inject unrelated observed output.",
		promptGuidelines: ["Use wait for exact literal/regex triggers; use ask for current semantic status, watch for future semantic conditions, and read for broader evidence or exact/raw output."],
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
		name: "terminal_observer_stop",
		label: "Stop terminal observer",
		description: "Stop polling a terminal observer. Buffered unread lines remain available until this Pi session shuts down.",
		parameters: Type.Object({ handle: Type.String({ minLength: 1 }) }),
		async execute(_toolCallId, params) {
			const result = await requireManager().stop(params.handle);
			pi.appendEntry(STATE_ENTRY, { action: "stop", ...result });
			return toolResult(result);
		},
	});

	pi.registerCommand("terminal-observers", {
		description: "List active and ended terminal observer handles",
		handler: async (_args, ctx) => {
			const observers = requireManager().list();
			if (observers.length === 0) {
				ctx.ui.notify("No terminal observers in this session", "info");
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
		sessionContext = ctx;
		manager = new ObserverManager({
			sessionId: ctx.sessionManager.getSessionId(),
			readScreen: createRuntimeReadScreen(),
		});
		await manager.initialize();
		watches = createExtensionWatchManager(pi, manager, semanticComplete);
	});

	pi.on("session_shutdown", async () => {
		const active = manager;
		watches?.shutdown();
		watches = undefined;
		manager = undefined;
		sessionContext = undefined;
		await active?.shutdown();
	});
}
