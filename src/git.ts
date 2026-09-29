import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec.ts";
import { RaceError } from "./util.ts";

export async function git(
	cwd: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	const result = await exec("git", args, {
		cwd,
		env: env ? { ...process.env, ...env } : undefined,
	});
	if (result.code !== 0) {
		throw new RaceError(
			`git ${args[0]} failed in ${cwd}: ${result.stderr.trim()}`,
		);
	}
	return result.stdout;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--verify", "--quiet", ref], {
		cwd,
	});
	return result.code === 0;
}

/** origin/HEAD's target, else main, else master. */
export async function defaultBranch(cwd: string): Promise<string> {
	const originHead = await exec(
		"git",
		["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
		{ cwd },
	);
	if (originHead.code === 0) return originHead.stdout.trim();
	for (const candidate of ["main", "master"]) {
		if (await refExists(cwd, candidate)) return candidate;
	}
	throw new RaceError(
		`Could not find a default branch in ${cwd}`,
		"Pass --base-branch",
	);
}

export async function mergeBase(cwd: string, baseRef: string): Promise<string> {
	return (await git(cwd, ["merge-base", "HEAD", baseRef])).trim();
}

const TEST_PATH = [
	/(^|\/)(tests?|__tests__|specs?)\//,
	/\.(test|spec)\.[cm]?[jt]sx?$/,
	/(^|\/)test_[^/]*\.py$/,
	/_test\.(py|go)$/,
	/_spec\.rb$/,
	/Tests?\.(java|kt|cs|swift)$/,
];

export const isTestPath = (path: string) =>
	TEST_PATH.some((pattern) => pattern.test(path));

// A line that declares one test case, per common framework.
const TEST_DEFINITION = [
	/^\s*(?:async\s+)?def\s+test\w*\s*\(/, // pytest, unittest
	/^\s*(?:it|test)(?:\.\w+(?:\([^)]*\))?)*\s*\(\s*['"`]/, // jest, vitest, mocha, bun, node:test
	/^\s*func\s+Test\w*\s*\(/, // go
	/^\s*#\[(?:\w+::)*test\]/, // rust
	/^\s*@(?:Test|ParameterizedTest)\b/, // junit
	/^\s*(?:it|specify|test)\s+['"]/, // rspec, minitest
];

export const isTestDefinition = (line: string) =>
	TEST_DEFINITION.some((pattern) => pattern.test(line));

export interface DiffStats {
	baseSha: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	/** Commits the agent made on top of the base. */
	commits: number;
	testFiles: string[];
	/** Net test-case declarations added (added minus removed), from the diff alone. */
	testDefinitionsAdded: number;
	files: Array<{ path: string; insertions: number; deletions: number }>;
}

/**
 * Diff of everything the agent produced — commits, staged, unstaged and
 * untracked files — against the fork point. Staging happens in a copy of
 * the index so the agent's real one is never touched.
 */
export async function diffStats(
	worktree: string,
	baseRef: string,
): Promise<DiffStats> {
	const baseSha = await mergeBase(worktree, baseRef);
	const scratch = mkdtempSync(join(tmpdir(), "superset-race-index-"));
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	try {
		const realIndex = (
			await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
		).trim();
		// Copying keeps git's stat cache, so `add` only rehashes changed files.
		if (existsSync(realIndex)) copyFileSync(realIndex, env.GIT_INDEX_FILE);
		else await git(worktree, ["read-tree", "HEAD"], env);
		await git(worktree, ["add", "--all"], env);
		const numstat = await git(
			worktree,
			["diff", "--cached", "--numstat", "--no-renames", baseSha],
			env,
		);
		const files = numstat
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [added = "0", deleted = "0", ...path] = line.split("\t");
				return {
					path: path.join("\t"),
					// Binary files report "-".
					insertions: Number(added) || 0,
					deletions: Number(deleted) || 0,
				};
			});

		const testFiles = files.map((file) => file.path).filter(isTestPath);
		let testDefinitionsAdded = 0;
		if (testFiles.length > 0) {
			const patch = await git(
				worktree,
				["diff", "--cached", "-U0", "--no-renames", baseSha, "--", ...testFiles],
				env,
			);
			for (const line of patch.split("\n")) {
				if (line.startsWith("+++") || line.startsWith("---")) continue;
				if (line.startsWith("+") && isTestDefinition(line.slice(1))) {
					testDefinitionsAdded++;
				} else if (line.startsWith("-") && isTestDefinition(line.slice(1))) {
					testDefinitionsAdded--;
				}
			}
		}

		const commits = Number(
			(await git(worktree, ["rev-list", "--count", `${baseSha}..HEAD`])).trim(),
		);

		return {
			baseSha,
			filesChanged: files.length,
			insertions: files.reduce((sum, file) => sum + file.insertions, 0),
			deletions: files.reduce((sum, file) => sum + file.deletions, 0),
			commits,
			testFiles,
			testDefinitionsAdded,
			files,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** A detached checkout of `sha` for the baseline verify run; returns a remover. */
export async function addBaselineWorktree(
	repo: string,
	sha: string,
	path: string,
): Promise<() => Promise<void>> {
	await git(repo, ["worktree", "add", "--detach", "--force", path, sha]);
	return async () => {
		await git(repo, ["worktree", "remove", "--force", path]).catch(() => {});
	};
}
