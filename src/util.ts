export class RaceError extends Error {
	constructor(
		message: string,
		readonly hint?: string,
	) {
		super(message);
	}
}

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "90s", "15m", "1h", "1h30m", or a bare number of seconds. */
export function parseDuration(value: string): number {
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };
	let total = 0;
	let rest = value;
	for (const match of value.matchAll(/(\d+)([hms])/g)) {
		total += Number(match[1]) * (units[match[2] as string] as number);
		rest = rest.replace(match[0], "");
	}
	if (total === 0 || rest.length > 0) {
		throw new RaceError(`Bad duration "${value}"`, "Use e.g. 90s, 15m, 1h");
	}
	return total;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function timestampId(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const useColor =
	process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code: number) => (text: string) =>
	useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const color = {
	bold: paint(1),
	dim: paint(2),
	red: paint(31),
	green: paint(32),
	yellow: paint(33),
	cyan: paint(36),
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (text: string) => text.replace(ANSI, "");

/** Pads by visible width, so colored cells still line up. */
export function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - stripAnsi(text).length));
}
