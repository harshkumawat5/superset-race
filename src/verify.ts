import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./exec.ts";
import { stripAnsi } from "./util.ts";

export interface TestCounts {
	framework: string;
	passed: number;
	failed: number;
	skipped: number;
}

export interface VerifyResult {
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
	/** null when the output matched no known test-runner summary. */
	counts: TestCounts | null;
	logPath: string;
}

/**
 * A sensible default when --verify is omitted: the project's own `verify`
 * script in .superset/config.json (the key the feature issue proposes,
 * beside setup/teardown/run), else a guess from the repo's tooling.
 */
export function detectVerifyCommand(dir: string): string | null {
	const has = (file: string) => existsSync(join(dir, file));
	if (has(".superset/config.json")) {
		const config = JSON.parse(
			readFileSync(join(dir, ".superset/config.json"), "utf-8"),
		);
		if (Array.isArray(config.verify) && config.verify.length > 0) {
			return config.verify.join(" && ");
		}
	}
	if (has("package.json")) {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
		if (pkg.scripts?.test) {
			if (has("bun.lock") || has("bun.lockb")) return "bun run test";
			if (has("pnpm-lock.yaml")) return "pnpm test";
			if (has("yarn.lock")) return "yarn test";
			return "npm test";
		}
	}
	if (has("pyproject.toml") || has("setup.py") || has("pytest.ini")) {
		return has("uv.lock") ? "uv run pytest -q" : "python -m pytest -q";
	}
	if (has("go.mod")) return "go test -v ./...";
	if (has("Cargo.toml")) return "cargo test";
	return null;
}

export async function runVerify(
	command: string,
	cwd: string,
	logPath: string,
	timeoutMs: number,
): Promise<VerifyResult> {
	const result = await exec("sh", ["-c", command], {
		cwd,
		timeoutMs,
		env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
	});
	writeFileSync(logPath, `$ ${command}\n# cwd: ${cwd}\n\n${result.output}`);
	return {
		exitCode: result.code,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
		counts: parseTestCounts(result.output),
		logPath,
	};
}

type Tally = Omit<TestCounts, "framework">;

const count = (text: string, pattern: RegExp) =>
	Number(text.match(pattern)?.[1] ?? 0);

/** Sum a per-line tally over every match, so monorepo runners add up. */
function sumLines(
	output: string,
	line: RegExp,
	tally: (match: RegExpMatchArray) => Tally,
): Tally | null {
	const matches = [...output.matchAll(line)];
	if (matches.length === 0) return null;
	return matches.map(tally).reduce((a, b) => ({
		passed: a.passed + b.passed,
		failed: a.failed + b.failed,
		skipped: a.skipped + b.skipped,
	}));
}

const PARSERS: Array<[string, (output: string) => Tally | null]> = [
	[
		"pytest",
		(output) =>
			sumLines(
				output,
				/^=*\s*((?:\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|warnings?|deselected|rerun)(?:, )?)+) in [\d.]+s\b.*$/gm,
				([, summary = ""]) => ({
					passed: count(summary, /(\d+) passed/),
					failed:
						count(summary, /(\d+) failed/) + count(summary, /(\d+) errors?/),
					skipped: count(summary, /(\d+) skipped/),
				}),
			),
	],
	[
		"jest",
		(output) =>
			sumLines(output, /^Tests:\s+(.*\d+ total)$/gm, ([, summary = ""]) => ({
				passed: count(summary, /(\d+) passed/),
				failed: count(summary, /(\d+) failed/),
				skipped: count(summary, /(\d+) skipped/),
			})),
	],
	[
		"vitest",
		(output) =>
			sumLines(output, /^\s*Tests\s+(.*)\(\d+\)\s*$/gm, ([, summary = ""]) => ({
				passed: count(summary, /(\d+) passed/),
				failed: count(summary, /(\d+) failed/),
				skipped: count(summary, /(\d+) skipped/),
			})),
	],
	[
		"cargo",
		(output) =>
			sumLines(
				output,
				/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm,
				([, passed, failed, ignored]) => ({
					passed: Number(passed),
					failed: Number(failed),
					skipped: Number(ignored),
				}),
			),
	],
	[
		"bun",
		(output) =>
			sumLines(output, /^\s*(\d+) pass\n\s*(?:(\d+) skip\n\s*)?(\d+) fail$/gm, ([
				,
				passed,
				skipped,
				failed,
			]) => ({
				passed: Number(passed),
				failed: Number(failed),
				skipped: Number(skipped ?? 0),
			})),
	],
	[
		"node:test",
		(output) =>
			sumLines(
				output,
				/^(?:#|ℹ) pass (\d+)\n(?:#|ℹ) fail (\d+)(?:\n(?:#|ℹ) cancelled \d+)?(?:\n(?:#|ℹ) skipped (\d+))?/gm,
				([, passed, failed, skipped]) => ({
					passed: Number(passed),
					failed: Number(failed),
					skipped: Number(skipped ?? 0),
				}),
			),
	],
	[
		"mocha",
		(output) =>
			sumLines(
				output,
				/^\s*(\d+) passing \(.*\)\n(?:\s*(\d+) pending\n)?(?:\s*(\d+) failing)?/gm,
				([, passed, pending, failed]) => ({
					passed: Number(passed),
					failed: Number(failed ?? 0),
					skipped: Number(pending ?? 0),
				}),
			),
	],
	[
		"rspec",
		(output) =>
			sumLines(
				output,
				/^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/gm,
				([, examples, failures, pending]) => ({
					passed: Number(examples) - Number(failures) - Number(pending ?? 0),
					failed: Number(failures),
					skipped: Number(pending ?? 0),
				}),
			),
	],
	[
		"go",
		(output) => {
			const passed = output.match(/^\s*--- PASS:/gm)?.length ?? 0;
			const failed = output.match(/^\s*--- FAIL:/gm)?.length ?? 0;
			const skipped = output.match(/^\s*--- SKIP:/gm)?.length ?? 0;
			return passed + failed + skipped > 0 ? { passed, failed, skipped } : null;
		},
	],
];

export function parseTestCounts(rawOutput: string): TestCounts | null {
	const output = stripAnsi(rawOutput).replace(/\r\n?/g, "\n");
	for (const [framework, parse] of PARSERS) {
		const tally = parse(output);
		if (tally) return { framework, ...tally };
	}
	return null;
}
