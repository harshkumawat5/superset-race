/**
 * Runs the real CLI end to end against test/mock-superset.ts: real git
 * worktrees, scripted agents (test/agents/*.sh), real `bun test` verifies.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function race(args: string[], env: Record<string, string>) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf-8",
		env: {
			...process.env,
			SUPERSET_BIN: join(import.meta.dir, "mock-superset.ts"),
			MOCK_AGENTS_DIR: join(import.meta.dir, "agents"),
			SUPERSET_HOME_DIR: tempDir("no-host"),
			...env,
		},
	});
	if (result.status !== 0) {
		throw new Error(`race exited ${result.status}\n${result.stderr}`);
	}
	return { json: JSON.parse(result.stdout), stderr: result.stderr };
}

const FAST = ["--verify", "bun test", "--settle", "1s", "--poll", "1s", "--json"];

describe("superset-race", () => {
	const repo = makeRepo();
	const mockHome = tempDir("mock-home");
	const env = { MOCK_REPO: repo, MOCK_SUPERSET_HOME: mockHome };

	test("races three agents and ranks them", () => {
		const out = tempDir("out");
		const { json } = race(
			["--project", "demo", "--prompt", "Fix add()", "--agents", "claude,codex,gemini", "--out", out, ...FAST],
			env,
		);

		expect(json.winner).toBe("claude");
		expect(json.baseline.verify.counts).toMatchObject({ passed: 1, failed: 0 });

		const byAgent = Object.fromEntries(
			json.racers.map((racer: { agent: string }) => [racer.agent, racer]),
		);
		expect(byAgent.claude).toMatchObject({
			rank: 1,
			status: "idle",
			source: "terminals.list",
			newTests: 1,
			verify: { exitCode: 0, counts: { passed: 2, failed: 0 } },
			diff: { filesChanged: 2, testFiles: ["math.test.ts"], commits: 0 },
		});
		expect(byAgent.codex).toMatchObject({
			rank: 2,
			newTests: 0,
			verify: { exitCode: 0, counts: { passed: 1, failed: 0 } },
			diff: { filesChanged: 1, testFiles: [], commits: 1 },
		});
		expect(byAgent.gemini).toMatchObject({
			rank: 3,
			newTests: 1,
			verify: { counts: { passed: 0, failed: 2 } },
		});
		expect(byAgent.claude.elapsedMs).toBeGreaterThan(0);

		expect(readFileSync(join(out, "scoreboard.md"), "utf-8")).toContain("> Fix add()");
		expect(readFileSync(join(out, "gemini.verify.log"), "utf-8")).toContain("2 fail");
		// The baseline checkout is cleaned up after verifying.
		expect(existsSync(join(out, "baseline"))).toBe(false);
	}, 60_000);

	test("re-scores existing workspaces and cleans up the losers", () => {
		const { json } = race(
			["--score", "ws-codex-2,ws-gemini-3", "--no-baseline", "--cleanup", "--out", tempDir("out"), ...FAST],
			env,
		);
		expect(json.winner).toBe("codex");
		expect(json.racers.map((racer: { status: string }) => racer.status)).toEqual([
			"not-tracked",
			"not-tracked",
		]);
		// Without a baseline, new tests come from the diff's test declarations.
		expect(json.racers[1]).toMatchObject({ agent: "gemini", newTests: 1 });
		const workspaces = JSON.parse(readFileSync(join(mockHome, "workspaces.json"), "utf-8"));
		expect(Object.keys(workspaces).sort()).toEqual(["ws-claude-1", "ws-codex-2"]);
	}, 60_000);

	test("reports agents that never launch or never finish", () => {
		const { json } = race(
			[
				"--project", "demo", "--prompt", "Fix add()", "--agents", "claude,stuck,nope",
				"--timeout", "6s", "--no-baseline", "--out", tempDir("out"), ...FAST,
			],
			{ ...env, MOCK_SUPERSET_HOME: tempDir("mock-home") },
		);
		const byAgent = Object.fromEntries(
			json.racers.map((racer: { agent: string }) => [racer.agent, racer]),
		);
		expect(byAgent.claude).toMatchObject({ rank: 1, status: "idle" });
		expect(byAgent.stuck).toMatchObject({
			rank: 2,
			status: "timeout",
			statusDetail: "still needs-input after 6s",
		});
		expect(byAgent.nope).toMatchObject({ rank: 3, status: "launch-failed" });
		expect(byAgent.nope.statusDetail).toContain('Unknown agent "nope"');
	}, 60_000);

	test("names the first-run prompt an agent is stuck on", () => {
		const { json } = race(
			[
				"--project", "demo", "--prompt", "Fix add()", "--agents", "untrusted",
				"--timeout", "7s", "--no-baseline", "--out", tempDir("out"), ...FAST,
			],
			{ ...env, MOCK_SUPERSET_HOME: tempDir("mock-home") },
		);
		expect(json.racers[0]).toMatchObject({
			agent: "untrusted",
			status: "timeout",
			statusDetail:
				"still needs-input after 7s (stuck on a folder-trust prompt; answer it in Superset)",
		});
	}, 60_000);

	test("falls back to screen quiescence when the CLI has no agent status", () => {
		const { json } = race(
			["--project", "demo", "--prompt", "Fix add()", "--agents", "codex", "--no-baseline", "--out", tempDir("out"), ...FAST],
			{ ...env, MOCK_SUPERSET_HOME: tempDir("mock-home"), MOCK_NO_AGENT_STATUS: "1" },
		);
		expect(json.racers[0]).toMatchObject({ agent: "codex", status: "idle", source: "screen" });
	}, 60_000);
});
