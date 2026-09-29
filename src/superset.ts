/**
 * Everything superset-race knows about Superset: a thin wrapper over the
 * `superset` CLI (always `--local --json`), plus agent-status probing.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exec } from "./exec.ts";
import { RaceError } from "./util.ts";

const SUPERSET_HOME_DIR =
	process.env.SUPERSET_HOME_DIR ?? join(homedir(), ".superset");

// The desktop app's shim is only on PATH inside Superset's own terminals.
const SUPERSET_BIN =
	process.env.SUPERSET_BIN ??
	Bun.which("superset") ??
	join(SUPERSET_HOME_DIR, "bin", "superset");

export async function superset<T>(args: string[]): Promise<T> {
	const result = await exec(SUPERSET_BIN, [...args, "--json"]).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				throw new RaceError(
					`Superset CLI not found (${SUPERSET_BIN})`,
					"Install the Superset desktop app (it ships ~/.superset/bin/superset) or the standalone CLI, or set SUPERSET_BIN",
				);
			}
			throw error;
		},
	);
	const label = `superset ${args.slice(0, 2).join(" ")}`;
	if (result.code !== 0) {
		throw new RaceError(
			`${label} failed: ${(result.stderr || result.stdout).trim()}`,
		);
	}
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new RaceError(
			`${label} did not return JSON: ${result.stdout.slice(0, 200)}`,
		);
	}
}

export interface Project {
	id: string;
	name: string;
	path: string;
}

const realPath = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};

/** A project by id, name, or the path of its repo. */
export async function resolveProject(ref: string): Promise<Project> {
	const projects = await superset<Project[]>(["projects", "list", "--local"]);
	const match =
		projects.find((project) => project.id === ref) ??
		projects.find((project) => project.name.toLowerCase() === ref.toLowerCase()) ??
		projects.find((project) => realPath(project.path) === realPath(ref));
	if (!match) {
		const known = projects.map((project) => project.name).join(", ") || "none";
		throw new RaceError(
			`No project "${ref}" on this machine (known: ${known})`,
			"Add the repo in Superset, or: superset projects create",
		);
	}
	return match;
}

interface CreateResult {
	workspace: { id: string };
	agents?: Array<
		| { ok: true; kind: string; sessionId: string; label: string }
		| { ok: false; error: string }
	>;
}

export async function createAgentWorkspace(options: {
	projectId: string;
	name: string;
	branch: string;
	baseBranch?: string;
	agent: string;
	prompt: string;
	tag: string;
}): Promise<{ workspaceId: string; terminalId: string }> {
	const args = [
		"workspaces",
		"create",
		"--local",
		...["--project", options.projectId],
		...["--name", options.name],
		...["--branch", options.branch],
		...["--agent", options.agent],
		...["--prompt", options.prompt],
		...["--tag", options.tag],
	];
	if (options.baseBranch) args.push("--base-branch", options.baseBranch);

	const result = await superset<CreateResult>(args);
	const launch = result.agents?.[0];
	if (!launch?.ok) {
		throw new RaceError(
			`${options.agent} did not launch in workspace ${result.workspace.id}: ${launch ? launch.error : "no agent in the create result"}`,
		);
	}
	return { workspaceId: result.workspace.id, terminalId: launch.sessionId };
}

export interface WorkspaceDetail {
	id: string;
	name: string;
	branch: string;
	worktreePath: string;
}

export function getWorkspace(id: string): Promise<WorkspaceDetail> {
	return superset<WorkspaceDetail>(["workspaces", "get", id, "--local"]);
}

export async function deleteWorkspaces(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await superset(["workspaces", "delete", ...ids, "--local"]);
}

// ── Agent status ────────────────────────────────────────────────────────

export type AgentState =
	| "starting"
	| "working"
	| "needs-input"
	| "idle"
	| "failed"
	| "exited";

export type StatusSource = "terminals.list" | "host" | "screen";

export interface Probe {
	state: AgentState;
	source: StatusSource;
}

/** Superset's normalized lifecycle events (host-service map-event-type.ts). */
export function stateFromLifecycleEvent(event: string | undefined): AgentState {
	switch (event) {
		case "Start":
			return "working";
		case "PermissionRequest":
			return "needs-input";
		case "Stop":
			return "idle";
		case "Failed":
			return "failed";
		case "Detached":
			return "exited";
		default:
			return "starting";
	}
}

interface TerminalSession {
	terminalId: string;
	agentStatus?: { lastEventType: string };
}

interface AgentBinding {
	terminalId: string;
	lastEventType: string;
}

interface HostManifest {
	pid: number;
	endpoint: string;
	authToken: string;
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The running host service on this machine, found the way the CLI finds it. */
export function findLocalHost(): HostManifest | null {
	const home = process.env.SUPERSET_HOME_DIR ?? join(homedir(), ".superset");
	const hostDir = join(home, "host");
	const orgIds = [
		process.env.SUPERSET_ORGANIZATION_ID,
		readJson<{ organizationId?: string }>(join(home, "config.json"))
			?.organizationId,
		...(existsSync(hostDir) ? readdirSync(hostDir) : []),
	].filter((id): id is string => Boolean(id));

	for (const orgId of new Set(orgIds)) {
		const manifest = readJson<HostManifest>(
			join(hostDir, orgId, "manifest.json"),
		);
		if (manifest?.endpoint && manifest.authToken && isAlive(manifest.pid)) {
			return manifest;
		}
	}
	return null;
}

/**
 * Reads agent lifecycle bindings straight from the host service's tRPC
 * router — the same record the workspace board's spinner uses. The CLI does
 * not expose it yet (superset-sh/superset#7007), so this is a stopgap.
 */
async function listAgentBindings(
	host: HostManifest,
	workspaceId: string,
): Promise<AgentBinding[]> {
	const input = encodeURIComponent(JSON.stringify({ json: { workspaceId } }));
	const response = await fetch(
		`${host.endpoint}/trpc/terminalAgents.listByWorkspace?input=${input}`,
		{
			headers: { authorization: `Bearer ${host.authToken}` },
			signal: AbortSignal.timeout(5000),
		},
	);
	if (!response.ok) throw new Error(`host answered ${response.status}`);
	const body = (await response.json()) as {
		result: { data: { json: AgentBinding[] } };
	};
	return body.result.data.json;
}

export interface ProbeTarget {
	workspaceId: string;
	terminalId: string;
}

/**
 * Best available signal, in order:
 *  1. `terminals list` rows carrying `agentStatus` (once #7007 ships)
 *  2. the local host service's terminal-agent bindings
 *  3. screen quiescence via `terminals read` (idle = unchanged screen)
 */
export class StatusProber {
	private host: HostManifest | null | undefined;
	/** Last screen hash per terminal, for the quiescence fallback. */
	private readonly screens = new Map<string, string>();

	async probe(target: ProbeTarget): Promise<Probe> {
		const listed = await superset<{ sessions: TerminalSession[] }>([
			"terminals",
			"list",
			"--workspace",
			target.workspaceId,
			"--local",
		]).catch(() => null);
		const session = listed?.sessions.find(
			(candidate) => candidate.terminalId === target.terminalId,
		);
		if (listed && !session) return { state: "exited", source: "terminals.list" };
		if (session?.agentStatus) {
			return {
				state: stateFromLifecycleEvent(session.agentStatus.lastEventType),
				source: "terminals.list",
			};
		}

		if (this.host === undefined) this.host = findLocalHost();
		if (this.host) {
			const bindings = await listAgentBindings(
				this.host,
				target.workspaceId,
			).catch(() => null);
			if (bindings) {
				const binding = bindings.find(
					(candidate) => candidate.terminalId === target.terminalId,
				);
				return {
					state: stateFromLifecycleEvent(binding?.lastEventType),
					source: "host",
				};
			}
		}

		return this.probeScreen(target);
	}

	private async probeScreen(target: ProbeTarget): Promise<Probe> {
		const snapshot = await superset<{ text: string }>([
			"terminals",
			"read",
			"--workspace",
			target.workspaceId,
			"--terminal",
			target.terminalId,
			"--local",
		]);
		const hash = createHash("sha1").update(snapshot.text).digest("hex");
		const changed = this.screens.get(target.terminalId) !== hash;
		this.screens.set(target.terminalId, hash);
		return { state: changed ? "working" : "idle", source: "screen" };
	}
}
