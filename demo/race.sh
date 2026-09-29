#!/usr/bin/env bash
# The race you record: three agents, humanize#379, full test suite. Extra flags pass through.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=demo.env
source "$HERE/demo.env"

exec bun "$HERE/../src/cli.ts" \
	--project "$DEMO_DIR" \
	--agents "$AGENTS" \
	--jobs 4 \
	--prompt "$PROMPT" \
	--verify "$VERIFY" \
	"$@"
