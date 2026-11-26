# Protocol compliance — Gemini CLI sender

Target: `agent-hint-protocol` v1.0. Level claim: **L1 + L2 complete, L3 not
claimed**.

## Section by section

### 3. Header transport

| Rule | Status | Note |
|---|---|---|
| 3.1 single `X-Agent-Hint` header on ordinary requests | done | merged into `config.httpOptions.headers` in `geminiChat.ts` |
| 3.2 base64url, no padding | done | `src/encoder.ts` |
| 3.3 ≤ 4096 bytes | done | `encode()` throws above the budget; the adapter then drops the hint |
| 3.4 body untouched | done | only the header map changes; `body_has_no_hint_fields` in the capture |

### 4. Shape

Four top-level blocks at most: `session`, `context_management`,
`priority_control`, `cache_control`. `validate()` rejects anything else, and the
adapter validates every hint before sending it (fail-open: an invalid hint is
dropped, the model call proceeds).

### 5. Session

| Rule | Status | Note |
|---|---|---|
| 5.1 `start` opens a session | done | first request of a conversation with one wire content |
| 5.2 `append` only continues | done | all later requests |
| 5.3 lifecycle verbs are their own requests | done | `gemini-agent-hints manage <verb>` |
| 5.4 `parent_session_id` for affinity | not sent | Gemini CLI exposes no parent/child relationship to the hook |
| 5.5 `call_index` monotonically increases | done | incremented once per logical request |
| 5.6 retries reuse the hint | done | fingerprint over model, tool set and wire shape |

### 6. Cache control

| Rule | Status | Note |
|---|---|---|
| 6.1 `ephemeral` only | done | |
| 6.2 `ttl_s` inside request bounds | done | clamped to 60–3600 |
| 6.3 `msg_offset` counts wire messages | done | from `before_model_meta.wire_message_count` (V-02) |
| 6.4 omitted below a useful prefix | done | `GEMINI_AGENT_HINTS_MIN_PREFIX_TOKENS`, default 128 |
| 6.5 suppressed right after a rewrite | done | `after_rewrite` flag |

### 7. Triggers

| 7.5 trigger | Sender behaviour |
|---|---|
| 7.5.1 new user turn | `start` / `append`, priority 3 |
| 7.5.2 tool continuation | `append`, priority 1 (`has_tool_parts`) |
| 7.5.3 history rewrite | `compact` manage verb, then a fresh conversation root |
| 7.5.4 explicit pause / resume | manage verbs |
| 7.5.5 session end | manage `stop` |
| 7.2 auxiliary generations | never annotated — they bypass the `BeforeModel` hook |

### 8. Manage requests

| Rule | Status | Note |
|---|---|---|
| 8.1 `manage_request: true` | done | |
| 8.1 exactly one edit, `target: "session"` | done | `editFor()` maps verb → `offload` / `prefetch` / `evict` |
| 8.2 no `priority_control` / `cache_control` | done | enforced by `validate()` and tested |
| 9.2 empty `messages` allowed | adapted | the Gemini API rejects empty `contents`, so the body is a single `.` part |

### 9. Lifecycle state

| Rule | Status | Note |
|---|---|---|
| 9.3 idempotent verbs | done | repeating a verb resends the same shape with the next `call_index` |
| 9.3 `epoch` invalidation | partial | the sender keys on the conversation root, so a rewrite starts a new session instead of reusing an epoch |
| 9.3 `stop` releases pins | done | the receiver decides; the sender emits `evict` |
| 9.4 priority levels | done | 3 `user_waiting` / 1 `critical_path` |

### 10. Security

- No prompt text, tool output or user content is read beyond counting.
- State files are `0600` inside a `0700` directory.
- No network calls on the ordinary path: the hook only writes a header. The
  only outbound request is an explicit `manage` command.

## Degradation profile (§12.4)

| Missing capability | Sender response |
|---|---|
| no reusable credential for manage requests | `degraded: true`, hint printed, no request sent (L1) |
| no `before_model_meta` (unpatched host) | falls back to the text projection; `msg_offset` is then only an estimate |
| hook output rejected by the host | HTTP is unchanged — the patch merges headers, it never replaces config |

## What is deliberately not claimed

- **L3 / prefetch:** Gemini CLI produces no token-level draft signal, so there
  is no honest prefetch lead time.
- **Full-framework e2e:** the capture runs the real CLI and the real hook
  against a local stub. It proves the header leaves the client; it says nothing
  about receiver behaviour.
- **Every auth mode:** only API-key mode is exercised end to end. Vertex and
  Code Assist OAuth reuse `GEMINI_AGENT_HINTS_BEARER`, which is unit-tested at
  the transport level but not exercised against a live endpoint.
