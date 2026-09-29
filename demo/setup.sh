#!/usr/bin/env bash
# Pre-flight for the humanize#379 race demo. Safe to re-run; it only fixes
# what it can and tells you how to fix the rest.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=demo.env
source "$HERE/demo.env"

FAILED=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
json() { bun -e "const d = JSON.parse(await Bun.stdin.text()); console.log($1)"; }

echo "Tools"
command -v bun >/dev/null && ok "bun $(bun --version)" || bad "bun missing: curl -fsSL https://bun.sh/install | bash"
command -v uv >/dev/null && ok "uv $(uv --version | cut -d' ' -f2)" || bad "uv missing: curl -LsSf https://astral.sh/uv/install.sh | sh"
command -v git >/dev/null && ok "git $(git --version | cut -d' ' -f3)" || bad "git missing"
if [ -x "$SUPERSET_BIN" ]; then
	ok "superset CLI at $SUPERSET_BIN"
else
	bad "superset CLI missing: brew install --cask superset (or https://superset.sh), then open the app once"
fi
(cd "$HERE/.." && bun install --silent >/dev/null 2>&1) && ok "superset-race dependencies"

install_hint() {
	case "$1" in
	claude) echo "brew install --cask claude-code" ;;
	codex) echo "brew install codex" ;;
	gemini) echo "brew install gemini-cli" ;;
	*) echo "see its docs" ;;
	esac
}

echo "Agents"
for agent in ${AGENTS//,/ }; do
	if command -v "$agent" >/dev/null; then
		ok "$agent installed (make sure you are signed in: run \`$agent\` once)"
	else
		bad "$agent not on PATH: $(install_hint "$agent")"
	fi
done

echo "Superset"
if [ -x "$SUPERSET_BIN" ]; then
	if who=$("$SUPERSET_BIN" auth whoami --json 2>/dev/null); then
		ok "signed in as $(echo "$who" | json 'd.email ?? d.user?.email ?? d.name ?? "you"')"
	else
		bad "not signed in: $SUPERSET_BIN auth login"
	fi
	running=$("$SUPERSET_BIN" status --json 2>/dev/null | json 'd.running' 2>/dev/null)
	[ "$running" = "true" ] && ok "host service running" || bad "host service not running: open the Superset app (or: $SUPERSET_BIN start)"
fi

echo "Repo"
if [ ! -d "$DEMO_DIR/.git" ]; then
	mkdir -p "$(dirname "$DEMO_DIR")"
	git clone -q https://github.com/python-humanize/humanize "$DEMO_DIR" && ok "cloned humanize to $DEMO_DIR"
fi
if [ -d "$DEMO_DIR/.git" ]; then
	git -C "$DEMO_DIR" checkout -q main && git -C "$DEMO_DIR" pull -q --ff-only
	ok "humanize main at $(git -C "$DEMO_DIR" rev-parse --short HEAD)"
	[ -z "$(git -C "$DEMO_DIR" status --porcelain)" ] && ok "working tree clean" || warn "uncommitted changes in $DEMO_DIR"
	stale=$(git -C "$DEMO_DIR" branch --list 'race/*' '*/race/*' | wc -l | tr -d ' ')
	[ "$stale" = "0" ] || warn "$stale race branches from an earlier run: bash demo/reset.sh"
fi
if command -v gh >/dev/null; then
	state=$(gh issue view 379 -R python-humanize/humanize --json state -q .state 2>/dev/null)
	[ "$state" = "OPEN" ] && ok "issue #379 still open" || warn "issue #379 is ${state:-unknown}; pick another bug and set PROMPT"
fi

echo "Superset project"
if [ -x "$SUPERSET_BIN" ] && [ -d "$DEMO_DIR/.git" ]; then
	target=$(cd "$DEMO_DIR" && pwd -P)
	projects=$("$SUPERSET_BIN" projects list --local --json 2>/dev/null)
	found=$(echo "${projects:-[]}" | TARGET="$target" json 'd.find(p => { try { return require("fs").realpathSync(p.path) === process.env.TARGET } catch { return false } })?.name ?? ""')
	if [ -n "$found" ]; then
		ok "project \"$found\" points at $DEMO_DIR"
	elif "$SUPERSET_BIN" projects create --local --name humanize --import "$DEMO_DIR" --json >/dev/null 2>&1; then
		ok "added $DEMO_DIR to Superset as project \"humanize\""
	else
		bad "could not add the project: drag $DEMO_DIR into the Superset sidebar, then re-run"
	fi
fi

echo "Agent folder trust"
# Superset's worktrees inherit trust from the main checkout. Untrusted, each
# agent parks on a "trust this folder?" dialog and never starts the task.
if [ -d "$DEMO_DIR/.git" ]; then
	repo=$(cd "$DEMO_DIR" && pwd -P)
	for agent in ${AGENTS//,/ }; do
		case "$agent" in
		claude)
			trusted=$(REPO="$repo" bun -e 'const d = JSON.parse(await Bun.file(process.env.HOME + "/.claude.json").text()); console.log(d.projects?.[process.env.REPO]?.hasTrustDialogAccepted === true)' 2>/dev/null)
			fix="cd $DEMO_DIR && claude --dangerously-skip-permissions, choose \"Yes, I trust this folder\" and \"Yes, I accept\", then /exit"
			;;
		codex)
			trusted=$(grep -A1 -F "[projects.\"$repo\"]" "$HOME/.codex/config.toml" 2>/dev/null | grep -q 'trust_level = "trusted"' && echo true)
			fix="cd $DEMO_DIR && codex, choose \"Trust and continue\" and \"Trust all and continue\", then /quit"
			;;
		*) continue ;;
		esac
		[ "$trusted" = "true" ] && ok "$agent trusts $DEMO_DIR" || bad "$agent hasn't trusted $DEMO_DIR: $fix"
	done
fi

echo "Warm-up"
if [ -d "$DEMO_DIR/.git" ] && command -v uv >/dev/null; then
	summary=$(cd "$DEMO_DIR" && eval "$VERIFY" 2>&1 | tail -1 | sed 's/\x1b\[[0-9;]*m//g')
	ok "verify runs, and uv's cache is warm: $summary"
fi

echo
if [ "$FAILED" = "0" ]; then
	echo "Ready. Run the race with: bash $HERE/race.sh"
else
	echo "Fix the ✗ items above and re-run: bash $HERE/setup.sh"
	exit 1
fi
