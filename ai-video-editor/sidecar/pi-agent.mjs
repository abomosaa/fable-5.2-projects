#!/usr/bin/env node
/**
 * Cutline Pi sidecar.
 *
 * Runs ONE assistant turn of the editing assistant with the Pi SDK
 * (@mariozechner/pi-agent-core + @mariozechner/pi-ai) and speaks JSON Lines
 * over stdin/stdout with the Rust server. Tool calls are never executed here:
 * every tool's `execute` round-trips to the server, which validates and runs
 * it. See README.md for the protocol.
 *
 * stdout carries protocol lines only. Diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import { Agent } from "@mariozechner/pi-agent-core";
import { clampThinkingLevel, getEnvApiKey, getModel, getModels, getProviders } from "@mariozechner/pi-ai";

// Nothing but protocol JSON may reach stdout, including from dependencies.
for (const method of ["log", "info", "debug"]) {
	console[method] = (...args) => console.error(...args);
}

const DEFAULT_PROVIDER = "anthropic";
/** Default model per provider. Must exist in pi-ai's model registry. */
const DEFAULT_MODELS = { anthropic: "claude-sonnet-4-6" };
const DEFAULT_MAX_TOOL_CALLS = 25;
/** Assistant rounds that may keep calling tools past the limit before the run is stopped. */
const MAX_OVER_LIMIT_ROUNDS = 3;
/** How long to wait for the SDK to settle after an abort before exiting anyway. */
const ABORT_GRACE_MS = 1500;

/** Which env vars carry credentials, per pi-ai provider (mirrors pi-ai's env-api-keys). */
const CREDENTIAL_HINTS = {
	anthropic: "ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN)",
	openai: "OPENAI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY (plus AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME)",
	google: "GEMINI_API_KEY",
	"google-vertex":
		"GOOGLE_CLOUD_API_KEY (or GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION with application default credentials)",
	"amazon-bedrock": "AWS_PROFILE (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK)",
	"github-copilot": "COPILOT_GITHUB_TOKEN (or GH_TOKEN / GITHUB_TOKEN)",
	deepseek: "DEEPSEEK_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	moonshotai: "MOONSHOT_API_KEY",
	"moonshotai-cn": "MOONSHOT_API_KEY",
	huggingface: "HF_TOKEN",
	fireworks: "FIREWORKS_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
	"cloudflare-workers-ai": "CLOUDFLARE_API_KEY (plus CLOUDFLARE_ACCOUNT_ID)",
	"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY (plus CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID)",
	xiaomi: "XIAOMI_API_KEY",
};

class SidecarError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// stdout / process lifecycle
// ---------------------------------------------------------------------------

let finished = false;

/** Replace any credential value from the environment that leaked into a message. */
function redact(text) {
	let out = String(text ?? "");
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < 8) continue;
		if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) continue;
		out = out.split(value).join("[redacted]");
	}
	return out;
}

function log(message) {
	process.stderr.write(`[pi-sidecar] ${redact(message)}\n`);
}

function emit(event) {
	// After an abort the only line still owed to the server is the final error.
	if (finished || aborted) return;
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Write the terminal protocol line, flush it, and exit. */
function finish(event, exitCode) {
	if (finished) return;
	finished = true;
	process.stdout.write(`${JSON.stringify(event)}\n`, () => process.exit(exitCode));
}

function fail(code, message) {
	finish({ type: "error", code, message: redact(message) }, 1);
}

process.stdout.on("error", () => process.exit(1)); // server went away (EPIPE)
process.on("uncaughtException", (error) => fail("provider_error", `Unexpected sidecar failure: ${error?.message ?? error}`));
process.on("unhandledRejection", (error) => fail("provider_error", `Unexpected sidecar failure: ${error?.message ?? error}`));

// ---------------------------------------------------------------------------
// stdin: start message, tool results, abort
// ---------------------------------------------------------------------------

/** toolCallId -> { resolve, reject } for tool calls awaiting the server's reply. */
const pendingToolCalls = new Map();
let agent = null;
let aborted = false;
let gotStart = false;
let resolveStart;
let rejectStart;
const startMessage = new Promise((resolve, reject) => {
	resolveStart = resolve;
	rejectStart = reject;
});

function requestAbort(reason) {
	if (finished || aborted) return;
	aborted = true;
	const message = `Turn aborted (${reason})`;
	for (const { reject } of pendingToolCalls.values()) reject(new Error(message));
	pendingToolCalls.clear();
	if (!gotStart) {
		rejectStart(new SidecarError("aborted", message));
		return;
	}
	if (!agent) {
		fail("aborted", message);
		return;
	}
	agent.abort();
	// run() reports the abort once the SDK settles; don't hang if it never does.
	setTimeout(() => fail("aborted", message), ABORT_GRACE_MS);
}

function handleLine(line) {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		if (!gotStart) {
			gotStart = true;
			rejectStart(new SidecarError("provider_error", "Invalid start message: first stdin line is not valid JSON"));
		} else {
			log("ignoring stdin line that is not valid JSON");
		}
		return;
	}
	if (message?.type === "abort") {
		requestAbort("abort requested");
		return;
	}
	if (!gotStart) {
		gotStart = true;
		if (message?.type === "start") resolveStart(message);
		else rejectStart(new SidecarError("provider_error", 'Invalid start message: expected {"type":"start",...} first'));
		return;
	}
	if (message?.type === "tool_result") {
		const waiter = pendingToolCalls.get(message.id);
		if (!waiter) {
			log(`ignoring tool_result for unknown tool call id ${JSON.stringify(message.id)}`);
			return;
		}
		pendingToolCalls.delete(message.id);
		waiter.resolve(message);
		return;
	}
	log(`ignoring unexpected message type ${JSON.stringify(message?.type)}`);
}

const stdin = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
stdin.on("line", handleLine);
stdin.on("close", () => requestAbort("stdin closed"));

// ---------------------------------------------------------------------------
// Start message -> model, tools, history
// ---------------------------------------------------------------------------

function nonEmpty(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function resolveModel(start) {
	const provider = nonEmpty(start.provider) ?? nonEmpty(process.env.PI_PROVIDER) ?? DEFAULT_PROVIDER;
	const modelId = nonEmpty(start.model) ?? nonEmpty(process.env.PI_MODEL) ?? DEFAULT_MODELS[provider];

	if (!getProviders().includes(provider)) {
		throw new SidecarError(
			"model_not_found",
			`Unknown provider "${provider}". Known providers: ${getProviders().join(", ")}`,
		);
	}
	if (!modelId) {
		throw new SidecarError(
			"model_not_found",
			`No default model for provider "${provider}"; set PI_MODEL (or pass "model" in the start message)`,
		);
	}
	const registered = getModel(provider, modelId);
	if (!registered) {
		const known = getModels(provider).map((m) => m.id);
		throw new SidecarError(
			"model_not_found",
			`Model "${modelId}" not found for provider "${provider}". Known models: ${known.join(", ")}`,
		);
	}
	if (!getEnvApiKey(provider)) {
		const hint = CREDENTIAL_HINTS[provider];
		throw new SidecarError(
			"not_configured",
			hint
				? `No credentials for provider "${provider}": set the ${hint} environment variable`
				: `No credentials for provider "${provider}": this provider has no API key environment variable (see the pi-ai documentation)`,
		);
	}

	const baseUrl = nonEmpty(process.env.PI_BASE_URL);
	return baseUrl ? { ...registered, baseUrl } : registered;
}

/**
 * Inline local `$ref`s (`#/$defs/...`, `#/definitions/...`). Providers only get
 * part of the schema (pi-ai sends Anthropic just `properties` + `required`), so
 * a reference to a top-level definition would otherwise dangle.
 */
function inlineLocalRefs(root) {
	const lookup = (ref) => {
		let node = root;
		for (const raw of ref.slice(2).split("/")) {
			const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
			if (node === null || typeof node !== "object" || !(key in node)) return undefined;
			node = node[key];
		}
		return node;
	};
	const walk = (node, stack) => {
		if (Array.isArray(node)) return node.map((item) => walk(item, stack));
		if (node === null || typeof node !== "object") return node;
		if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
			const { $ref, ...siblings } = node;
			const target = stack.includes($ref) ? undefined : lookup($ref);
			// Recursive or unresolvable reference: accept anything, the server validates.
			const resolved = target === undefined ? {} : walk(target, [...stack, $ref]);
			return { ...resolved, ...walk(siblings, stack) };
		}
		const out = {};
		for (const [key, value] of Object.entries(node)) {
			if (stack.length === 0 && node === root && (key === "$defs" || key === "definitions" || key === "$schema")) {
				continue;
			}
			out[key] = walk(value, stack);
		}
		return out;
	};
	return walk(root, []);
}

function toolResultText(content, fallback) {
	if (typeof content === "string") return content.trim() === "" ? fallback : content;
	if (content === undefined || content === null) return fallback;
	return JSON.stringify(content);
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function historyToMessages(history, model) {
	const messages = [];
	for (const entry of Array.isArray(history) ? history : []) {
		const text = typeof entry?.text === "string" ? entry.text : "";
		if (text.trim() === "") continue; // providers reject empty text blocks
		if (entry.role === "user") {
			messages.push({ role: "user", content: text, timestamp: Date.now() });
		} else if (entry.role === "assistant") {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			});
		} else {
			log(`ignoring history entry with unknown role ${JSON.stringify(entry?.role)}`);
		}
	}
	return messages;
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

async function run() {
	const start = await startMessage;

	if (typeof start.prompt !== "string" || start.prompt.trim() === "") {
		throw new SidecarError("provider_error", 'Invalid start message: "prompt" must be a non-empty string');
	}
	if (start.tools !== undefined && start.tools !== null && !Array.isArray(start.tools)) {
		throw new SidecarError("provider_error", 'Invalid start message: "tools" must be an array');
	}
	for (const spec of start.tools ?? []) {
		if (typeof spec?.name !== "string" || spec.name === "") {
			throw new SidecarError("provider_error", "Invalid start message: every tool needs a name");
		}
	}
	const maxToolCalls =
		Number.isFinite(start.max_tool_calls) && start.max_tool_calls >= 0
			? Math.floor(start.max_tool_calls)
			: DEFAULT_MAX_TOOL_CALLS;

	const model = resolveModel(start);
	emit({ type: "ready", provider: model.provider, model: model.id });

	// --- per-turn state -----------------------------------------------------
	/** Arguments exactly as the model produced them, keyed by tool call id. */
	const rawArguments = new Map();
	let attemptedToolCalls = 0; // every tool call the model made
	let forwardedToolCalls = 0; // tool calls sent to the server
	let overLimitThisRound = false;
	let overLimitRounds = 0;
	let limitStop = false;

	let turnText = "";
	let separatorPending = false;
	let streamedInMessage = 0;
	const usage = zeroUsage();
	let sawUsage = false;

	const pushText = (delta) => {
		if (!delta) return;
		let text = delta;
		if (separatorPending && turnText !== "" && !turnText.endsWith("\n\n")) {
			text = (turnText.endsWith("\n") ? "\n" : "\n\n") + text;
		}
		separatorPending = false;
		turnText += text;
		streamedInMessage += delta.length;
		emit({ type: "text_delta", text });
	};

	const limitMessage =
		`Tool call limit reached (${maxToolCalls} per turn). This call was NOT executed. ` +
		"Do not call any more tools. Reply to the user now with a summary of what was done and what remains.";

	// --- tools: execution round-trips to the server ---------------------------
	const tools = (start.tools ?? []).map((spec) => {
		const schema =
			spec.parameters && typeof spec.parameters === "object" && !Array.isArray(spec.parameters)
				? inlineLocalRefs(spec.parameters)
				: { type: "object", properties: {} };
		return {
			name: spec.name,
			label: spec.name,
			description: typeof spec.description === "string" ? spec.description : "",
			// Raw JSON Schema: pi-ai validates plain (non-TypeBox) schema objects as-is.
			parameters: schema,
			execute: async (toolCallId, params, signal) => {
				if (attemptedToolCalls > maxToolCalls) throw new Error(limitMessage);
				if (signal?.aborted || aborted) throw new Error("Turn aborted");
				forwardedToolCalls++;
				const reply = await new Promise((resolve, reject) => {
					pendingToolCalls.set(toolCallId, { resolve, reject });
					signal?.addEventListener("abort", () => reject(new Error("Turn aborted")), { once: true });
					emit({
						type: "tool_call",
						id: toolCallId,
						name: spec.name,
						// The SDK's validated copy is coerced ("3" -> 3, and null -> 0 for
						// nullable numbers). The server is the authority on arguments, so it
						// gets what the model actually wrote.
						arguments: rawArguments.get(toolCallId) ?? params ?? {},
					});
				});
				if (reply.ok !== true) {
					// Thrown errors become isError tool results the model can react to.
					throw new Error(toolResultText(reply.content, "Tool call failed"));
				}
				return { content: [{ type: "text", text: toolResultText(reply.content, "OK") }], details: {} };
			},
		};
	});

	const requestedThinking = nonEmpty(process.env.PI_THINKING) ?? "off";
	agent = new Agent({
		initialState: {
			systemPrompt: typeof start.system_prompt === "string" ? start.system_prompt : "",
			model,
			thinkingLevel: clampThinkingLevel(model, requestedThinking),
			tools,
			messages: historyToMessages(start.history, model),
		},
		// One outstanding tool_call at a time, in the order the model asked for them.
		toolExecution: "sequential",
	});

	agent.subscribe((event) => {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") streamedInMessage = 0;
				break;
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta") pushText(update.delta);
				else if (update.type === "text_end") separatorPending = true;
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant") break;
				if (streamedInMessage === 0) {
					// Provider delivered text without streaming deltas.
					for (const block of message.content) {
						if (block.type === "text" && block.text) {
							pushText(block.text);
							separatorPending = true;
						}
					}
				}
				separatorPending = true;
				if (message.usage) {
					sawUsage = true;
					for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
						usage[key] += message.usage[key] ?? 0;
					}
					usage.cost.total += message.usage.cost?.total ?? 0;
				}
				break;
			}
			case "tool_execution_start":
				// Counted here, before the SDK validates arguments, so calls it rejects
				// locally use up the budget too.
				attemptedToolCalls++;
				if (attemptedToolCalls > maxToolCalls) overLimitThisRound = true;
				rawArguments.set(event.toolCallId, event.args);
				break;
			case "tool_execution_end":
				rawArguments.delete(event.toolCallId);
				break;
			case "turn_end":
				if (overLimitThisRound) {
					overLimitThisRound = false;
					overLimitRounds++;
					if (overLimitRounds >= MAX_OVER_LIMIT_ROUNDS) {
						limitStop = true;
						agent.abort();
					}
				}
				break;
		}
	});

	if (aborted) throw new SidecarError("aborted", "Turn aborted");
	await agent.prompt(start.prompt);

	if (aborted) throw new SidecarError("aborted", "Turn aborted");
	if (limitStop) {
		throw new SidecarError(
			"provider_error",
			`Stopped: the model kept calling tools after the limit of ${maxToolCalls} tool calls per turn`,
		);
	}

	const last = agent.state.messages.findLast((message) => message.role === "assistant");
	if (!last) throw new SidecarError("provider_error", "The model returned no response");
	if (last.stopReason === "aborted") throw new SidecarError("aborted", "Turn aborted");
	if (last.stopReason === "error") {
		const message = last.errorMessage || "The provider request failed";
		const code = /^No API key\b/i.test(message) ? "not_configured" : "provider_error";
		throw new SidecarError(code, message);
	}

	finish(
		{
			type: "done",
			text: turnText,
			tool_calls: forwardedToolCalls,
			usage: sawUsage
				? {
						input: usage.input,
						output: usage.output,
						cache_read: usage.cacheRead,
						cache_write: usage.cacheWrite,
						total_tokens: usage.totalTokens,
						cost_usd: usage.cost.total,
					}
				: null,
		},
		0,
	);
}

run().catch((error) => {
	if (error instanceof SidecarError) fail(error.code, error.message);
	else fail(aborted ? "aborted" : "provider_error", error?.message ?? String(error));
});
