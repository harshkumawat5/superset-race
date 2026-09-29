import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

// superset.ts reads SUPERSET_BIN at import time.
process.env.SUPERSET_BIN = join(import.meta.dir, "mock-superset.ts");
const { StatusProber, stateFromLifecycleEvent } = await import("../src/superset.ts");

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
