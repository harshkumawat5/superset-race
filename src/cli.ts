#!/usr/bin/env bun
/**
 * superset-race: give several coding agents the same prompt, each in its own
 * Superset workspace, wait for them to go idle, verify every worktree, and
 * print a scoreboard.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { killRunning } from "./exec.ts";
import { addBaselineWorktree, defaultBranch, diffStats } from "./git.ts";
import { type Baseline, type Racer, rank, renderMarkdown, renderTable } from "./scoreboard.ts";
import {
	createAgentWorkspace,
	deleteWorkspaces,
	getWorkspace,
	resolveProject,
	StatusProber,
	type WorkspaceDetail,
} from "./superset.ts";
import {
	color,
	formatDuration,
	pad,
	parseDuration,
	RaceError,
	sleep,
	stripAnsi,
	timestampId,
} from "./util.ts";
import { detectVerifyCommand, runVerify, type VerifyResult } from "./verify.ts";

const HELP = `superset-race — race coding agents on one prompt in Superset workspaces

Usage
  superset-race --project <id|name|path> --prompt <text> [options]
  superset-race --score <workspaceId,...> [options]      re-score finished workspaces
  superset-race --show <run-id|dir>                      re-print a past run's scoreboard

Options
  --project <ref>         Superset project to race in: id, name, or repo path
  --prompt <text>         Task every agent gets; or --prompt-file <path>
  --agents <list>         Comma-separated agent presets (default: claude,codex)
  --verify <cmd>          Shell command run in each worktree (default: detected)
  --base-branch <name>    Branch to fork from and diff against (default: repo default)
  --timeout <dur>         Longest to wait for agents to go idle (default: 30m)
  --settle <dur>          How long an agent must stay idle to count as done (default: 15s)
  --poll <dur>            Status poll interval (default: 5s)
  --verify-timeout <dur>  Longest a single verify run may take (default: 15m)
  --jobs <n>              Verify runs in parallel (default: 1)
  --no-baseline           Skip the verify run on the base commit
  --tag <name>            Sidebar folder for the race workspaces (default: race)
  --out <dir>             Logs and results (default: ~/.superset-race/<run-id>)
  --cleanup               Delete every race workspace except the winner's
  --json                  Print the result as JSON instead of a table
  -h, --help
`;

interface Options {
	project?: string;
	prompt?: string;
	agents: string[];
	score?: string[];
	verify?: string;
	baseBranch?: string;
	timeoutMs: number;
	settleMs: number;
	pollMs: number;
	verifyTimeoutMs: number;
	jobs: number;
	baseline: boolean;
	tag: string;
	out?: string;
	cleanup: boolean;
	json: boolean;
}

const list = (value: string) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

function parseOptions(argv: string[]): Options | { show: string } | null {
	const parse = () =>
		parseArgs({
			args: argv,
			options: {
				project: { type: "string" },
				prompt: { type: "string" },
				"prompt-file": { type: "string" },
				agents: { type: "string", default: "claude,codex" },
				score: { type: "string" },
				show: { type: "string" },
				verify: { type: "string" },
				"base-branch": { type: "string" },
				timeout: { type: "string", default: "30m" },
				settle: { type: "string", default: "15s" },
				poll: { type: "string", default: "5s" },
				"verify-timeout": { type: "string", default: "15m" },
				jobs: { type: "string", default: "1" },
				"no-baseline": { type: "boolean", default: false },
				tag: { type: "string", default: "race" },
				out: { type: "string" },
				cleanup: { type: "boolean", default: false },
				json: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		});
	let values: ReturnType<typeof parse>["values"];
	try {
		values = parse().values;
	} catch (error) {
		throw new RaceError((error as Error).message, "See: superset-race --help");
	}
	if (values.help) return null;
	if (values.show) return { show: values.show };

	const prompt = values["prompt-file"]
		? readFileSync(values["prompt-file"], "utf-8").trim()
		: values.prompt;
	const score = values.score ? list(values.score) : undefined;
	if (!score && (!values.project || !prompt)) {
		throw new RaceError(
			"--project and --prompt are required",
			"Or pass --score <workspaceId,...> to score existing workspaces",
		);
	}
	const agents = list(values.agents);
	if (!score && new Set(agents).size !== agents.length) {
		throw new RaceError("--agents has duplicates; each agent races once");
	}
	const jobs = Number(values.jobs);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new RaceError("--jobs must be a positive integer");
	}

	return {
		project: values.project,
		prompt,
		agents,
		score,
		verify: values.verify,
		baseBranch: values["base-branch"],
		timeoutMs: parseDuration(values.timeout),
		settleMs: parseDuration(values.settle),
		pollMs: parseDuration(values.poll),
		verifyTimeoutMs: parseDuration(values["verify-timeout"]),
		jobs,
		baseline: !values["no-baseline"],
		tag: values.tag,
		out: values.out,
		cleanup: values.cleanup,
		json: values.json,
	};
}

// Progress goes to stderr so stdout carries only the scoreboard (or JSON).
const log = (message = "") => process.stderr.write(`${message}\n`);

async function launch(
	options: Options,
	runId: string,
	racers: Racer[],
): Promise<void> {
	const project = await resolveProject(options.project as string);
	log(color.bold(`Racing ${options.agents.join(" vs ")} in ${project.name}`));
	// One at a time: parallel `git worktree add` on one repo can trip git's locks.
	for (const agent of options.agents) {
		const racer: Racer = { agent, status: "starting" };
		racers.push(racer);
		try {
			const { workspaceId, terminalId } = await createAgentWorkspace({
				projectId: project.id,
				name: `${agent} (race ${runId})`,
				branch: `race/${runId}/${agent}`,
				baseBranch: options.baseBranch,
				agent,
				prompt: options.prompt as string,
				tag: options.tag,
			});
			racer.launchedAt = Date.now();
			racer.workspaceId = workspaceId;
			racer.terminalId = terminalId;
			const workspace = await getWorkspace(workspaceId);
			racer.branch = workspace.branch;
			racer.worktreePath = workspace.worktreePath;
			log(`  ${color.green("✓")} ${agent} launched on ${workspace.branch}`);
		} catch (error) {
			racer.status = "launch-failed";
			racer.statusDetail = error instanceof Error ? error.message : String(error);
			log(`  ${color.red("✗")} ${agent}: ${racer.statusDetail}`);
		}
	}
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function boardLine(racer: Racer, width: number, frame: number): string {
	const done = racer.elapsedMs !== undefined;
	const elapsed = done
		? racer.elapsedMs
		: racer.launchedAt
			? Date.now() - racer.launchedAt
			: undefined;
	const icon =
		racer.status === "launch-failed" || racer.status === "failed"
			? color.red("✗")
			: racer.status === "needs-input"
				? color.yellow("!")
				: done
					? color.green("✓")
					: color.cyan(SPINNER[frame % SPINNER.length] as string);
	const note = racer.status === "needs-input" ? racer.statusDetail : racer.source;
	return `  ${icon} ${pad(racer.agent, width)}  ${pad(racer.status, 13)} ${pad(formatDuration(elapsed), 7)} ${color.dim(note ?? "")}`;
}

async function waitForIdle(options: Options, racers: Racer[]): Promise<void> {
	const tracked = racers.filter((racer) => racer.terminalId);
	if (tracked.length === 0) return;
	log(color.bold("\nWaiting for agents to go idle"));

	const prober = new StatusProber();
	const idleSince = new Map<Racer, number>();
	const deadline = Date.now() + options.timeoutMs;
	const width = Math.max(...racers.map((racer) => racer.agent.length));
	const tty = process.stderr.isTTY;
	let drawn = 0;
	let frame = 0;
	let previous = "";

	const draw = () => {
		const lines = racers.map((racer) => boardLine(racer, width, frame));
		if (tty) {
			if (drawn) process.stderr.write(`\x1b[${drawn}A\x1b[0J`);
			process.stderr.write(`${lines.join("\n")}\n`);
			drawn = lines.length;
			return;
		}
		// Not a terminal: log transitions only.
		const states = racers.map((racer) => `${racer.agent}=${racer.status}`).join(" ");
		if (states !== previous) log(stripAnsi(lines.join("\n")));
		previous = states;
	};

	while (true) {
		const pending = tracked.filter((racer) => racer.elapsedMs === undefined);
		if (pending.length === 0) break;
		if (Date.now() > deadline) {
			for (const racer of pending) {
				const why = racer.statusDetail ? ` (${racer.statusDetail})` : "";
				racer.statusDetail = `still ${racer.status} after ${formatDuration(options.timeoutMs)}${why}`;
				racer.status = "timeout";
			}
			break;
		}

		await Promise.all(
			pending.map(async (racer) => {
				const target = {
					workspaceId: racer.workspaceId as string,
					terminalId: racer.terminalId as string,
				};
				const probe = await prober.probe(target).catch(() => null);
				if (!probe) return;
				racer.status = probe.state;
				racer.source = probe.source;
				racer.statusDetail = undefined;
				const now = Date.now();
				const launchedAt = racer.launchedAt as number;
				// No lifecycle event for a while: an agent usually reports within
				// seconds, so look for a first-run prompt holding it up.
				if (probe.state === "starting" && now - launchedAt >= options.settleMs * 4) {
					const blocker = await prober.blockedOn(target);
					if (blocker) {
						racer.status = "needs-input";
						racer.statusDetail = `stuck on ${blocker}; answer it in Superset`;
					}
				}
				if (probe.state === "idle") {
					const since = idleSince.get(racer) ?? now;
					idleSince.set(racer, since);
					// A still screen is weaker evidence than a Stop hook.
					const settle =
						probe.source === "screen" ? options.settleMs * 2 : options.settleMs;
					if (now - since >= settle) racer.elapsedMs = since - launchedAt;
				} else {
					idleSince.delete(racer);
					if (probe.state === "failed" || probe.state === "exited") {
						racer.elapsedMs = now - launchedAt;
					}
				}
			}),
		);

		// Repaint every second between polls so the clock and spinner move.
		for (let waited = 0; waited < options.pollMs; waited += 1000) {
			draw();
			frame++;
			if (tracked.every((racer) => racer.elapsedMs !== undefined)) break;
			await sleep(Math.min(1000, options.pollMs - waited));
		}
	}
	draw();
}

async function pool<T>(
	items: T[],
	jobs: number,
	work: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: Math.min(jobs, queue.length) }, async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
				await work(item);
			}
		}),
	);
}

const testTotal = (verify: VerifyResult | undefined) =>
	verify?.counts
		? verify.counts.passed + verify.counts.failed + verify.counts.skipped
		: undefined;

/** Name a scored workspace after the agent that raced in it. */
function agentOf(workspace: WorkspaceDetail): string {
	return (
		workspace.name.match(/^(\S+) \(race /)?.[1] ??
		workspace.branch.match(/race\/[^/]+\/([^/]+)$/)?.[1] ??
		workspace.name
	);
}

interface RaceResult {
	runId: string;
	prompt?: string;
	baseRef: string;
	baseSha: string;
	verify: string;
	baseline?: Baseline;
	winner: string | null;
	racers: Racer[];
}

function printScoreboard(result: RaceResult): void {
	const winner = result.racers.find((racer) => racer.agent === result.winner);
	process.stdout.write(`\n${renderTable(result.racers, result.baseline)}\n\n`);
	for (const racer of result.racers) {
		if (racer.statusDetail) log(color.dim(`  ${racer.agent}: ${racer.statusDetail}`));
	}
	if (winner) {
		process.stdout.write(
			[
				`${color.bold("Winner:")} ${winner.agent} on ${winner.branch}`,
				`  open  superset workspaces open ${winner.workspaceId}`,
				`  diff  git -C ${winner.worktreePath} diff ${result.baseSha.slice(0, 12)}`,
				"",
			].join("\n"),
		);
	} else {
		process.stdout.write(`${color.yellow("No winner:")} no agent changed anything.\n`);
	}
}

/** Re-print a finished run from its race.json: same data, same renderer. */
function showRun(ref: string): void {
	const dir = existsSync(join(ref, "race.json"))
		? ref
		: join(homedir(), ".superset-race", ref);
	const file = join(dir, "race.json");
	if (!existsSync(file)) {
		throw new RaceError(`No race.json in ${ref}`, "Pass a run id from ~/.superset-race or a run directory");
	}
	const result = JSON.parse(readFileSync(file, "utf-8")) as RaceResult;
	process.stdout.write(
		`${color.bold("superset-race")} ${color.dim(`run ${result.runId} · base ${result.baseSha.slice(0, 8)} (${result.baseRef})`)}\n`,
	);
	if (result.prompt) process.stdout.write(`${color.dim(`> ${result.prompt}`)}\n`);
	printScoreboard(result);
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	if (!options) {
		process.stdout.write(HELP);
		return;
	}
	if ("show" in options) {
		showRun(options.show);
		return;
	}

	const runId = timestampId();
	const outDir = options.out ?? join(homedir(), ".superset-race", runId);
	mkdirSync(outDir, { recursive: true });

	const racers: Racer[] = [];
	process.on("SIGINT", () => {
		killRunning();
		const ids = racers.flatMap((racer) => racer.workspaceId ?? []);
		log("\nInterrupted.");
		if (ids.length > 0) {
			log(`The agents keep running in Superset. Score them later with:\n  superset-race --score ${ids.join(",")}`);
		}
		process.exit(130);
	});

	if (options.score) {
		for (const id of options.score) {
			const workspace = await getWorkspace(id);
			racers.push({
				agent: agentOf(workspace),
				workspaceId: id,
				branch: workspace.branch,
				worktreePath: workspace.worktreePath,
				status: "not-tracked",
			});
		}
	} else {
		await launch(options, runId, racers);
		await waitForIdle(options, racers);
	}

	const scored = racers.filter((racer) => racer.worktreePath);
	const anyWorktree = scored[0]?.worktreePath;
	if (!anyWorktree) throw new RaceError("No workspace to score: every agent failed to launch");

	const baseRef = options.baseBranch ?? (await defaultBranch(anyWorktree));
	log(color.bold(`\nDiffing against ${baseRef}`));
	for (const racer of scored) {
		racer.diff = await diffStats(racer.worktreePath as string, baseRef);
	}

	const verifyCommand = options.verify ?? detectVerifyCommand(anyWorktree);
	if (!verifyCommand) {
		throw new RaceError("Could not detect how to verify this repo", "Pass --verify <cmd>");
	}
	log(color.bold(`Verifying with: ${verifyCommand}`));

	let baseline: Baseline | undefined;
	const baseSha = scored[0]?.diff?.baseSha as string;
	const verifyTargets: Array<{ name: string; dir: string; racer?: Racer }> = scored.map(
		(racer) => ({ name: racer.agent, dir: racer.worktreePath as string, racer }),
	);
	let removeBaseline: (() => Promise<void>) | undefined;
	if (options.baseline) {
		const dir = join(outDir, "baseline");
		removeBaseline = await addBaselineWorktree(anyWorktree, baseSha, dir);
		verifyTargets.push({ name: "baseline", dir });
	}
	try {
		await pool(verifyTargets, options.jobs, async (target) => {
			const result = await runVerify(
				verifyCommand,
				target.dir,
				join(outDir, `${target.name}.verify.log`),
				options.verifyTimeoutMs,
			);
			if (target.racer) target.racer.verify = result;
			else baseline = { sha: baseSha, verify: result };
			const outcome = result.timedOut
				? color.red("timed out")
				: result.exitCode === 0
					? color.green("pass")
					: color.red(`exit ${result.exitCode}`);
			log(`  ${target.name}: ${outcome} in ${formatDuration(result.durationMs)}`);
		});
	} finally {
		await removeBaseline?.();
	}

	const baselineTotal = testTotal(baseline?.verify);
	for (const racer of scored) {
		const total = testTotal(racer.verify);
		racer.newTests =
			total !== undefined && baselineTotal !== undefined
				? total - baselineTotal
				: racer.diff?.testDefinitionsAdded;
	}

	const ranked = rank(racers);
	const winner = ranked[0]?.diff?.filesChanged ? ranked[0] : undefined;
	const result: RaceResult = {
		runId,
		prompt: options.prompt,
		baseRef,
		baseSha,
		verify: verifyCommand,
		baseline,
		winner: winner?.agent ?? null,
		racers: ranked,
	};
	writeFileSync(join(outDir, "race.json"), `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(
		join(outDir, "scoreboard.md"),
		renderMarkdown(ranked, baseline, options.prompt ?? `(scored ${runId})`),
	);

	if (options.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		printScoreboard(result);
		log(color.dim(`Logs and results: ${outDir}`));
	}

	if (options.cleanup && winner) {
		const losers = ranked.filter((racer) => racer !== winner && racer.workspaceId);
		await deleteWorkspaces(losers.map((racer) => racer.workspaceId as string));
		log(`Deleted ${losers.length} losing workspace(s).`);
	}
}

main().catch((error) => {
	killRunning();
	if (error instanceof RaceError) {
		log(`${color.red("error:")} ${error.message}`);
		if (error.hint) log(`  ${error.hint}`);
	} else {
		log(String(error instanceof Error ? error.stack : error));
	}
	process.exit(1);
});
