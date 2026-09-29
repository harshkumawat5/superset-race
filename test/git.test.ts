import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffStats, isTestDefinition, isTestPath } from "../src/git.ts";
import { makeRepo, sh } from "./helpers.ts";

describe("diffStats", () => {
	test("counts commits, unstaged edits and untracked files against the fork point", async () => {
		const repo = makeRepo();
		sh(repo, "git checkout -q -b race/x");
		writeFileSync(
			join(repo, "math.ts"),
			"export const add = (a: number, b: number) => a + b;\n",
		);
		sh(repo, "git -c user.email=t@t -c user.name=t commit -qam fix");
		// Uncommitted: one more test case in the existing file, plus a new test file.
		writeFileSync(
			join(repo, "math.test.ts"),
			[
				'import { expect, test } from "bun:test";',
				'import { add } from "./math.ts";',
				'test("adds zero", () => expect(add(2, 0)).toBe(2));',
				'test("adds", () => expect(add(2, 3)).toBe(5));',
				"",
			].join("\n"),
		);
		writeFileSync(
			join(repo, "negative.test.ts"),
			'import { test } from "bun:test";\ntest("negatives", () => {});\n',
		);
		const indexBefore = sh(repo, "git diff --cached --name-only");

		const stats = await diffStats(repo, "main");

		expect(stats.commits).toBe(1);
		expect(stats.filesChanged).toBe(3);
		expect(stats.insertions).toBe(4);
		expect(stats.deletions).toBe(1);
		expect(stats.testFiles.sort()).toEqual(["math.test.ts", "negative.test.ts"]);
		expect(stats.testDefinitionsAdded).toBe(2);
		// The agent's own index is left alone.
		expect(sh(repo, "git diff --cached --name-only")).toBe(indexBefore);
		expect(sh(repo, "git status --porcelain")).toContain("?? negative.test.ts");
	});

	test("reports nothing for an untouched worktree", async () => {
		const repo = makeRepo();
		const stats = await diffStats(repo, "main");
		expect(stats.filesChanged).toBe(0);
		expect(stats.testFiles).toEqual([]);
	});
});

test("isTestPath", () => {
	for (const path of [
		"tests/test_time.py",
		"src/foo.test.ts",
		"pkg/x_test.go",
		"src/__tests__/a.js",
		"spec/models/user_spec.rb",
	]) {
		expect(isTestPath(path)).toBe(true);
	}
	for (const path of ["src/humanize/time.py", "README.md", "src/testing.ts"]) {
		expect(isTestPath(path)).toBe(false);
	}
});

test("isTestDefinition", () => {
	for (const line of [
		"def test_precisedelta_negative():",
		"    async def test_x(client):",
		'  it("works", () => {',
		"test.each(cases)('x', () => {",
		'  test.skip("later", () => {',
		"func TestAdd(t *testing.T) {",
		"    #[test]",
		"    @Test",
		"  it 'renders' do",
	]) {
		expect(isTestDefinition(line)).toBe(true);
	}
	for (const line of ["def helper():", "const it = 1;", "testify(x)"]) {
		expect(isTestDefinition(line)).toBe(false);
	}
});
