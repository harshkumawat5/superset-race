import type { DiffStats } from "./git.ts";
import type { AgentState, StatusSource } from "./superset.ts";
import { color, formatDuration, pad } from "./util.ts";
import type { TestCounts, VerifyResult } from "./verify.ts";

export interface Racer {
	agent: string;
	workspaceId?: string;
	terminalId?: string;
	branch?: string;
	worktreePath?: string;
	launchedAt?: number;
	/** Last observed agent state, or why the racer never got going. */
	status: AgentState | "timeout" | "launch-failed" | "not-tracked";
	statusDetail?: string;
	source?: StatusSource;
	/** Launch → first moment it went (and stayed) idle. */
	elapsedMs?: number;
	diff?: DiffStats;
	verify?: VerifyResult;
	/** Test cases vs the baseline run, else net declarations in the diff. */
	newTests?: number;
	rank?: number;
}

export interface Baseline {
	sha: string;
	verify: VerifyResult;
}

/**
 * Lower is better, compared left to right:
 * did something → verify green → fewer failures → more new tests →
 * more passing → smaller diff → faster.
 */
function sortKey(racer: Racer): number[] {
	const green = racer.verify?.exitCode === 0 && !racer.verify.timedOut;
	const failed =
		racer.verify?.counts?.failed ?? (green ? 0 : Number.POSITIVE_INFINITY);
	return [
		racer.diff && racer.diff.filesChanged > 0 ? 0 : 1,
		green ? 0 : 1,
		failed,
		-(racer.newTests ?? 0),
		-(racer.verify?.counts?.passed ?? 0),
		racer.diff
			? racer.diff.insertions + racer.diff.deletions
			: Number.POSITIVE_INFINITY,
		racer.elapsedMs ?? Number.POSITIVE_INFINITY,
	];
}

export function rank(racers: Racer[]): Racer[] {
	const sorted = [...racers].sort((a, b) => {
		const [ka, kb] = [sortKey(a), sortKey(b)];
		for (let i = 0; i < ka.length; i++) {
			const [x, y] = [ka[i] as number, kb[i] as number];
			if (x !== y) return x < y ? -1 : 1;
		}
		return 0;
	});
	sorted.forEach((racer, index) => {
		racer.rank = index + 1;
	});
	return sorted;
}

function testsCell(verify: VerifyResult | undefined, plain: boolean): string {
	if (!verify) return "—";
	if (verify.timedOut) return plain ? "timed out" : color.red("timed out");
	const counts: TestCounts | null = verify.counts;
	if (!counts) {
		const exit = `exit ${verify.exitCode}`;
		if (plain) return exit;
		return verify.exitCode === 0 ? color.green(exit) : color.red(exit);
	}
	const passed = `${counts.passed} passed`;
	const failed = counts.failed > 0 ? ` ${counts.failed} failed` : "";
	if (plain) return passed + failed;
	return color.green(passed) + color.red(failed);
}

function newTestsCell(racer: Racer): string {
	if (racer.newTests === undefined) return "—";
	return racer.newTests > 0 ? `+${racer.newTests}` : String(racer.newTests);
}

function diffCell(diff: DiffStats | undefined, plain: boolean): string {
	if (!diff) return "—";
	if (diff.filesChanged === 0) return "no changes";
	const files = `${diff.filesChanged} file${diff.filesChanged === 1 ? "" : "s"}`;
	const plus = `+${diff.insertions}`;
	const minus = `−${diff.deletions}`;
	return plain
		? `${files} ${plus} ${minus}`
		: `${files} ${color.green(plus)} ${color.red(minus)}`;
}

function statusCell(racer: Racer, plain: boolean): string {
	const text = racer.status;
	if (plain) return text;
	if (racer.status === "idle") return color.green(text);
	if (racer.status === "not-tracked") return color.dim(text);
	return color.yellow(text);
}

function rows(racers: Racer[], baseline: Baseline | undefined, plain: boolean) {
	const body = racers.map((racer) => [
		String(racer.rank ?? ""),
		racer.agent,
		statusCell(racer, plain),
		formatDuration(racer.elapsedMs),
		testsCell(racer.verify, plain),
		newTestsCell(racer),
		racer.diff ? String(racer.diff.testFiles.length) : "—",
		diffCell(racer.diff, plain),
	]);
	if (baseline) {
		body.push([
			"",
			plain ? "baseline" : color.dim("baseline"),
			"",
			"",
			testsCell(baseline.verify, plain),
			"",
			"",
			plain ? baseline.sha.slice(0, 8) : color.dim(baseline.sha.slice(0, 8)),
		]);
	}
	return body;
}

const HEADERS = [
	"#",
	"AGENT",
	"STATUS",
	"TIME",
	"TESTS",
	"NEW TESTS",
	"TEST FILES",
	"DIFF",
];

export function renderTable(racers: Racer[], baseline?: Baseline): string {
	const body = rows(racers, baseline, false);
	const widths = HEADERS.map((header, column) =>
		Math.max(
			header.length,
			...rows(racers, baseline, true).map((row) => (row[column] as string).length),
		),
	);
	const line = (cells: string[]) =>
		`  ${cells.map((cell, column) => pad(cell, widths[column] as number)).join("  ")}`.trimEnd();
	return [line(HEADERS.map((header) => color.bold(header))), ...body.map(line)].join(
		"\n",
	);
}

export function renderMarkdown(
	racers: Racer[],
	baseline: Baseline | undefined,
	prompt: string,
): string {
	const body = rows(racers, baseline, true);
	const quoted = prompt
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return [
		quoted,
		"",
		`| ${HEADERS.join(" | ")} |`,
		`| ${HEADERS.map(() => "---").join(" | ")} |`,
		...body.map((row) => `| ${row.join(" | ")} |`),
		"",
	].join("\n");
}
