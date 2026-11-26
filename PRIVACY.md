# Privacy

`gemini-cli-agent-hints` is a header annotator. It is designed to work without
ever learning what you asked the model.

## What leaves your machine

Exactly one additional request header on ordinary model calls:

```
X-Agent-Hint: <base64url JSON>
```

It contains only:

- an opaque session id (`ah-` + 12 random bytes, or a stored random id),
- `call_index`, `epoch` and `state`,
- a priority level and its fixed reason string,
- a cache TTL and a **count** of wire messages.

There is no prompt text, no tool name list, no file path, no user id, no host
name in the hint.

## What is stored on disk

One small JSON file per conversation under `~/.gemini/agent-hints/` (or
`GEMINI_AGENT_HINTS_DIR`), mode `0600` inside a `0700` directory. It holds the
same counters listed above plus a hash of the request shape used for retry
detection.

The store is capped at 256 conversations; older ones are deleted. Removing the
directory resets the sender; `gemini-agent-hints reset --all` does the same.

## What is never done

- No prompt, completion or tool output is logged.
- No telemetry, no analytics endpoint, no update check.
- No network request on the ordinary path. The only outgoing request the plugin
  ever makes is an explicit `gemini-agent-hints manage …` command, and it goes
  to the same base URL and with the same credentials as the host.

## Third parties

The hint is read by whichever inference gateway serves your model traffic. If
you do not control that gateway, assume the operator can see these counters.
