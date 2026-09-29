# Demo: agents race on a real bug

**Repo:** [python-humanize/humanize](https://github.com/python-humanize/humanize). Its pytest suite has about 760 tests and runs in about 10s once warm.
**Bug:** [#379: `precisedelta()` silently drops the sign of negative timedeltas](https://github.com/python-humanize/humanize/issues/379).
It's small and real. A good fix touches `src/humanize/time.py` and adds cases to `tests/test_time.py`, and a sloppy fix misses one of the return paths.

```bash
bash demo/setup.sh    # checks everything, clones humanize, adds it to Superset, warms uv's cache
bash demo/race.sh     # claude vs codex on #379, full test suite, scoreboard
bash demo/reset.sh    # between races: delete race workspaces and race/* branches
```

`setup.sh` is safe to re-run. It fixes what it can and prints the exact fix for the rest:

- missing tools
- agents that aren't installed
- Superset not signed in, or its host service not running
- the project not added yet

Everything is configured in [`demo.env`](demo.env): `DEMO_DIR`, `AGENTS`, `PROMPT`, `VERIFY`. Override any
of them from the environment, e.g. `AGENTS=claude bash demo/race.sh`. Extra flags pass
through to the CLI, e.g. `bash demo/race.sh --timeout 20m`.

Add Gemini with `AGENTS=claude,codex,gemini`, but only on a paid Gemini API key: the free tier allows
20 requests a day, which runs out partway through a single agent session.

A race with real agents takes a few minutes. Results land in `~/.superset-race/<run-id>/`:

- `scoreboard.md`
- `race.json`
- one verify log per agent, plus the baseline
