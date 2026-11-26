#!/bin/bash
# Seam-level check: real Gemini CLI (patched) -> local SSE stub.
#
#   GEMINI_CLI_BIN=/path/to/gemini-cli/bundle/gemini.js bash e2e/run.sh
#
# Requires: the patch in patches/ applied to that checkout, `npm run build`
# done in this repository, and Node 20+ on PATH.
set -o pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN=$(cd "$HERE/.." && pwd)
GEMINI_BIN=${GEMINI_CLI_BIN:-$HOME/research/gemini-cli/bundle/gemini.js}
D=${E2E_DIR:-$HOME/.cache/gemini-agent-hints-e2e}

if [ ! -f "$GEMINI_BIN" ]; then
  echo "missing CLI bundle: $GEMINI_BIN (set GEMINI_CLI_BIN)" >&2
  exit 1
fi

rm -rf "$D"
mkdir -p "$D/work" "$D/home/.gemini"

cp "$HERE/stub.mjs" "$D/stub.mjs"

cat > "$D/home/.gemini/settings.json" <<JSON
{
  "security": {
    "folderTrust": { "enabled": false },
    "auth": { "selectedType": "gemini-api-key" }
  },
  "hooks": {
    "BeforeModel": [
      {
        "hooks": [
          {
            "type": "command",
            "name": "agent-hints",
            "command": "node $PLUGIN/dist/cli.js hook",
            "timeout": 20000
          }
        ]
      }
    ]
  }
}
JSON

cd "$D/work" || exit 1
PORT=8899 CAPTURE="$D/capture.ndjson" node "$D/stub.mjs" > "$D/stub.log" 2>&1 &
STUB=$!
sleep 1

ORIGINAL_HOME=$HOME
export HOME="$D/home"
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8899
export GEMINI_API_KEY=stub-key
export GEMINI_AGENT_HINTS_DIR="$D/state"
export GEMINI_AGENT_HINTS_MIN_PREFIX_TOKENS=1
export GEMINI_AGENT_HINTS_TTL_S=600
export GEMINI_AGENT_HINTS_DEBUG=1
export GEMINI_CLI_TRUST_WORKSPACE=true
export GEMINI_CLI_NO_UPDATE_CHECK=1
export NO_COLOR=1

timeout 180 node "$GEMINI_BIN" -p "run echo hi" --yolo --model gemini-2.5-flash \
  > "$D/cli.out" 2> "$D/cli.err"
CLI_EXIT=$?
kill $STUB 2>/dev/null
export HOME=$ORIGINAL_HOME
echo "CLI_EXIT=$CLI_EXIT"

python3 "$HERE/capture_to_evidence.py" \
  "$D/capture.ndjson" "$PLUGIN/e2e/evidence/gemini-seam.json"
CHECKS=$?

tail -3 "$D/cli.out"
if [ "$CLI_EXIT" -ne 0 ]; then
  exit $CLI_EXIT
fi
exit $CHECKS
