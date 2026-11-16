/**
 * pi-jobs: a Pi agent never sits blocked on a shell command.
 *
 * `bash` runs as usual, but a command still running after a few seconds moves to the background as a
 * job; the session gets one message when it finishes. `jobs` lists, reads, waits for and kills jobs;
 * `/jobs` shows them. See README.md.
 *
 * Jobs live process-wide, keyed by session, because Pi rebuilds extensions on every reload and session
 * switch: a reload keeps the session's jobs; leaving the session (quit, new, resume, fork) stops them,
 * except ones started with `keep: true` (a service that outlives the session).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { bashTool } from "./bash.ts";
import { Jobs, type Job } from "./jobs.ts";
import { jobsTool, report } from "./tool.ts";
import { GLYPH, JobsView } from "./view.ts";

const STATUS_KEY = "jobs";
export const MESSAGE_TYPE = "pi-jobs";
const SHARED = Symbol.for("pi-jobs.v1");
/** The session-liveness v1 registry (see pi-loop's liveness.ts): lets a host see a turn still owns running jobs. */
const LIVENESS = Symbol.for("@agegr/pi-web/session-liveness/v1");
/** How long a job stopped with its session gets to exit on SIGTERM before SIGKILL. */
const SHUTDOWN_GRACE_MS = 1_000;
/** The most job glyphs the status line shows; older ones collapse into `+n`. */
const MAX_GLYPHS = 15;
/** How long a failed or killed job stays in the status line, and a done one leaves a `/jobs` hint (as Claude Code does). */
const LINGER_MS = 30_000;
/** A job's log watched full screen. */
const FULL_SCREEN = { width: "100%", maxHeight: "100%", anchor: "top-left" } as const;

interface Shared { sessions: Map<string, Jobs>; exitHook: boolean }

function shared(): Shared {
	const g = globalThis as any;
	if (!g[SHARED]) g[SHARED] = { sessions: new Map(), exitHook: false } satisfies Shared;
	const s: Shared = g[SHARED];
	if (!s.exitHook) {
		s.exitHook = true;
		// The last resort if Pi exits without a session_shutdown: nothing unkept outlives it.
		process.once("exit", () => { for (const jobs of s.sessions.values()) jobs.killNow(); });
	}
	return s;
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let jobs: Jobs | undefined;
	let unregister: (() => void) | undefined;
	let barMode = false;

	const getJobs = (): Jobs => {
		if (jobs) return jobs;
		// A tool called before session_start: a set of its own, still stopped at exit.
		const id = `pid-${process.pid}`;
		jobs = shared().sessions.get(id) ?? new Jobs(Jobs.dirFor(id));
		shared().sessions.set(id, jobs);
		return jobs;
	};

	pi.registerTool(bashTool(getJobs) as any);
	pi.registerTool(jobsTool(getJobs) as any);

	// ------------------------------------------------------------ completion --
	function announce(job: Job) {
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: report(getJobs(), job), display: true, details: { id: job.id, state: job.state, exitCode: job.exitCode, log: job.log } },
			// Steered in while a turn runs; starts a turn when the session is idle.
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	// In print and JSON mode Pi exits once the agent settles, which would stop its jobs and lose their
	// results: hold the run open until a job the agent is waiting on finishes, and continue with it.
	pi.on("agent_before_settle", async (event: any, c: ExtensionContext) => {
		if (!jobs || (c.mode !== "print" && c.mode !== "json") || !jobs.holding().length) return;
		const own = jobs;
		// Jobs' children are unref'd, so nothing else keeps Node alive here: without this it exits mid-wait.
		const keepAlive = setInterval(() => {}, 60_000);
		let ended: Job | undefined;
		try { ended = await own.waitFor(j => !!j.id && !j.service, Infinity, c.signal); } finally { clearInterval(keepAlive); }
		if (!ended) return;
		return {
			entries: [...event.entries, { type: "custom_message", customType: MESSAGE_TYPE, content: report(own, ended), display: true }],
			continue: true,
		};
	});

	// ------------------------------------------------------------ status --
	// What's going on now, like Claude Code's footer: running jobs, and failed or killed ones for LINGER_MS.
	// A job that finished fine leaves at once, with a `/jobs` hint for LINGER_MS. /jobs keeps them all.
	function nowJobs() {
		const now = Date.now();
		const recent = (j: Job) => !!j.endedAt && now - j.endedAt < LINGER_MS;
		const all = jobs?.list ?? [];
		const list = all.filter(j => j.state === "running" || (j.state !== "done" && recent(j)));
		return { list, shown: list.slice(-MAX_GLYPHS), done: all.filter(j => j.state === "done" && recent(j)).length };
	}

	/** `pick`: the job the status bar's keyboard is on (its symbol inverted, its id and command beside the strip). */
	function statusLine(theme?: any, pick?: number): string {
		const fg = (color: string, t: string) => { try { return theme ? theme.fg(color, t) : t; } catch { return t; } };
		const inv = (t: string) => { try { return theme ? theme.inverse(t) : t; } catch { return t; } };
		const { list, shown, done } = nowJobs();
		const hint = done ? fg("dim", `${list.length ? " · " : ""}${done} done, /jobs`) : "";
		if (!list.length) return `${fg("muted", "jobs")} ${hint || fg("dim", "none")}`;
		const strip = shown.map((j, i) => { const s = fg(GLYPH[j.state].color, GLYPH[j.state].glyph); return i === pick ? inv(s) : s; }).join("");
		const more = list.length > shown.length ? fg("dim", ` +${list.length - shown.length}`) : "";
		const picked = pick !== undefined ? shown[pick] : undefined;
		if (picked) return `${fg("muted", "jobs")} ${strip}${more} ${fg("accent", picked.id)} ${picked.command.split("\n")[0]} ${fg("dim", "· Enter watch")}`;
		return `${fg("muted", "jobs")} ${strip}${more}${hint}`;
	}

	/** Redraw the status line when the next finished job's LINGER_MS runs out. */
	let lingerTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleExpiry() {
		if (lingerTimer) clearTimeout(lingerTimer);
		lingerTimer = undefined;
		const now = Date.now();
		const next = Math.min(...(jobs?.list ?? []).filter(j => j.endedAt && now - j.endedAt < LINGER_MS).map(j => j.endedAt! + LINGER_MS));
		if (!Number.isFinite(next)) return;
		lingerTimer = setTimeout(refreshStatus, next - now + 50);
		lingerTimer.unref?.();
	}

	/** Our row in pi-statusbar (bundled; `statusbar:*` events): the same line. Enter opens /jobs; ←/→ pick a job
	 *  in the strip, and Enter on one opens its output, live. */
	function registerBarItem() {
		pi.events.emit("statusbar:item", {
			id: "jobs",
			order: 25,
			render: (theme: any, width: number, focus?: { item?: number }) => [truncateToWidth(` ${statusLine(theme, focus?.item)}`, width)],
			count: () => nowJobs().shown.length,
			command: (i?: number) => { const j = i !== undefined ? nowJobs().shown[i] : undefined; return j ? `/jobs ${j.id}` : "/jobs"; },
			open: (c: any) => openView(c),
		});
	}

	function refreshStatus() {
		if (!ctx) return;
		registerLiveness();
		scheduleExpiry();
		try {
			if (barMode) { registerBarItem(); return; }
			let theme: any; try { theme = ctx.ui.theme; } catch { /* no UI */ }
			ctx.ui.setStatus(STATUS_KEY, statusLine(theme));
		} catch { /* the session is gone */ }
	}

	pi.events.on("statusbar:ready", () => {
		barMode = true;
		try { ctx?.ui.setStatus(STATUS_KEY, undefined); } catch { /* no UI yet */ }
		refreshStatus();
	});

	// ------------------------------------------------------------ liveness --
	function registerLiveness() {
		if (unregister || !ctx || !jobs) return;
		const registry = (globalThis as any)[LIVENESS];
		if (!registry || registry.version !== 1 || typeof registry.register !== "function") return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const own = jobs;
		try {
			unregister = registry.register({
				name: "pi-jobs",
				sessionId: ctx.sessionManager.getSessionId(),
				...(sessionFile ? { sessionFile } : {}),
				isActive: () => own.holding().length > 0,
			});
		} catch { /* the registry refused it and records that itself */ }
	}

	// ------------------------------------------------------------ /jobs --
	/** The jobs list; Enter on a job (or `watch`) opens its log full screen, and Esc there comes back here
	 *  (or closes, when it was opened on that job). */
	async function openView(c: any, watch?: string) {
		const own = getJobs();
		const deps = {
			jobs: () => own.list,
			lines: (job: Job, n: number) => own.tail(job, n),
			kill: (job: Job) => { job.silent = true; own.kill(job, "killed by you"); },
			clearFinished: () => own.clearFinished(),
			title: path.basename(c.cwd ?? ctx?.cwd ?? process.cwd()),
		};
		const show = (id?: string, select?: string): Promise<string | undefined> => c.ui.custom(
			(tui: any, theme: any, _kb: any, done: (w?: string) => void) => new JobsView(tui, theme, deps, done, id, select),
			{ overlay: true, ...(id ? { overlayOptions: FULL_SCREEN } : {}) });
		if (watch) { await show(watch); return; }
		let last: string | undefined;
		for (;;) {
			const picked = await show(undefined, last);
			if (!picked) return;
			await show(picked);
			last = picked;
		}
	}

	pi.registerCommand("jobs", {
		description: "Background shell jobs: watch their output, kill them, clear finished ones · /jobs <id> watches one",
		handler: async (args: string, c: any) => {
			const own = getJobs();
			const id = args.trim();
			const job = id ? own.list.find(j => j.id === id) : undefined;
			if (id && !job) { c.ui.notify(`no job "${id}"`, "warning"); return; }
			if (c.mode === "tui") return openView(c, job?.id);
			if (job) { c.ui.notify([own.describe(job), ...own.tail(job, 30)].join("\n"), "info"); return; }
			c.ui.notify(own.list.length ? own.list.map(j => own.describe(j)).join("\n") : "No jobs.", "info");
		},
	});

	// ------------------------------------------------------------ lifecycle --
	pi.on("session_start", (_event: any, c: ExtensionContext) => {
		ctx = c;
		const id = c.sessionManager.getSessionId();
		const s = shared();
		jobs = s.sessions.get(id) ?? new Jobs(Jobs.dirFor(id));
		s.sessions.set(id, jobs);
		jobs.onFinished = announce;
		jobs.onChange = refreshStatus;
		for (const job of jobs.unreported.splice(0)) announce(job);
		refreshStatus();
	});

	pi.on("session_shutdown", async (event: { reason?: string }) => {
		unregister?.(); unregister = undefined;
		if (lingerTimer) clearTimeout(lingerTimer);
		lingerTimer = undefined;
		const own = jobs;
		ctx = undefined; jobs = undefined;
		if (!own) return;
		own.onFinished = undefined; own.onChange = undefined;
		// A reload is the same session: its jobs carry on and the new instance reports them.
		if (event.reason === "reload") return;
		for (const [id, j] of shared().sessions) if (j === own) shared().sessions.delete(id);
		const stopping = own.list.filter(j => j.state === "running" && !j.keep);
		for (const job of stopping) { job.silent = true; own.kill(job, "stopped with the session"); }
		await Promise.race([Promise.all(stopping.map(j => j.exited)), new Promise(r => setTimeout(r, SHUTDOWN_GRACE_MS))]);
		own.killNow();
		// Kept jobs' logs stay; the rest go with the session.
		const keep = new Set(own.list.filter(j => j.keep).map(j => j.log));
		try { for (const f of fs.readdirSync(own.dir)) if (!keep.has(path.join(own.dir, f))) fs.rmSync(path.join(own.dir, f), { force: true }); } catch { /* none */ }
		if (!keep.size) try { fs.rmdirSync(own.dir); } catch { /* not empty or gone */ }
	});
}
