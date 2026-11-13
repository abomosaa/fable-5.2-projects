/**
 * Protocol tests for pi-agent.mjs. No network, no secrets.
 *
 * The sidecar runs as a real child process with the real Pi SDK and its real
 * Anthropic provider. Only the HTTP endpoint is replaced: PI_BASE_URL points
 * the model at a local server that speaks the Anthropic Messages SSE format.
 *
 * Run with: node --test sidecar/test/
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SIDECAR = fileURLToPath(new URL("../pi-agent.mjs", import.meta.url));
const FAKE_KEY = "sk-test-not-a-real-key-0123456789";
const TIMEOUT = { timeout: 30_000 };

// ---------------------------------------------------------------------------
// Fake Anthropic Messages endpoint
// ---------------------------------------------------------------------------

/** Requests received, as { headers, body }. Reset per test. */
let requests = [];
/** (body, index) => { content: [...blocks], stop_reason } | { hang: true }. Set per test. */
let responder = null;
let server;
let baseUrl;

const text = (value) => ({ type: "text", text: value });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

function writeSse(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamMessage(res, body, reply) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	writeSse(res, "message_start", {
		type: "message_start",
		message: {
			id: `msg_test_${requests.length}`,
			type: "message",
			role: "assistant",
			model: body.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 1 },
		},
	});
	reply.content.forEach((block, index) => {
		if (block.type === "text") {
			writeSse(res, "content_block_start", { type: "content_block_start", index, content_block: text("") });
			// Two deltas per block so streaming is observable.
			const middle = Math.ceil(block.text.length / 2);
			for (const piece of [block.text.slice(0, middle), block.text.slice(middle)]) {
				if (piece === "") continue;
				writeSse(res, "content_block_delta", {
					type: "content_block_delta",
					index,
					delta: { type: "text_delta", text: piece },
				});
			}
		} else {
			writeSse(res, "content_block_start", {
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
			});
			writeSse(res, "content_block_delta", {
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
			});
		}
		writeSse(res, "content_block_stop", { type: "content_block_stop", index });
	});
	writeSse(res, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: reply.stop_reason, stop_sequence: null },
		usage: { output_tokens: 5 },
	});
	writeSse(res, "message_stop", { type: "message_stop" });
	res.end();
}

before(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
				res.writeHead(404).end();
				return;
			}
			const body = JSON.parse(raw);
			requests.push({ headers: req.headers, body });
			const reply = responder(body, requests.length - 1);
			if (reply.hang) return; // never answer; the test aborts the turn
			streamMessage(res, body, reply);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
	server.closeAllConnections();
	server.close();
});

/** The tool_result blocks the "model" was shown in the last user message of a request. */
function toolResultsIn(body) {
	const last = body.messages.at(-1);
	return Array.isArray(last.content) ? last.content.filter((block) => block.type === "tool_result") : [];
}

// ---------------------------------------------------------------------------
// Sidecar driver (plays the Rust server's side of the protocol)
// ---------------------------------------------------------------------------

class Sidecar {
	constructor(env = {}) {
		// Deliberately not inheriting the environment: no real keys, no proxies.
		this.child = spawn(process.execPath, [SIDECAR], {
			env: { PATH: process.env.PATH, PI_BASE_URL: baseUrl, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.events = [];
		this.rawStdout = "";
		this.stderr = "";
		this.waiters = [];
		this.cursor = 0;
		this.child.stdout.on("data", (chunk) => {
			this.rawStdout += chunk;
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});
		this.child.stdin.on("error", () => {}); // child may exit before we finish writing
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			// Every stdout line must be a protocol JSON object.
			const event = JSON.parse(line);
			assert.equal(typeof event.type, "string", `stdout line without a type: ${line}`);
			this.events.push(event);
			this.pump();
		});
		this.exit = new Promise((resolve) => {
			this.child.on("close", (code) => {
				this.closed = true;
				this.pump();
				resolve(code);
			});
		});
	}

	send(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	start(overrides = {}) {
		this.send({
			type: "start",
			system_prompt: "You are the Cutline editing assistant.",
			tools: [TRIM_TOOL],
			history: [],
			prompt: "Trim the intro clip to two seconds.",
			provider: null,
			model: null,
			max_tool_calls: 8,
			...overrides,
		});
	}

	pump() {
		while (this.waiters.length > 0) {
			const waiter = this.waiters[0];
			const index = this.events.findIndex((event, i) => i >= this.cursor && event.type === waiter.type);
			if (index === -1) {
				if (!this.closed) return;
				this.waiters.shift();
				waiter.reject(
					new Error(
						`sidecar exited before "${waiter.type}". events=${JSON.stringify(this.events)} stderr=${this.stderr}`,
					),
				);
				continue;
			}
			this.cursor = index + 1;
			this.waiters.shift();
			waiter.resolve(this.events[index]);
		}
	}

	/** Next event of the given type after the previously awaited one. */
	next(type) {
		return new Promise((resolve, reject) => {
			this.waiters.push({ type, resolve, reject });
			this.pump();
		});
	}

	kill() {
		this.child.kill("SIGKILL");
	}

	streamedText() {
		return this.events
			.filter((event) => event.type === "text_delta")
			.map((event) => event.text)
			.join("");
	}
}

const TRIM_TOOL = {
	name: "trim_clip",
	description: "Trim a clip on the timeline to a new duration.",
	parameters: {
		type: "object",
		properties: {
			clip_id: { type: "string", description: "Clip to trim" },
			duration: { $ref: "#/$defs/seconds" },
			fade_out: { anyOf: [{ type: "number" }, { type: "null" }] },
		},
		required: ["clip_id", "duration"],
		additionalProperties: false,
		$defs: { seconds: { type: "number", minimum: 0, description: "Seconds" } },
	},
};

async function withSidecar(env, fn) {
	const sidecar = new Sidecar(env);
	try {
		return await fn(sidecar);
	} finally {
		sidecar.kill();
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("tool call round trip: model calls a tool, server replies, model finishes with text", TIMEOUT, async () => {
	requests = [];
	responder = (body, index) =>
		index === 0
			? {
					content: [
						text("Let me trim that clip."),
						toolUse("toolu_test_1", "trim_clip", { clip_id: "intro", duration: 2, fade_out: null }),
					],
					stop_reason: "tool_use",
				}
			: { content: [text("Done. The intro clip is now 2 seconds long.")], stop_reason: "end_turn" };

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start({
			history: [
				{ role: "user", text: "What is on the timeline?" },
				{ role: "assistant", text: "One clip named intro, 5 seconds long." },
			],
		});

		const ready = await sidecar.next("ready");
		assert.deepEqual(ready, { type: "ready", provider: "anthropic", model: "claude-sonnet-4-6" });

		const call = await sidecar.next("tool_call");
		// Arguments reach the server exactly as the model wrote them (null stays null).
		assert.deepEqual(call, {
			type: "tool_call",
			id: "toolu_test_1",
			name: "trim_clip",
			arguments: { clip_id: "intro", duration: 2, fade_out: null },
		});
		// The sidecar waits for the server: no second model request yet, and no done.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(requests.length, 1);
		assert.equal(sidecar.events.at(-1).type, "tool_call");

		sidecar.send({ type: "tool_result", id: call.id, ok: true, content: '{"clip_id":"intro","duration":2}' });

		const done = await sidecar.next("done");
		assert.equal(done.text, "Let me trim that clip.\n\nDone. The intro clip is now 2 seconds long.");
		assert.equal(done.tool_calls, 1);
		assert.deepEqual(done.usage, {
			input: 20,
			output: 10,
			cache_read: 0,
			cache_write: 0,
			total_tokens: 30,
			cost_usd: done.usage.cost_usd,
		});
		assert.ok(done.usage.cost_usd > 0);
		assert.equal(await sidecar.exit, 0);

		// Streamed deltas add up to the final text, and text really was streamed in pieces.
		assert.equal(sidecar.streamedText(), done.text);
		assert.ok(sidecar.events.filter((event) => event.type === "text_delta").length >= 4);
		assert.deepEqual(
			[...new Set(sidecar.events.map((event) => event.type))],
			["ready", "text_delta", "tool_call", "done"],
		);

		// What the model was sent on the first request.
		const first = requests[0].body;
		assert.equal(first.model, "claude-sonnet-4-6");
		assert.equal(first.stream, true);
		assert.match(JSON.stringify(first.system), /Cutline editing assistant/);
		assert.deepEqual(
			first.messages.map((message) => message.role),
			["user", "assistant", "user"],
		);
		assert.match(JSON.stringify(first.messages[0]), /What is on the timeline\?/);
		assert.match(JSON.stringify(first.messages[1]), /One clip named intro/);
		assert.match(JSON.stringify(first.messages[2]), /Trim the intro clip to two seconds\./);
		assert.equal(first.tools.length, 1);
		assert.equal(first.tools[0].name, "trim_clip");
		assert.equal(first.tools[0].description, TRIM_TOOL.description);
		assert.deepEqual(first.tools[0].input_schema.required, ["clip_id", "duration"]);
		// The local $ref was inlined, so the schema the provider gets is self-contained.
		assert.deepEqual(first.tools[0].input_schema.properties.duration, {
			type: "number",
			minimum: 0,
			description: "Seconds",
		});
		assert.equal(requests[0].headers["x-api-key"], FAKE_KEY);

		// The server's tool result was handed back to the model.
		const results = toolResultsIn(requests[1].body);
		assert.equal(results.length, 1);
		assert.equal(results[0].tool_use_id, "toolu_test_1");
		assert.equal(results[0].content, '{"clip_id":"intro","duration":2}');
		assert.equal(results[0].is_error, false);

		// The key never shows up on stdout or stderr.
		assert.ok(!sidecar.rawStdout.includes(FAKE_KEY));
		assert.ok(!sidecar.stderr.includes(FAKE_KEY));
	});
});

test("tool errors from the server reach the model so it can correct its arguments", TIMEOUT, async () => {
	requests = [];
	responder = (body, index) => {
		if (index === 0) {
			return {
				content: [toolUse("toolu_bad", "trim_clip", { clip_id: "nope", duration: 2 })],
				stop_reason: "tool_use",
			};
		}
		if (index === 1) {
			return {
				content: [toolUse("toolu_good", "trim_clip", { clip_id: "intro", duration: 2 })],
				stop_reason: "tool_use",
			};
		}
		return { content: [text("Trimmed.")], stop_reason: "end_turn" };
	};

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start();
		const bad = await sidecar.next("tool_call");
		assert.equal(bad.id, "toolu_bad");
		sidecar.send({ type: "tool_result", id: bad.id, ok: false, content: 'unknown clip_id "nope"; valid ids: intro' });

		const good = await sidecar.next("tool_call");
		assert.equal(good.id, "toolu_good");
		sidecar.send({ type: "tool_result", id: good.id, ok: true, content: "ok" });

		const done = await sidecar.next("done");
		assert.equal(done.text, "Trimmed.");
		assert.equal(done.tool_calls, 2);
		assert.equal(await sidecar.exit, 0);

		const [failed] = toolResultsIn(requests[1].body);
		assert.equal(failed.tool_use_id, "toolu_bad");
		assert.equal(failed.is_error, true);
		assert.equal(failed.content, 'unknown clip_id "nope"; valid ids: intro');
	});
});

test("arguments the SDK rejects are reported to the model as a tool error, not sent to the server", TIMEOUT, async () => {
	requests = [];
	responder = (body, index) =>
		index === 0
			? { content: [toolUse("toolu_invalid", "trim_clip", { clip_id: "intro" })], stop_reason: "tool_use" }
			: { content: [text("I need a duration.")], stop_reason: "end_turn" };

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start();
		const done = await sidecar.next("done");
		assert.equal(done.tool_calls, 0);
		assert.equal(sidecar.events.filter((event) => event.type === "tool_call").length, 0);
		assert.equal(await sidecar.exit, 0);

		const [rejected] = toolResultsIn(requests[1].body);
		assert.equal(rejected.is_error, true);
		assert.match(rejected.content, /Validation failed for tool "trim_clip"/);
		assert.match(rejected.content, /duration/);
	});
});

test("max_tool_calls: calls past the limit get a tool error instead of reaching the server", TIMEOUT, async () => {
	requests = [];
	responder = (body, index) =>
		index < 2
			? {
					content: [toolUse(`toolu_${index}`, "trim_clip", { clip_id: "intro", duration: index + 1 })],
					stop_reason: "tool_use",
				}
			: { content: [text("Stopping here.")], stop_reason: "end_turn" };

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start({ max_tool_calls: 1 });
		const call = await sidecar.next("tool_call");
		assert.equal(call.id, "toolu_0");
		sidecar.send({ type: "tool_result", id: call.id, ok: true, content: "ok" });

		const done = await sidecar.next("done");
		assert.equal(done.tool_calls, 1);
		assert.equal(done.text, "Stopping here.");
		assert.equal(sidecar.events.filter((event) => event.type === "tool_call").length, 1);
		assert.equal(await sidecar.exit, 0);

		const [refused] = toolResultsIn(requests[2].body);
		assert.equal(refused.tool_use_id, "toolu_1");
		assert.equal(refused.is_error, true);
		assert.match(refused.content, /Tool call limit reached \(1 per turn\)/);
		assert.match(refused.content, /summary/);
	});
});

test("max_tool_calls: a model that ignores the limit is stopped", TIMEOUT, async () => {
	requests = [];
	responder = (body, index) => ({
		content: [toolUse(`toolu_${index}`, "trim_clip", { clip_id: "intro", duration: 2 })],
		stop_reason: "tool_use",
	});

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start({ max_tool_calls: 0 });
		const error = await sidecar.next("error");
		assert.equal(error.code, "provider_error");
		assert.match(error.message, /limit of 0 tool calls/);
		assert.notEqual(await sidecar.exit, 0);
		assert.equal(sidecar.events.filter((event) => event.type === "tool_call").length, 0);
		// Three refused rounds, then no further model requests.
		assert.equal(requests.length, 3);
	});
});

test("not_configured: no API key for the provider", TIMEOUT, async () => {
	requests = [];
	responder = () => {
		throw new Error("the model must not be called without credentials");
	};

	await withSidecar({}, async (sidecar) => {
		sidecar.start();
		const error = await sidecar.next("error");
		assert.equal(error.code, "not_configured");
		assert.match(error.message, /ANTHROPIC_API_KEY/);
		assert.match(error.message, /anthropic/);
		assert.notEqual(await sidecar.exit, 0);
		assert.deepEqual(
			sidecar.events.map((event) => event.type),
			["error"],
		);
		assert.equal(requests.length, 0);
	});
});

test("not_configured names the env var of the chosen provider", TIMEOUT, async () => {
	requests = [];
	// A key for a different provider does not count.
	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY, PI_PROVIDER: "openai", PI_MODEL: "gpt-4o" }, async (sidecar) => {
		sidecar.start();
		const error = await sidecar.next("error");
		assert.equal(error.code, "not_configured");
		assert.match(error.message, /OPENAI_API_KEY/);
		assert.notEqual(await sidecar.exit, 0);
		assert.equal(requests.length, 0);
	});
});

test("model_not_found: unknown model id, and start message overrides PI_MODEL", TIMEOUT, async () => {
	requests = [];
	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY, PI_MODEL: "claude-sonnet-4-6" }, async (sidecar) => {
		sidecar.start({ model: "claude-does-not-exist" });
		const error = await sidecar.next("error");
		assert.equal(error.code, "model_not_found");
		assert.match(error.message, /claude-does-not-exist/);
		assert.notEqual(await sidecar.exit, 0);
		assert.equal(requests.length, 0);
	});
});

test("PI_MODEL selects the model when the start message leaves it null", TIMEOUT, async () => {
	requests = [];
	responder = () => ({ content: [text("Hi.")], stop_reason: "end_turn" });
	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY, PI_MODEL: "claude-haiku-4-5" }, async (sidecar) => {
		sidecar.start({ tools: [] });
		assert.deepEqual(await sidecar.next("ready"), { type: "ready", provider: "anthropic", model: "claude-haiku-4-5" });
		const done = await sidecar.next("done");
		assert.equal(done.text, "Hi.");
		assert.equal(done.tool_calls, 0);
		assert.equal(await sidecar.exit, 0);
		assert.equal(requests[0].body.model, "claude-haiku-4-5");
	});
});

test("abort while waiting for a tool result", TIMEOUT, async () => {
	requests = [];
	responder = () => ({
		content: [toolUse("toolu_abort", "trim_clip", { clip_id: "intro", duration: 2 })],
		stop_reason: "tool_use",
	});

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start();
		await sidecar.next("tool_call");
		sidecar.send({ type: "abort" });
		const error = await sidecar.next("error");
		assert.equal(error.code, "aborted");
		assert.notEqual(await sidecar.exit, 0);
		assert.equal(sidecar.events.at(-1).type, "error");
		assert.equal(sidecar.events.filter((event) => event.type === "done").length, 0);
		// The aborted turn did not go back to the model.
		assert.equal(requests.length, 1);
	});
});

test("abort while the model request is in flight", TIMEOUT, async () => {
	requests = [];
	responder = () => ({ hang: true });

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start();
		await sidecar.next("ready");
		while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
		sidecar.send({ type: "abort" });
		const error = await sidecar.next("error");
		assert.equal(error.code, "aborted");
		assert.notEqual(await sidecar.exit, 0);
	});
});

test("stdin EOF is treated as abort", TIMEOUT, async () => {
	requests = [];
	responder = () => ({
		content: [toolUse("toolu_eof", "trim_clip", { clip_id: "intro", duration: 2 })],
		stop_reason: "tool_use",
	});

	await withSidecar({ ANTHROPIC_API_KEY: FAKE_KEY }, async (sidecar) => {
		sidecar.start();
		await sidecar.next("tool_call");
		sidecar.child.stdin.end();
		const error = await sidecar.next("error");
		assert.equal(error.code, "aborted");
		assert.notEqual(await sidecar.exit, 0);
	});
});

test("provider failures surface as provider_error", TIMEOUT, async () => {
	requests = [];
	await withSidecar(
		// Nothing listens on port 9 (discard); the connection is refused immediately.
		{ ANTHROPIC_API_KEY: FAKE_KEY, PI_BASE_URL: "http://127.0.0.1:9" },
		async (sidecar) => {
			sidecar.start();
			await sidecar.next("ready");
			const error = await sidecar.next("error");
			assert.equal(error.code, "provider_error");
			assert.equal(typeof error.message, "string");
			assert.ok(error.message.length > 0);
			assert.notEqual(await sidecar.exit, 0);
			assert.ok(!sidecar.rawStdout.includes(FAKE_KEY));
		},
	);
});
