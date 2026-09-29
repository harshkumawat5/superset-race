import { expect, test } from "bun:test";
import type { DiffStats } from "../src/git.ts";
import { type Racer, rank, renderMarkdown } from "../src/scoreboard.ts";
import type { VerifyResult } from "../src/verify.ts";

const diff = (insertions: number, filesChanged = 1): DiffStats => ({
	baseSha: "abc123def456",
	filesChanged,
	insertions,
	deletions: 0,
	commits: 0,
	testFiles: [],
	testDefinitionsAdded: 0,
	files: [],
});

const verify = (passed: number, failed: number, exitCode = failed ? 1 : 0): VerifyResult => ({
	exitCode,
	timedOut: false,
	durationMs: 1000,
	counts: { framework: "pytest", passed, failed, skipped: 0 },
	logPath: "/dev/null",
});

const racer = (agent: string, fields: Partial<Racer>): Racer => ({
	agent,
	status: "idle",
	...fields,
});

test("green beats red, then new tests, then smaller diff, then speed", () => {
	const ranked = rank([
		racer("red", { diff: diff(5), verify: verify(10, 1), newTests: 5 }),
		racer("big", { diff: diff(90), verify: verify(12, 0), newTests: 2 }),
		racer("lazy", { diff: diff(0, 0), verify: verify(10, 0), newTests: 0 }),
		racer("small-slow", { diff: diff(10), verify: verify(12, 0), newTests: 2, elapsedMs: 9 }),
		racer("small-fast", { diff: diff(10), verify: verify(12, 0), newTests: 2, elapsedMs: 1 }),
		racer("tested", { diff: diff(40), verify: verify(13, 0), newTests: 3 }),
	]);
	expect(ranked.map((r) => r.agent)).toEqual([
		"tested",
		"small-fast",
		"small-slow",
		"big",
		"red",
		"lazy",
	]);
	expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a launch failure ranks last", () => {
	const ranked = rank([
		racer("broken", { status: "launch-failed" }),
		racer("ok", { diff: diff(3), verify: verify(1, 1) }),
	]);
	expect(ranked.map((r) => r.agent)).toEqual(["ok", "broken"]);
});

test("markdown scoreboard carries the prompt and a baseline row", () => {
	const ranked = rank([racer("claude", { diff: diff(3), verify: verify(747, 0), newTests: 1 })]);
	const markdown = renderMarkdown(
		ranked,
		{ sha: "abc123def456", verify: verify(746, 0) },
		"Fix #379",
	);
	expect(markdown).toContain("> Fix #379");
	expect(markdown).toContain("| 1 | claude | idle | — | 747 passed | +1 | 0 | 1 file +3 −0 |");
	expect(markdown).toContain("| baseline |");
	expect(markdown).toContain("746 passed");
});
