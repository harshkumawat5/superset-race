#!/usr/bin/env bun
/**
 * A stand-in for the `superset` CLI, just enough of it for superset-race:
 * real git worktrees, and fake agents that run a script from
 * $MOCK_AGENTS_DIR/<agent>.sh while reporting Superset's lifecycle events.
 *
 *   MOCK_SUPERSET_HOME    state directory (required)
 *   MOCK_REPO             repo backing the single project "demo"
 *   MOCK_AGENTS_DIR       <agent>.sh scripts; exit 3 = agent asks for permission
 *   MOCK_NO_AGENT_STATUS  omit agentStatus from `terminals list` (pre-#7007 CLI)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.MOCK_SUPERSET_HOME as string;
const repo = process.env.MOCK_REPO as string;
const agentsDir = process.env.MOCK_AGENTS_DIR as string;
mkdirSync(join(home, "terminals"), { recursive: true });

interface Workspace {
	id: string;
	name: string;
	branch: string;
	worktreePath: string;
	terminalId: string;
}

const dbPath = join(home, "workspaces.json");
const load = (): Record<string, Workspace> =>
	existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf-8")) : {};
const save = (db: Record<string, Workspace>) =>
	writeFileSync(dbPath, JSON.stringify(db, null, 2));

const BOOLEAN_FLAGS = new Set(["local", "json"]);
const argv = process.argv.slice(2);
const positionals: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i] as string;
	if (!arg.startsWith("--")) {
		positionals.push(arg);
		continue;
	}
	const name = arg.slice(2);
	flags[name] = BOOLEAN_FLAGS.has(name) ? "true" : (argv[++i] as string);
}

const out = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
const fail = (message: string): never => {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
};

const terminalFile = (terminalId: string, kind: "status" | "screen") =>
	join(home, "terminals", `${terminalId}.${kind}`);

async function runFakeAgent(terminalId: string, worktree: string, agent: string) {
	const emit = (lastEventType: string) =>
		writeFileSync(
			terminalFile(terminalId, "status"),
			JSON.stringify({ lastEventType, lastEventAt: Date.now() }),
		);
	const screen = (text: string) => writeFileSync(terminalFile(terminalId, "screen"), text);
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	emit("Attached");
	screen(`${agent} booting`);
	await sleep(300);
	emit("Start");
	let tick = 0;
	const ticker = setInterval(() => screen(`${agent} working ${tick++}`), 200);
	const script = join(agentsDir, `${agent}.sh`);
	const result = spawnSync("sh", [script], { cwd: worktree, stdio: "ignore" });
	await sleep(Number(process.env.MOCK_AGENT_WORK_MS ?? 500));
	clearInterval(ticker);
	screen(`${agent} done — waiting for input`);
	emit(result.status === 3 ? "PermissionRequest" : "Stop");
}

const [group, command] = positionals;
const db = load();

if (group === "__agent") {
	await runFakeAgent(command as string, positionals[2] as string, positionals[3] as string);
	process.exit(0);
}

switch (`${group} ${command ?? ""}`.trim()) {
	case "auth whoami":
		out({ email: "demo@example.com" });
		break;
	case "status":
		out({ running: true });
		break;
	case "projects create":
		out({ id: "proj-demo", name: flags.name });
		break;
	case "workspaces list":
		out(Object.values(db).map(({ id, name, branch }) => ({ id, name, branch, tags: "race" })));
		break;
	case "projects list":
		out([{ name: "demo", repo: "-", path: repo, id: "proj-demo" }]);
		break;
	case "workspaces create": {
		if (flags.project !== "proj-demo") fail(`unknown project ${flags.project}`);
		const agent = flags.agent as string;
		const id = `ws-${agent}-${Object.keys(db).length + 1}`;
		const branch = flags.branch as string;
		const worktreePath = join(home, "worktrees", id);
		const add = spawnSync(
			"git",
			["worktree", "add", "-q", "-b", branch, worktreePath, flags["base-branch"] ?? "HEAD"],
			{ cwd: repo, encoding: "utf-8" },
		);
		if (add.status !== 0) fail(add.stderr);
		if (!existsSync(join(agentsDir, `${agent}.sh`))) {
			out({ workspace: { id }, terminals: [], agents: [{ ok: false, error: `Unknown agent "${agent}"` }] });
			break;
		}
		const terminalId = `term-${id}`;
		db[id] = { id, name: flags.name as string, branch, worktreePath, terminalId };
		save(db);
		spawn(process.execPath, [import.meta.path, "__agent", terminalId, worktreePath, agent], {
			detached: true,
			stdio: "ignore",
			env: process.env,
		}).unref();
		out({
			workspace: { id, name: flags.name, branch },
			terminals: [],
			agents: [{ ok: true, kind: "terminal", sessionId: terminalId, label: agent }],
			alreadyExists: false,
			txid: null,
		});
		break;
	}
	case "workspaces get": {
		const workspace = db[positionals[2] as string] ?? fail("no such workspace");
		out({ ...workspace, type: "worktree", projectId: "proj-demo", worktreeExists: true });
		break;
	}
	case "workspaces delete": {
		const deleted = positionals.slice(2);
		for (const id of deleted) {
			const workspace = db[id] ?? fail(`no such workspace ${id}`);
			spawnSync("git", ["worktree", "remove", "--force", workspace.worktreePath], { cwd: repo });
			delete db[id];
		}
		save(db);
		out({ deleted, warnings: [] });
		break;
	}
	case "terminals list": {
		const workspace = db[flags.workspace as string] ?? fail("no such workspace");
		const statusPath = terminalFile(workspace.terminalId, "status");
		const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf-8")) : null;
		const withStatus = status && !process.env.MOCK_NO_AGENT_STATUS;
		out({
			sessions: [
				{
					terminalId: workspace.terminalId,
					workspaceId: workspace.id,
					exited: false,
					...(withStatus ? { agentStatus: { agentId: "mock", startedAt: 0, ...status } } : {}),
				},
			],
		});
		break;
	}
	case "terminals read": {
		const screenPath = terminalFile(flags.terminal as string, "screen");
		out({ text: existsSync(screenPath) ? readFileSync(screenPath, "utf-8") : "" });
		break;
	}
	default:
		fail(`mock does not implement: ${positionals.join(" ")}`);
}
