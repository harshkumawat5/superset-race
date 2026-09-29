import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectVerifyCommand, parseTestCounts } from "../src/verify.ts";
import { tempDir } from "./helpers.ts";

describe("detectVerifyCommand", () => {
	const repoWith = (files: Record<string, string>) => {
		const dir = tempDir("detect");
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(join(dir, path, ".."), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		return dir;
	};

	test("prefers the project's verify script in .superset/config.json", () => {
		const dir = repoWith({
			".superset/config.json": JSON.stringify({ setup: ["bun i"], verify: ["bun run lint", "bun test"] }),
			"package.json": JSON.stringify({ scripts: { test: "jest" } }),
		});
		expect(detectVerifyCommand(dir)).toBe("bun run lint && bun test");
	});

	test("falls back to the repo's tooling", () => {
		expect(detectVerifyCommand(repoWith({ "package.json": '{"scripts":{"test":"x"}}', "pnpm-lock.yaml": "" }))).toBe("pnpm test");
		expect(detectVerifyCommand(repoWith({ "pyproject.toml": "", "uv.lock": "" }))).toBe("uv run pytest -q");
		expect(detectVerifyCommand(repoWith({ "go.mod": "" }))).toBe("go test -v ./...");
		expect(detectVerifyCommand(repoWith({ "README.md": "" }))).toBeNull();
	});
});

describe("parseTestCounts", () => {
	const cases: Array<[string, string, ReturnType<typeof parseTestCounts>]> = [
		[
			"pytest -q, colored",
			"....\n\x1b[32m\x1b[1m746 passed\x1b[0m, \x1b[33m110 skipped\x1b[0m\x1b[32m in 11.52s\x1b[0m",
			{ framework: "pytest", passed: 746, failed: 0, skipped: 110 },
		],
		[
			"pytest verbose with failures and errors",
			"FAILED tests/test_time.py::test_x\n========= 2 failed, 744 passed, 110 skipped, 1 error in 12.01s =========",
			{ framework: "pytest", passed: 744, failed: 3, skipped: 110 },
		],
		[
			"jest, two packages",
			"Tests:       1 failed, 2 skipped, 45 passed, 48 total\n...\nTests:       10 passed, 10 total",
			{ framework: "jest", passed: 55, failed: 1, skipped: 2 },
		],
		[
			"vitest",
			" Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 45 passed | 1 skipped (48)\n   Start at  10:00:00",
			{ framework: "vitest", passed: 45, failed: 2, skipped: 1 },
		],
		[
			"bun test",
			"(fail) bad [6.21ms]\n\n 2 pass\n 1 skip\n 1 fail\n 3 expect() calls\nRan 4 tests across 1 file. [47.00ms]",
			{ framework: "bun", passed: 2, failed: 1, skipped: 1 },
		],
		[
			"node --test",
			"1..3\n# tests 3\n# suites 0\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 0",
			{ framework: "node:test", passed: 1, failed: 1, skipped: 1 },
		],
		[
			"mocha",
			"  45 passing (2s)\n  1 pending\n  2 failing\n",
			{ framework: "mocha", passed: 45, failed: 2, skipped: 1 },
		],
		[
			"cargo, two crates",
			"test result: ok. 45 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out\ntest result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured",
			{ framework: "cargo", passed: 48, failed: 2, skipped: 1 },
		],
		[
			"go test -v",
			"=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\n    --- PASS: TestB/sub (0.00s)\nFAIL",
			{ framework: "go", passed: 2, failed: 1, skipped: 0 },
		],
		[
			"rspec",
			"Finished in 0.5 seconds\n45 examples, 2 failures, 1 pending",
			{ framework: "rspec", passed: 42, failed: 2, skipped: 1 },
		],
		["no recognizable summary", "build ok\ndone", null],
	];

	for (const [name, output, expected] of cases) {
		test(name, () => expect(parseTestCounts(output)).toEqual(expected));
	}
});
