import { spawn } from "node:child_process";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	/** stdout and stderr interleaved in arrival order. */
	output: string;
	timedOut: boolean;
	durationMs: number;
}

export interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

const running = new Set<number>();

/** Kill every process group we started, e.g. on Ctrl-C mid-verify. */
export function killRunning(): void {
	for (const pid of running) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
}

/**
 * Runs a command in its own process group so a timeout takes down the
 * whole tree (test runners love to fork).
 */
export function exec(
	command: string,
	args: string[],
	options: ExecOptions = {},
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid) running.add(child.pid);

		let stdout = "";
		let stderr = "";
		let output = "";
		let timedOut = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk;
			output += chunk;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk;
			output += chunk;
		});

		const timer = options.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {}
				}, options.timeoutMs)
			: undefined;

		child.on("error", (error) => {
			clearTimeout(timer);
			if (child.pid) running.delete(child.pid);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (child.pid) running.delete(child.pid);
			resolve({
				code: code ?? 1,
				stdout,
				stderr,
				output,
				timedOut,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}
