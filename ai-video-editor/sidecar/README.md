# cutline-pi-sidecar

`pi-agent.mjs` runs **one assistant turn** of the Cutline editing assistant using the
[Pi SDK](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`, pinned to 0.73.1).

The Rust server spawns it as a child process and talks JSON Lines over stdin/stdout.
The sidecar owns the model loop (streaming, tool-call turns, retries). It does **not** execute tools:
each tool call is sent to the server, which validates and runs it and replies with the result.

Requires Node 20+.

```bash
cd sidecar && npm ci
```

## Protocol

One JSON object per line, UTF-8. stdout carries protocol lines only; diagnostics go to stderr.

### Server → sidecar

First line:

```json
{"type":"start","system_prompt":"...","tools":[{"name":"...","description":"...","parameters":{/* JSON Schema */}}],
 "history":[{"role":"user"|"assistant","text":"..."}],"prompt":"...","provider":null,"model":null,"max_tool_calls":25}
```

Later lines:

- `{"type":"tool_result","id":"...","ok":true|false,"content":"..."}` — reply to a `tool_call`.
  With `ok:false`, `content` is shown to the model as a tool error so it can correct itself.
- `{"type":"abort"}` — cancel the turn. Closing stdin does the same.

### Sidecar → server

| Event | Meaning |
|---|---|
| `{"type":"ready","provider","model"}` | Model and credentials resolved; the model request is about to start. |
| `{"type":"text_delta","text"}` | Streamed assistant text. |
| `{"type":"tool_call","id","name","arguments"}` | The model wants a tool run. The sidecar waits for the matching `tool_result`. |
| `{"type":"done","text","tool_calls","usage"}` | Turn finished. Exit code 0. |
| `{"type":"error","code","message"}` | Turn failed. Exit code 1. |

Error codes: `not_configured` (no credentials for the provider; the message names the env var to set),
`model_not_found` (unknown provider or model id), `aborted`, and `provider_error` for everything else
(provider/network failures, a malformed start message, a model that ignores the tool limit).

Details worth knowing:

- **`done.text`** is all assistant text of the turn and always equals the concatenation of the `text_delta`
  events. When the model writes text, calls tools, then writes more, the parts are joined with a blank line
  (the separator is streamed as part of a `text_delta`).
- **`done.tool_calls`** counts the tool calls sent to the server.
- **`done.usage`** is summed over every model request in the turn:
  `{"input","output","cache_read","cache_write","total_tokens","cost_usd"}`, or `null`.
- **One `tool_call` at a time.** Tools run sequentially in the order the model asked for them, even when it
  requests several in one message.
- **Arguments are validated twice.** The Pi SDK checks them against the tool's JSON Schema first; if that
  fails, the model gets the SDK's validation error and no `tool_call` is emitted. Calls that pass are
  forwarded with the arguments exactly as the model wrote them (not the SDK's coerced copy), and the server
  has the final say.
- **`max_tool_calls`** counts every tool call the model makes, including ones the SDK rejected. Calls past the
  limit are not forwarded; the model gets a tool error telling it to stop and summarize. If it keeps calling
  tools for three more rounds, the turn ends with `provider_error`.
- **Tool schemas**: local `$ref`s (`#/$defs/...`, `#/definitions/...`) are inlined before use. Note that
  pi-ai's Anthropic provider sends only the schema's top-level `properties` and `required` to the API.
- `history` entries with empty text are dropped.

## Environment variables

| Variable | Purpose |
|---|---|
| `PI_PROVIDER` | Provider when the start message has `provider: null`. Default `anthropic`. |
| `PI_MODEL` | Model id when the start message has `model: null`. Default `claude-sonnet-4-6` for `anthropic`; other providers have no default and need a model id. |
| `PI_BASE_URL` | Overrides the model's API base URL (proxies, tests). |
| `PI_THINKING` | Reasoning level: `off` (default), `minimal`, `low`, `medium`, `high`, `xhigh`. Clamped to what the model supports. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN` | Credentials for `anthropic`. |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ... | Credentials for other providers, as resolved by pi-ai. |

Provider and model ids must exist in pi-ai's model registry. API keys are read from the environment by the
SDK; the sidecar never prints them.

## Tests

```bash
node --test sidecar/test/      # from the repository root
npm test                       # from sidecar/
```

The tests need no network and no secrets. They spawn the real sidecar with the real SDK and point
`PI_BASE_URL` at a local HTTP server that speaks the Anthropic Messages streaming format.
