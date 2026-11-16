/**
 * The `bash` override. Same parameters, result text, details and renderer as Pi's built-in tool, plus:
 * a command still running after the threshold moves to the background as a job and the call returns
 * at once with its id, log and output so far. `background: true` skips the wait.
 */
import * as fs from "node:fs";
import { Type } from "typebox";
import {
	createBashToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getShellConfig, truncateTail,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatAge, type Job, type Jobs } from "./jobs.ts";
import { readSettings } from "./settings.ts";

const MAX_TIMEOUT_S = 2_147_483_647 / 1000;
/** Output limit of `structuredContent.output`, the same as the built-in tool's. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const UPDATE_MS = 250;

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout). Also applies once the command is a background job." })),
	threshold: Type.Optional(Type.Number({ description: "Seconds to wait before a still-running command moves to the background as a job (default 5, or jobs.threshold in settings)" })),
	background: Type.Optional(Type.Boolean({ description: "Start as a background job right away, without waiting for the threshold: for something long whose result you want (a build, a test run). It reports when it finishes, like any job" })),
	service: Type.Optional(Type.Boolean({ description: "Start right away as a service: a server or watcher nobody waits on. It never holds the session open" })),
	keep: Type.Optional(Type.Boolean({ description: "With service: keep it running after this Pi session ends" })),
});

/** The built-in result for programmatic callers, plus the job a command became. `exit_code` is absent while it runs. */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Optional(Type.Number({ description: "Absent while the command runs on as a job" })),
	wall_time_seconds: Type.Number(),
	job: Type.Optional(Type.String({ description: "The job id, when the command moved to the background" })),
	log: Type.Optional(Type.String({ description: "The job's log file" })),
});

export const BASH_GUIDELINES = [
	"A bash command still running after a few seconds moves to the background as a job (j1, j2, …) and bash returns its id and output so far. Don't sleep, poll or re-run it: carry on with other work, and a message arrives when the job finishes.",
	"Use bash with background: true to start something you know is long (a build, a test run) without waiting for the threshold; its result arrives as a message like any job's. Give it a timeout if it could hang.",
	"Use bash with service: true for servers and watchers that never finish on their own; they don't hold the session open. Add keep: true only if a service must outlive this Pi session; every other job is stopped when the session ends.",
];

/** Pi's own env for commands: its shell env, with this session's PI_* variables. */
function commandEnv(ctx: ExtensionContext | undefined): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const k of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[k];
	if (ctx) {
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile();
		if (file) env.PI_SESSION_FILE = file;
		if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	return env;
}

function seconds(v: number | undefined, what: string): number | undefined {
	if (v === undefined) return undefined;
	if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid ${what}: must be a finite number of seconds`);
	if (v > MAX_TIMEOUT_S) throw new Error(`Invalid ${what}: maximum is ${MAX_TIMEOUT_S} seconds`);
	return v;
}

/** A job's log as the built-in tool shows output: the tail, with a note on where the rest is. */
export function shown(jobs: Jobs, job: Job, from = 0) {
	const { text, end, skipped } = jobs.read(job, from, STRUCTURED_OUTPUT_MAX_BYTES);
	const t = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let out = t.content;
	const truncated = t.truncated || skipped > 0;
	if (truncated) {
		const range = t.truncated ? `lines ${t.totalLines - t.outputLines + 1}-${t.totalLines} of ${t.totalLines}` : `the last ${formatSize(text.length)}`;
		out += `\n\n[Showing ${range}${skipped ? " (of what's new)" : ""}. Full output: ${job.log}]`;
	}
	return { text: out, raw: text, end, truncated, truncation: t.truncated ? t : undefined };
}

export function bashTool(getJobs: () => Jobs) {
	const builtin = createBashToolDefinition(process.cwd());
	return {
		name: "bash",
		label: "bash",
		description: `${builtin.description} A command still running after a few seconds (threshold) moves to the background as a job and the call returns at once with its id and output so far; the session gets a message when it finishes.`,
		promptSnippet: builtin.promptSnippet,
		promptGuidelines: [...(builtin.promptGuidelines ?? []), ...BASH_GUIDELINES],
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: builtin.constrainedSampling,
		async execute(_id: string, params: { command: string; timeout?: number; threshold?: number; background?: boolean; service?: boolean; keep?: boolean },
			signal: AbortSignal | undefined, onUpdate: ((r: any) => void) | undefined, ctx: ExtensionContext) {
			const jobs = getJobs();
			const cwd = ctx?.cwd || process.cwd();
			const settings = readSettings(cwd);
			const timeout = seconds(params.timeout, "timeout");
			const threshold = seconds(params.threshold, "threshold") ?? settings.threshold;
			if (signal?.aborted) throw new Error("Command aborted");
			// A kept job outlives the session, so it can't be what the session waits for: keep makes it a service.
			const service = !!(params.service || params.keep);
			const now = service || !!params.background;
			const shell = getShellConfig(settings.shellPath) as { shell: string; args: string[]; commandTransport?: string };
			const job = jobs.start({
				command: params.command,
				script: settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${params.command}` : params.command,
				cwd, env: commandEnv(ctx), shell: shell.shell, shellArgs: shell.args, stdin: shell.commandTransport === "stdin",
				timeoutMs: timeout === undefined ? undefined : timeout * 1000,
				service,
				keep: !!params.keep,
			});

			if (!now) {
				onUpdate?.({ content: [], details: undefined });
				let size = 0;
				const ticker = setInterval(() => {
					const now = jobs.size(job);
					if (!onUpdate || now === size) return;
					size = now;
					const s = shown(jobs, job);
					onUpdate({ content: [{ type: "text", text: s.raw ? s.text : "" }], details: s.truncated ? { truncation: s.truncation, fullOutputPath: job.log } : undefined });
				}, UPDATE_MS);
				let onAbort = () => {};
				let waitTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						job.exited,
						new Promise<void>(r => { waitTimer = setTimeout(r, threshold * 1000); }),
						new Promise<void>(r => { onAbort = r; signal?.addEventListener("abort", r, { once: true }); }),
					]);
				} finally {
					clearInterval(ticker);
					if (waitTimer) clearTimeout(waitTimer);
					signal?.removeEventListener("abort", onAbort);
				}
				if (!job.endedAt && signal?.aborted) {
					jobs.kill(job, "aborted");
					await job.exited;
					throw new Error(appendStatus(shown(jobs, job).text, "Command aborted"));
				}
				if (job.endedAt) return finished(jobs, job, timeout);
			}

			jobs.promote(job);
			const s = shown(jobs, job);
			job.read = s.end;
			const how = service ? "Started as a service" : params.background ? "Started in the background" : `Still running after ${formatAge(Date.now() - job.startedAt)}: moved to the background`;
			const note = `[${how} as job ${job.id}${job.keep ? " (kept after this session ends)" : ""}. Log: ${job.log}. ` +
				(service ? "It doesn't hold the session open; a message arrives if it ends. " : "A message will arrive when it finishes; carry on meanwhile, or end your turn if nothing else needs doing. ") +
				"jobs reads its output, waits for it or kills it.]";
			return {
				content: [{ type: "text", text: appendStatus(s.raw ? s.text : "", note) }],
				details: s.truncated ? { truncation: s.truncation, fullOutputPath: job.log } : undefined,
				structuredContent: {
					output: s.raw, truncated: s.truncated, ...(s.truncated ? { full_output_path: job.log } : {}),
					wall_time_seconds: Math.round((Date.now() - job.startedAt) / 100) / 10, job: job.id, log: job.log,
				},
			};
		},
	};
}

function appendStatus(text: string, status: string) {
	return `${text ? `${text}\n\n` : ""}${status}`;
}

/** A command that ended inside the foreground window, reported exactly as the built-in tool reports it. */
function finished(jobs: Jobs, job: Job, timeout: number | undefined) {
	const s = shown(jobs, job);
	if (!s.truncated) fs.rm(job.log, () => {});
	if (job.why?.startsWith("timed out")) throw new Error(appendStatus(s.raw ? s.text : "", `Command timed out after ${timeout} seconds`));
	const exitCode = job.exitCode ?? 1;
	const text = s.raw ? s.text : "(no output)";
	const details = s.truncated ? { truncation: s.truncation, fullOutputPath: job.log } : undefined;
	const structuredContent = {
		output: s.raw, truncated: s.truncated, ...(s.truncated ? { full_output_path: job.log } : {}),
		exit_code: exitCode, wall_time_seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10,
	};
	if (exitCode !== 0) return { content: [{ type: "text", text: appendStatus(text, `Command exited with code ${exitCode}`) }], details, structuredContent, isError: true };
	return { content: [{ type: "text", text }], details, structuredContent };
}
