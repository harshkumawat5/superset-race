import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sh(cwd: string, command: string): string {
	const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`${command} failed: ${result.stderr}`);
	}
	return result.stdout;
}

export const tempDir = (label: string) =>
	mkdtempSync(join(tmpdir(), `superset-race-${label}-`));

/** A tiny repo with one bun test file, committed on `main`. */
export function makeRepo(): string {
	const repo = tempDir("repo");
	writeFileSync(
		join(repo, "math.ts"),
		"export const add = (a: number, b: number) => a - b; // bug\n",
	);
	writeFileSync(
		join(repo, "math.test.ts"),
		[
			'import { expect, test } from "bun:test";',
			'import { add } from "./math.ts";',
			'test("adds zero", () => expect(add(2, 0)).toBe(2));',
			"",
		].join("\n"),
	);
	sh(
		repo,
		"git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init",
	);
	return repo;
}
