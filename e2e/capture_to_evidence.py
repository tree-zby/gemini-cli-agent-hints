#!/usr/bin/env python3
"""Turn a stub capture into the evidence file shipped in `e2e/evidence/`."""

import json
import pathlib
import re
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    src = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)

    rows = [json.loads(line) for line in src.read_text().splitlines() if line.strip()]
    streams = [r for r in rows if "streamGenerateContent" in (r.get("url") or "")]

    requests = []
    for index, row in enumerate(streams, 1):
        hint = row.get("hint") or {}
        session = hint.get("session") or {}
        cache = hint.get("cache_control") or {}
        priority = (hint.get("priority_control") or {}).get("priority") or {}
        body = row.get("body_prefix") or ""
        requests.append(
            {
                "index": index,
                "url": row.get("url"),
                "hint_header_present": row.get("hint_header_present"),
                "hint": hint,
                "state": session.get("state"),
                "call_index": session.get("call_index"),
                "epoch": session.get("epoch"),
                "msg_offset": cache.get("msg_offset"),
                "priority_level": priority.get("level"),
                "priority_reason": priority.get("reason"),
                "has_context_management": "context_management" in hint,
                "body_mentions_hint": bool(
                    re.search(
                        r"x-agent-hint|context_management|priority_control|cache_control",
                        body,
                        re.I,
                    )
                ),
                "body_bytes": row.get("body_bytes"),
            }
        )

    checks = {
        "two_model_requests_captured": len(requests) == 2,
        "every_request_carries_a_hint": all(r["hint_header_present"] for r in requests),
        "first_is_start": bool(requests) and requests[0]["state"] == "start",
        "second_is_append": len(requests) > 1 and requests[1]["state"] == "append",
        "call_index_increments": [r["call_index"] for r in requests] == [1, 2],
        "offset_tracks_wire_contents": [r["msg_offset"] for r in requests] == [1, 3],
        "tool_continuation_is_critical_path": (
            len(requests) > 1 and requests[1]["priority_level"] == 1
        ),
        "opening_turn_is_user_waiting": (
            bool(requests) and requests[0]["priority_level"] == 3
        ),
        "ordinary_requests_have_no_context_management": not any(
            r["has_context_management"] for r in requests
        ),
        "body_has_no_hint_fields": not any(r["body_mentions_hint"] for r in requests),
    }

    evidence = {
        "kind": "seam-level wire capture (real Gemini CLI + real hook + local SSE stub)",
        "harness": {
            "binary": "gemini-cli bundle built from 60f8082 with patches/0001",
            "hook": "node dist/cli.js hook (BeforeModel)",
            "endpoint": "http://127.0.0.1:8899 (local stub)",
            "prompt": "run echo hi --yolo",
        },
        "requests": requests,
        "checks": checks,
    }
    out.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(checks, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
