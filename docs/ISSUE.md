<!--
Feature request for superset-sh/superset, following .github/ISSUE_TEMPLATE/feature_request.yml.
Before opening:
  - replace the scoreboard with the one from the real run (~/.superset-race/<run-id>/scoreboard.md)
  - commit the scoreboard screenshot as docs/real-run-scoreboard.png (or drop the image line)
Title:
  [feat] CLI: race one prompt across agents — `superset agents wait` + `superset race`
-->

### What problem are you trying to solve?

Superset makes it easy to give one task to several agents at once. The next question is **which
result to merge**, and today I answer it by hand. I watch sidebar spinners until each agent stops,
open every worktree, run the tests in each, and compare diffs by eye. That part doesn't scale past
two agents.

The CLI can already do the fan-out (`superset workspaces create --agent … --prompt …`). It can't do
the rest:

1. **It can't wait for an agent to finish.** `superset terminals list` reports PTYs, not agent
   state. The host service already records the normalized lifecycle (`Start` / `Stop` /
   `PermissionRequest` / `Failed` in `terminal_agent_bindings`), and the workspace board uses it,
   but the CLI and SDK can't read it. #7007 exposes it on `terminals.list`. #6980 asks for the
   related identity and liveness.
2. **It can't run a check in a worktree and get the result back.** `terminals create --command`
   is fire-and-forget: there's no exit code and no output to parse.
3. **It can't compare results.** Nothing summarizes N workspaces side by side: tests, new tests,
   diff size.

### Proposed solution

Two layers. The first is small and useful on its own. The second is built on top of it.

**1. `superset agents wait`: block until an agent settles**

```
superset agents wait --workspace <id> [--terminal <id>] [--timeout 30m] [--settle 15s] [--json]
```

- Polls, or subscribes to, the same binding the board uses. It returns when `lastEventType` has
  been `Stop` for `--settle`.
- Exit codes: `0` idle · `2` needs input (`PermissionRequest`) · `3` failed or exited · `124`
  timeout. `--json` prints the final `agentStatus` (the shape from #7007).
- `--terminal` defaults to the workspace's only agent terminal. With several, it waits for all of
  them.
- It also needs a **"never started"** state. An agent parked on a first-run dialog (folder trust,
  hook trust, sign-in) emits no lifecycle event at all, so it looks the same as one that's still
  booting. In my first real run, both agents sat on "trust this folder?" for 30 minutes before the
  script timed out: the demo repo had never been trusted, and Superset's worktrees inherit trust
  from the main checkout. A deadline for the first event, reported as its own exit code, would
  make this fail fast.
- Useful for CI, automations and any script that chains agents, not just racing.

**2. `superset race`: fan out, wait, verify, score**

```
superset race --project <id> --prompt "<task>" --agents claude,codex,gemini
              [--verify "<cmd>"] [--base-branch main] [--timeout 30m]
              [--baseline] [--cleanup losers] [--json]
```

```
create N workspaces ──► agents wait (each) ──► verify in each worktree ──► diff vs fork point ──► scoreboard
  branch race/<run>/<agent>   same state machine    + once on base commit     commits+staged+untracked    race.json
  tag "race" (sidebar folder)  as `agents wait`      (host-side, see below)
```

- **Verify command.** Order of precedence: `--verify`, then a new `verify` key in
  `.superset/config.json` next to `setup`/`teardown`/`run`, then nothing (tests only).
  ```json
  { "setup": ["bun install"], "verify": ["bun run typecheck", "bun test"] }
  ```
- **Verify runs on the host**, via a small host-service procedure such as
  `terminal.runToCompletion({ workspaceId, command, timeoutMs }) → { exitCode, output }`. That makes
  it work the same for local, remote and cloud workspaces, where the CLI can't reach the worktree.
- **Scoreboard.** Tests passed/failed (parsed from common runners), new tests (the delta against
  the baseline run, so new `parametrize` rows count), test files touched, and diff stat. The
  default ranking is: changed something → green → fewer failures → more new tests → smaller diff →
  faster. It's shown but not enforced. `--json` gives the raw numbers.
- **Desktop follow-up (out of scope here).** The `race` tag folder already groups the workspaces.
  A compare view could come later.

Suggested order: (a) #7007 lands, (b) `agents wait`, (c) the host-side run-to-completion
procedure, (d) `race`. I'm happy to send PRs for (b) through (d) once the shape is agreed.

**Open questions for maintainers**

- Should `race` be its own command, or `workspaces create --agents a,b,c` plus `superset compare`?
- Should the ranking be opinionated, or should `race` only report the numbers?
- Is `.superset/config.json` the right place for `verify`, given that `run` there is usually a dev server rather than a check?

### Workarounds you've tried

I built the proposal as a standalone script on today's CLI: **https://github.com/harshkumawat5/superset-race**
(Bun/TypeScript, no dependencies, tested against a mock CLI). Here it is racing Claude and Codex
on a real open bug, python-humanize/humanize#379:

![Scoreboard from the real run](https://raw.githubusercontent.com/harshkumawat5/superset-race/main/docs/real-run-scoreboard.png)

| # | AGENT | STATUS | TIME | TESTS | NEW TESTS | TEST FILES | DIFF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | claude | idle | 3m18s | 770 passed | +9 | 1 | 2 files +43 −2 |
| 2 | codex | idle | 56s | 676 passed 90 failed | +4 | 1 | 2 files +23 −2 |
|  | baseline |  |  | 761 passed |  |  | 392aef70 |

Both agents wrote almost the same fix. Codex finished 3.5× sooner, but its check calls `dt.timedelta`
at runtime, and humanize imports `datetime` only under `TYPE_CHECKING`, so every `precisedelta()` call
raises `NameError`. Claude imported it inside the function. That's the call this is meant to make:
the fast diff that looks right breaks the package, and only running the suite in each worktree
shows it.

To wait for idle, the script has to fall back to things a CLI user shouldn't need:

1. It reads `~/.superset/host/<org>/manifest.json` and calls the host's private
   `terminalAgents.listByWorkspace` tRPC procedure directly.
2. Failing that, it treats "the screen from `terminals read` hasn't changed for 30s" as idle.
   This can't tell a finished agent from one blocked on a permission prompt.
3. To catch agents that never start, it reads the screen of any agent that hasn't reported
   anything for a minute and matches it against known first-run prompts.

Verify and diff run in the local worktree. The script can't support remote or cloud hosts, which is
why the proposal puts verify on the host. `agents wait` plus a run-to-completion primitive would
shrink the script to about 100 lines of glue, and the built-in `race` would replace it.
