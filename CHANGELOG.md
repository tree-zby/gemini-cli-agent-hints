# Changelog

## 0.1.0 — 2026-11-26

First release.

- `BeforeModel` hook sender for Gemini CLI, emitting `X-Agent-Hint` (protocol
  v1.0) on ordinary model requests.
- Host patch `patches/0001-before-model-http-headers.patch` (71 added lines):
  `http_headers` on the `BeforeModel` output type, `before_model_meta` on the
  hook input, and the merge point in `geminiChat.ts`.
- File-backed session store keyed by `(session_id, conversation root)`, so
  subagents that share the CLI session id do not corrupt the parent counters.
- Lifecycle verbs: `pause`, `resume`, `stop`, `compact` as standalone manage
  requests with a placeholder body and reused host credentials; degrades to L1
  when no credential is available.
- 37 unit tests; seam-level wire capture from a real CLI run in `e2e/`.
