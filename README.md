# superset-race

Give the same prompt to several coding agents, each in its own
[Superset](https://github.com/superset-sh/superset) workspace. Wait for all of
them to finish, run your verify command in every worktree, and see who
won:

```
$ superset-race --project humanize --agents claude,codex,gemini --jobs 4 \
    --prompt "Fix python-humanize/humanize#379: precisedelta() drops the sign of negative timedeltas. Keep the sign and add tests." \
    --verify "uv run --quiet --no-project --with-editable . --with pytest --with freezegun --with pytest-benchmark --with pytest-codspeed pytest -q -p no:cacheprovider --benchmark-disable"

Racing claude vs codex vs gemini in humanize
  ✓ claude launched on race/20260929-141912/claude
  ✓ codex launched on race/20260929-141912/codex
  ✓ gemini launched on race/20260929-141912/gemini

Waiting for agents to go idle
  ✓ claude  idle          6s      terminals.list
  ✓ codex   idle          5s      terminals.list
  ✓ gemini  idle          5s      terminals.list

Diffing against origin/main
Verifying with: uv run --quiet --no-project --with-editable . --with pytest …
  claude: pass in 11s
  baseline: pass in 11s
  codex: pass in 11s
  gemini: pass in 11s

  #  AGENT     STATUS  TIME  TESTS       NEW TESTS  TEST FILES  DIFF
  1  claude    idle    6s    764 passed  +3         1           2 files +19 −2
  2  codex     idle    5s    762 passed  +1         1           2 files +3 −1
  3  gemini    idle    5s    761 passed  0          0           1 file +1 −1
     baseline                761 passed                         392aef70

Winner: claude on race/20260929-141912/claude
  open  superset workspaces open ws-claude-1
  diff  git -C …/worktrees/ws-claude-1 diff 392aef707c0e
```

*This output is from a dry run on the real humanize repo, with a real baseline and real pytest runs. The "agents" were scripted patches driven by [`test/mock-superset.ts`](test/mock-superset.ts), which is why the times are seconds. For a run with real agents, see [`demo/`](demo/).*

## What it does

1. **Creates one workspace per agent** with `superset workspaces create --agent <id> --prompt …`.
   Each one gets branch `race/<run-id>/<agent>` and is filed under a `race` sidebar folder.
2. **Waits for every agent to go idle**, using the best signal available (see below).
   An agent counts as done once it has been idle for `--settle` (15s by default).
3. **Runs `--verify` in each worktree, and once on the base commit** (the baseline), then parses the
   pass/fail counts from pytest, jest, vitest, bun, node:test, mocha, cargo, go (`-v`) or rspec
   output.
4. **Prints a scoreboard** and writes `race.json`, `scoreboard.md` and every verify log to
   `~/.superset-race/<run-id>/`.

| Column | Meaning |
| --- | --- |
| TESTS | Passed/failed from that worktree's verify run |
| NEW TESTS | Test cases vs the baseline run, so new rows in an existing `parametrize` table count. With `--no-baseline`, it is the net test declarations added in the diff |
| TEST FILES | Test files the agent touched |
| DIFF | Everything the agent produced vs the fork point: commits, staged, unstaged and untracked files |

Ranking rules, in order: changed something → verify green → fewer failures → more new tests
→ more passing → smaller diff → faster.

## How "idle" is detected

Superset's host service already records each agent's lifecycle hooks (`Start`, `Stop`,
`PermissionRequest`, `Failed`). That same record drives the working spinner in the desktop
app. The public CLI doesn't expose it yet, so `superset-race` tries three sources in order:

1. `superset terminals list --json` rows that carry `agentStatus`. This is what
   [superset-sh/superset#7007](https://github.com/superset-sh/superset/pull/7007) adds.
2. The local host service's `terminalAgents.listByWorkspace` tRPC procedure, found through
   `~/.superset/host/<org>/manifest.json` the same way the CLI finds it. **This is a stopgap
   against a private API.**
3. Screen quiescence via `superset terminals read`: the screen hasn't changed for 2×`--settle`.
   This source can't tell a finished agent from one waiting at a permission prompt.

The scoreboard's last column shows which source was used for each agent.

## Try it

[`demo/`](demo/) races Claude and Codex on a real open-source bug
([python-humanize/humanize#379](https://github.com/python-humanize/humanize/issues/379)).
`bash demo/setup.sh` checks and prepares everything, then `bash demo/race.sh` runs it.

## Requirements

- The Superset desktop app, which ships the CLI at `~/.superset/bin/superset`, or the standalone
  CLI. You must be signed in (`superset auth login`) and have the repo added as a project
  (`superset projects list`).
- The agents you race, installed and signed in (`claude`, `codex`, `gemini`, …).
- [Bun](https://bun.sh) ≥ 1.1.

## Usage

```bash
bun src/cli.ts --project <id|name> --prompt "<task>" [options]
bun src/cli.ts --score <workspaceId,...>        # re-score workspaces later
bun src/cli.ts --help
```

Useful options: `--agents claude,codex,gemini`, `--verify "<cmd>"`, `--base-branch main`,
`--timeout 30m`, `--jobs 4` (verify in parallel), `--no-baseline`, `--cleanup` (delete every
race workspace except the winner's), `--json`.

If you omit `--verify`, the script uses the project's `verify` script from `.superset/config.json`
when one exists. Otherwise it guesses from the repo: `npm test`, `pnpm test`, `bun run test`,
`uv run pytest -q`, `go test -v ./...` or `cargo test`. Verify runs with `CI=1` in the worktree
as-is. If the repo needs dependencies installed, either put the install in the verify command or
let the project's Superset setup script handle it.

Pressing Ctrl-C while waiting leaves the agents running and prints the `--score` command for
finishing later.

## Limits

- Local host only. Verify and diff run on this machine. Remote and cloud hosts would need a
  host-side "run and wait" primitive, which is part of the feature proposal.
- A `Stop` can arrive while subagents are still running
  ([superset-sh/superset#7395](https://github.com/superset-sh/superset/issues/7395)).
  `--settle` absorbs short gaps.

## Development

```bash
bun install
bun test          # unit tests + e2e against test/mock-superset.ts (real git, real `bun test`)
bun run typecheck
```

`test/mock-superset.ts` implements the subset of the CLI this script uses. It creates real
git worktrees, and its fake agents run `test/agents/<agent>.sh` while emitting Superset's
lifecycle events.
