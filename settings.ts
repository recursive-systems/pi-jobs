/** What pi-jobs reads from settings.json: the project's .pi/settings.json first, then the agent dir's. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_THRESHOLD_S = 5;

export interface JobsSettings {
	/** Seconds a command runs in the foreground before it moves to the background (`jobs.threshold`). */
	threshold: number;
	/** Pi's own `shellPath` and `shellCommandPrefix`, which the built-in bash tool honours too. */
	shellPath?: string;
	shellCommandPrefix?: string;
}

function readJson(file: string): Record<string, any> {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; }
}

export function readSettings(cwd: string): JobsSettings {
	const project = readJson(path.join(cwd, ".pi", "settings.json"));
	const agent = readJson(path.join(getAgentDir(), "settings.json"));
	const pick = <T>(get: (s: Record<string, any>) => unknown, ok: (v: unknown) => boolean): T | undefined => {
		for (const s of [project, agent]) { const v = get(s); if (ok(v)) return v as T; }
		return undefined;
	};
	const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
	const isString = (v: unknown) => typeof v === "string" && v.length > 0;
	return {
		threshold: pick<number>(s => s.jobs?.threshold, isNumber) ?? DEFAULT_THRESHOLD_S,
		shellPath: pick<string>(s => s.shellPath, isString),
		shellCommandPrefix: pick<string>(s => s.shellCommandPrefix, isString),
	};
}
