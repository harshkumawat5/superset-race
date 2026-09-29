import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

// superset.ts reads SUPERSET_BIN at import time.
process.env.SUPERSET_BIN = join(import.meta.dir, "mock-superset.ts");
const { StatusProber, blockingPrompt, stateFromLifecycleEvent } = await import("../src/superset.ts");

test("spots the first-run prompts that stop an agent before it starts", () => {
	// Screens captured from real Claude Code 2.1 and Codex 0.158 launches in Superset.
	const claude = [
		"❯ 'claude' '--dangerously-skip-permissions' 'Fix https://github.com/python-humanize/humanize/issues/379'",
		" Accessing workspace:",
		" /Users/me/.superset/worktrees/humanize/race/x/claude",
		" Quick safety check: Is this a project you created or one you trust?",
		" ❯ No, exit",
		"   Yes, I trust this folder",
	].join("\n");
	const codex = [
		"  Folder access",
		"  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.",
		"› 1. Trust and continue",
		"  2. Quit",
	].join("\n");
	expect(blockingPrompt(claude)).toBe("a folder-trust prompt");
	expect(blockingPrompt(codex)).toBe("a folder-trust prompt");
	expect(blockingPrompt("  Hooks need review\n  9 hooks are new or changed.")).toBe("a hook-trust prompt");
	expect(blockingPrompt("⏺ Reading src/humanize/time.py\n✻ Thinking…")).toBeNull();
});

test("lifecycle events map to race states", () => {
	expect(stateFromLifecycleEvent("Start")).toBe("working");
	expect(stateFromLifecycleEvent("PermissionRequest")).toBe("needs-input");
	expect(stateFromLifecycleEvent("Stop")).toBe("idle");
	expect(stateFromLifecycleEvent("Failed")).toBe("failed");
	expect(stateFromLifecycleEvent("Detached")).toBe("exited");
	expect(stateFromLifecycleEvent("Attached")).toBe("starting");
	expect(stateFromLifecycleEvent(undefined)).toBe("starting");
});

describe("StatusProber", () => {
	const mockHome = tempDir("mock-home");
	const supersetHome = tempDir("superset-home");
	const requests: Array<{ url: string; auth: string | null }> = [];
	let lastEventType = "Start";
	let server: ReturnType<typeof Bun.serve>;

	beforeAll(() => {
		// A workspace the mock knows about, whose terminal has no agentStatus
		// in `terminals list` — i.e. today's CLI.
		mkdirSync(join(mockHome, "terminals"), { recursive: true });
		writeFileSync(
			join(mockHome, "workspaces.json"),
			JSON.stringify({
				"ws-1": { id: "ws-1", name: "w", branch: "b", worktreePath: "/tmp", terminalId: "term-1" },
			}),
		);
		writeFileSync(join(mockHome, "terminals", "term-1.screen"), "same screen");
		process.env.MOCK_SUPERSET_HOME = mockHome;
		process.env.MOCK_NO_AGENT_STATUS = "1";

		// A fake host service speaking tRPC + superjson, found via its manifest.
		server = Bun.serve({
			port: 0,
			fetch(request) {
				requests.push({ url: request.url, auth: request.headers.get("authorization") });
				return Response.json({
					result: {
						data: {
							json: [{ terminalId: "term-1", workspaceId: "ws-1", lastEventType }],
						},
					},
				});
			},
		});
		mkdirSync(join(supersetHome, "host", "org-1"), { recursive: true });
		writeFileSync(
			join(supersetHome, "host", "org-1", "manifest.json"),
			JSON.stringify({
				pid: process.pid,
				endpoint: `http://127.0.0.1:${server.port}`,
				authToken: "host-secret",
				organizationId: "org-1",
			}),
		);
		process.env.SUPERSET_HOME_DIR = supersetHome;
	});

	afterAll(() => {
		server.stop(true);
		delete process.env.MOCK_NO_AGENT_STATUS;
		delete process.env.SUPERSET_HOME_DIR;
	});

	test("falls back to the host service's agent bindings", async () => {
		const prober = new StatusProber();
		const target = { workspaceId: "ws-1", terminalId: "term-1" };

		expect(await prober.probe(target)).toEqual({ state: "working", source: "host" });
		lastEventType = "Stop";
		expect(await prober.probe(target)).toEqual({ state: "idle", source: "host" });

		const request = requests.at(-1);
		expect(request?.auth).toBe("Bearer host-secret");
		const url = new URL(request?.url as string);
		expect(url.pathname).toBe("/trpc/terminalAgents.listByWorkspace");
		expect(JSON.parse(url.searchParams.get("input") as string)).toEqual({
			json: { workspaceId: "ws-1" },
		});
	});

	test("falls back to screen quiescence when no host is reachable", async () => {
		process.env.SUPERSET_HOME_DIR = tempDir("no-host");
		const prober = new StatusProber();
		const target = { workspaceId: "ws-1", terminalId: "term-1" };
		expect(await prober.probe(target)).toEqual({ state: "working", source: "screen" });
		expect(await prober.probe(target)).toEqual({ state: "idle", source: "screen" });
		writeFileSync(join(mockHome, "terminals", "term-1.screen"), "new output");
		expect(await prober.probe(target)).toEqual({ state: "working", source: "screen" });
	});
});
