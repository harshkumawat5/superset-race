#!/usr/bin/env bash
# Between races: delete the race workspaces and race/* branches so the next race starts clean.
# Only touches workspaces tagged "race" and branches under race/. Pass -y to skip the prompt.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=demo.env
source "$HERE/demo.env"

ids=$("$SUPERSET_BIN" workspaces list --local --tag race --json |
	bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.map(w => w.id).join(" "))')
branches=$(git -C "$DEMO_DIR" branch --format='%(refname:short)' --list 'race/*' '*/race/*')

if [ -z "$ids" ] && [ -z "$branches" ]; then
	echo "Nothing to reset."
	exit 0
fi
echo "Workspaces tagged race: ${ids:-none}"
echo "Branches: $(echo "${branches:-none}" | tr '\n' ' ')"
if [ "${1:-}" != "-y" ]; then
	read -r -p "Delete them? [y/N] " answer
	[ "$answer" = "y" ] || exit 1
fi

# shellcheck disable=SC2086
[ -n "$ids" ] && "$SUPERSET_BIN" workspaces delete $ids --local
for branch in $branches; do
	git -C "$DEMO_DIR" branch -D "$branch" >/dev/null 2>&1 || true
done
git -C "$DEMO_DIR" worktree prune
echo "Clean. Next race: bash $HERE/race.sh"
