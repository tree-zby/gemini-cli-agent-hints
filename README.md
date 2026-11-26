# gemini-cli-agent-hints

[Agent Hint protocol](https://github.com/tree-zby/agent-hint-research) (`X-Agent-Hint`, v1.0) sender for
[Gemini CLI](https://github.com/google-gemini/gemini-cli).

Every model request gets one extra HTTP header, so a hint-aware inference
gateway can tell **which conversation a call belongs to**, where it sits in the
session's lifecycle, how urgent it is, and how much of the prefix is still
cacheable. The request body is never touched.

```
POST /v1beta/models/gemini-2.5-flash:streamGenerateContent
X-Agent-Hint: eyJzZXNzaW9uIjp7InNlc3Npb25faWQiOiJhaC0...
```

The sender runs inside Gemini CLI's native `BeforeModel` hook — no fork, no
wrapper. One small patch is still needed: the hook output type has no field for
outbound headers, and the hook translator drops everything except generation
parameters. The patch adds that field (71 lines added, 0 removed).

## What it sends

| Block | Content |
|---|---|
| `session` | `session_id`, `call_index`, `epoch`, `state` (`start` / `append`) |
| `priority_control` | 3 + `user_waiting` while the user waits; 1 + `critical_path` during a tool loop |
| `cache_control` | `ephemeral`, `ttl_s` inside 60–3600, `msg_offset` = **wire** `contents` length |
| `context_management` | only on manage requests: `manage_request: true` + one explicit `edits[]` |

Lifecycle verbs (`pause` / `resume` / `stop` / `compact`) are **separate HTTP
requests** with a placeholder body — never flags on a normal call.

## Install

The hook is a normal Node package. From a checkout:

```bash
git clone https://github.com/tree-zby/gemini-cli-agent-hints
cd gemini-cli-agent-hints
npm install && npm run build
```

### 1. Patch Gemini CLI

Gemini CLI has no outbound-header hook and its `BeforeModel` output cannot
express one, so apply the shipped patch:

```bash
git clone https://github.com/google-gemini/gemini-cli
cd gemini-cli
git checkout 60f8082
git apply /path/to/gemini-cli-agent-hints/patches/0001-before-model-http-headers.patch
npm install
npm run build --workspaces --if-present
```

The patch does four things:

| File | Change |
|---|---|
| `hooks/types.ts` | `BeforeModel` output gains `http_headers`; `HookInput` gains `before_model_meta` |
| `hooks/hookEventHandler.ts` | fills `before_model_meta` from the real `contents` array |
| `hooks/hookSystem.ts` | passes the headers through `BeforeModelHookResult` |
| `core/geminiChat.ts` | merges them into `config.httpOptions.headers` before the SDK call |

### 2. Register the hook

`~/.gemini/settings.json` (or a project `.gemini/settings.json`):

```json
{
  "hooks": {
    "BeforeModel": [
      {
        "hooks": [
          {
            "type": "command",
            "name": "agent-hints",
            "command": "node /path/to/gemini-cli-agent-hints/dist/cli.js hook",
            "timeout": 20000
          }
        ]
      }
    ]
  }
}
```

`hooks/before-model.mjs` is an equivalent two-line shim if you prefer a stable
path inside the package.

## Why the patch also carries `before_model_meta`

`toHookLLMRequest()` projects the request to **text only**: every
`functionCall` / `functionResponse` part is dropped. A hook that reads only
`llm_request.messages` therefore cannot count wire messages, and cannot tell a
tool continuation from a fresh turn.

Two numbers fix both problems:

```json
"before_model_meta": { "wire_message_count": 7, "has_tool_parts": true }
```

- `msg_offset` is written from `wire_message_count` (protocol V-02: the offset
  counts wire messages, not visible text).
- `has_tool_parts` forces `priority_control.level = 1` on tool loops instead of
  pretending the user is waiting.

## Manage requests

```bash
gemini-agent-hints manage pause       # offload the session
gemini-agent-hints manage resume      # prefetch it again
gemini-agent-hints manage compact     # evict after a history rewrite
gemini-agent-hints manage stop        # release pins and cache
```

`--all` targets every stored session, `--key <k>` one session, `--dry-run`
prints the hint without sending it. A manage request is
`POST <base>/v1beta/models/<model>:generateContent` with the hint header and a
single `.` placeholder part (the Gemini API rejects empty `contents`).

Authentication reuses what the host already has:

| Credential | Used as |
|---|---|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `x-goog-api-key` |
| `GEMINI_AGENT_HINTS_BEARER` | `Authorization: Bearer …` (Vertex, Code Assist proxies) |

With neither, the verb **degrades to L1**: the hint is printed and the command
reports `degraded: true`, instead of failing a lifecycle action.

## Configuration

| Variable | Meaning |
|---|---|
| `GEMINI_AGENT_HINTS` | `off` / `0` disables the hook entirely |
| `GEMINI_AGENT_HINTS_DIR` | state directory, default `~/.gemini/agent-hints` |
| `GEMINI_AGENT_HINTS_PRIORITY` | `omit`, or pin `0` / `1` / `2` / `3` |
| `GEMINI_AGENT_HINTS_CACHE` | `omit` never sends `cache_control` |
| `GEMINI_AGENT_HINTS_TTL_S` | default TTL, clamped to 60–3600 (default `600`) |
| `GEMINI_AGENT_HINTS_MIN_PREFIX_TOKENS` | skip `cache_control` below this prefix size (default `128`) |
| `GEMINI_AGENT_HINTS_MODEL` | model used for manage requests |
| `GEMINI_AGENT_HINTS_DEBUG` | log the skip reason to stderr |

The `hook` subcommand always exits `0` and always prints a JSON object: a broken
hint must never fail a model call.

## Verified behaviour

The claim here is **seam-level**, not a benchmark: the header leaves the
patched CLI and arrives at the server, and nothing else about the request
changes.

1. **Real CLI, real hook, local server** — `e2e/run.sh` starts Gemini CLI
   (patched, `60f8082`) with this plugin registered as the `BeforeModel` hook,
   pointed at a local SSE stub that records the exact request headers. The stub
   answers the first turn with a `run_shell_command` call so the run produces a
   **tool continuation** as a second model call.
   Result: [`e2e/evidence/gemini-seam.json`](e2e/evidence/gemini-seam.json).
2. **Unit tests** — 37 tests over the protocol validator, the state machine
   (start/append, retry reuse, epoch bump, cache suppression), the file store
   (subagent keying, corrupt-file quarantine, 256-session cap), the hook
   adapter and the manage transport.

| # | Request | Header | state | call_index | epoch | cache offset | priority |
|---|---|---|---|---|---|---|---|
| 1 | first turn | yes | `start` | 1 | 0 | 1 | 3 |
| 2 | tool continuation | yes | `append` | 2 | 0 | 3 | 1 |

Not claimed: full-framework e2e coverage of every auth mode, or of Gemini CLI's
own compression path. Auxiliary generations (web search, screenshot analysis,
compaction summaries) call `generateContent` directly and never reach the hook,
so they carry no hint by construction.

## Compliance

- **L1** (core wire): complete — one hint per ordinary request, exact
  four-block shape, header below 4 KiB.
- **L2** (lifecycle): complete — four verbs, explicit `edits`, placeholder body.
- **L3**: not claimed — Gemini CLI exposes no token-level draft signal, so
  there is no honest prefetch lead time.

Full checklist, degradation profile (§12.4) and trigger table (§7.5):
[`docs/protocol-compliance.md`](docs/protocol-compliance.md).

Notable harness facts:

- `session_id` is the same for the main chat and every subagent, so state is
  keyed by `(session_id, conversation root)`; a subagent gets its own
  `session_id`/`call_index` sequence instead of corrupting the parent's.
- The hook is a short-lived process, so state is a file per conversation under
  `GEMINI_AGENT_HINTS_DIR`, written atomically and capped at 256 entries.
- A committed history rewrite changes the conversation root, which correctly
  starts a new logical session.
- Retries reuse the same hint until the wire shape changes.

## Compatibility

| | |
|---|---|
| Protocol | `agent-hint-protocol` v1.0 |
| Gemini CLI | `60f8082` (2026-11-26) |
| Node | 20+ |
| Dependencies | none at runtime (`node:crypto`, `node:fs`, global `fetch`) |

## Privacy

The sender emits an opaque session id, counters and cache offsets. It never
reads the prompt, tool output or user content beyond counting messages. See
[PRIVACY.md](PRIVACY.md).

## License

Apache-2.0.
