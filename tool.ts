/** The `jobs` tool: list, read, wait for and kill the session's background jobs. */
import { Type } from "typebox";
import { formatAge, type Job, type Jobs } from "./jobs.ts";
import { shown } from "./bash.ts";

const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 600;
const DEFAULT_TAIL = 20;

export const JOBS_GUIDELINES = [
	"Don't poll jobs or sleep to wait for one: carry on with other work, and react to the [job …] message that arrives when it finishes. Use jobs wait only when nothing else can be done until it ends.",
	"jobs output returns what a job printed since you last read it (or its last lines); jobs kill stops a job and everything it started.",
];

const text = (t: string, details: object = {}, isError = false) => ({ content: [{ type: "text", text: t }], details, ...(isError ? { isError } : {}) });

/** What a finished job says about itself: header, then its last lines. */
export function report(jobs: Jobs, job: Job, lines = 10): string {
	const tail = jobs.tail(job, lines);
	return `[job ${jobs.describe(job)}]\n` + (tail.length ? `${tail.join("\n")}\n` : "(no output)\n") + `Log: ${job.log}`;
}

export function jobsTool(getJobs: () => Jobs) {
	return {
		name: "jobs",
		label: "jobs",
		description: "Background jobs (commands bash moved to the background, or started with background or service): list them, read a job's new output, wait a bounded time for one to finish, or kill one and everything it started.",
		promptSnippet: "Background shell jobs: list, output, wait (bounded), kill",
		promptGuidelines: JOBS_GUIDELINES,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("output"), Type.Literal("wait"), Type.Literal("kill")]),
			id: Type.Optional(Type.String({ description: "Job id (j1, j2, …). Required for output and kill; for wait, omit to wait for any running job." })),
			seconds: Type.Optional(Type.Number({ description: `wait: at most this long (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S})` })),
			lines: Type.Optional(Type.Number({ description: `output: last lines to show when nothing is new (default ${DEFAULT_TAIL})` })),
		}),
		async execute(_id: string, p: { action: "list" | "output" | "wait" | "kill"; id?: string; seconds?: number; lines?: number }, signal?: AbortSignal) {
			const jobs = getJobs();
			const find = (): Job | string => {
				if (!p.id) return `jobs ${p.action} needs an id. ${jobs.list.length ? `Jobs: ${jobs.list.map(j => j.id).join(", ")}` : "There are no jobs."}`;
				return jobs.get(p.id) ?? `No job ${p.id}. ${jobs.list.length ? `Jobs: ${jobs.list.map(j => j.id).join(", ")}` : "There are no jobs."}`;
			};
			if (p.action === "list") {
				if (!jobs.list.length) return text("No jobs.");
				return text(jobs.list.map(j => jobs.describe(j)).join("\n"));
			}
			if (p.action === "output") {
				const job = find();
				if (typeof job === "string") return text(job, {}, true);
				return text(output(jobs, job, p.lines));
			}
			if (p.action === "kill") {
				const job = find();
				if (typeof job === "string") return text(job, {}, true);
				if (job.state !== "running") return text(`${jobs.describe(job)}\n(it had already ended)`);
				job.silent = true;
				jobs.kill(job, "killed by the agent");
				await job.exited;
				return text(report(jobs, job));
			}
			// wait
			const ms = Math.min(Math.max(p.seconds ?? DEFAULT_WAIT_S, 0), MAX_WAIT_S) * 1000;
			let target: Job | undefined;
			if (p.id) {
				const job = find();
				if (typeof job === "string") return text(job, {}, true);
				target = job;
				if (job.state !== "running") { job.silent = true; return text(output(jobs, job, p.lines, true)); }
			} else if (!jobs.running().length) return text("No job is running.");
			const started = Date.now();
			const ended = await jobs.waitFor(j => !!j.id && (target ? j === target : true), ms, signal);
			if (!ended) {
				const still = target ? [target] : jobs.running();
				return text(`Still running after waiting ${formatAge(Date.now() - started)}:\n${still.map(j => jobs.describe(j)).join("\n")}\nA message will arrive when ${still.length > 1 ? "each" : "it"} finishes; carry on with other work.`);
			}
			ended.silent = true;
			return text(output(jobs, ended, p.lines, true));
		},
	};
}

/** New output since the agent last read the job (or, if none, its tail), and how it stands. */
function output(jobs: Jobs, job: Job, lines = DEFAULT_TAIL, ended = false): string {
	const s = shown(jobs, job, job.read);
	let body: string;
	if (s.raw) body = s.text;
	else {
		const tail = jobs.tail(job, Math.max(1, Math.floor(lines)));
		body = tail.length ? `(nothing new; last ${tail.length} lines)\n${tail.join("\n")}` : "(no output)";
	}
	job.read = s.end;
	if (job.state !== "running" && !ended) job.silent = true;
	return `[job ${jobs.describe(job)}]\n${body}`;
}
