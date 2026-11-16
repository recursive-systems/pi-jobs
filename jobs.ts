/**
 * Jobs: shell commands with one log file each, in a per-session folder.
 *
 * A command starts as a foreground run (no id). If it is still going when the bash tool stops waiting,
 * `promote` gives it an id (j1, j2, …) and it carries on as a job. The shell writes straight to its log
 * file (not through a pipe), so a job's output never depends on this process staying alive, and a kept
 * job keeps logging after Pi exits. Every command runs in its own process group so a kill reaches
 * everything it started.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { constants as osConstants } from "node:os";

export type JobState = "running" | "done" | "failed" | "killed";

export interface Job {
	/** "j1", "j2", …; empty while the command is still in the bash tool's foreground window. */
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	log: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	state: JobState;
	/** Why it ended other than by itself: "timed out after 30s", "killed by the agent", "killed by you", … */
	why?: string;
	/** Started with background and keep: outlives the session and doesn't hold it. */
	keep: boolean;
	/** Bytes of the log the agent has already been shown. */
	read: number;
	/** The agent knows how it ended (it killed it, or a wait returned it): no completion message. */
	silent: boolean;
	exited: Promise<void>;
}

export interface StartOptions {
	command: string;
	/** What actually runs (the command with any shell prefix). */
	script: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: string;
	shellArgs: string[];
	/** The shell reads the script from stdin instead of an argument. */
	stdin?: boolean;
	timeoutMs?: number;
	keep: boolean;
}

/** A listener for a job's end; returning true claims it (the caller reports it, so nobody else does). */
type ExitHook = (job: Job) => boolean;

const KILL_GRACE_MS = 2_000;

export function formatAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class Jobs {
	readonly list: Job[] = [];
	private seq = 0;
	private runs = 0;
	private hooks = new Set<ExitHook>();
	/** Called for a finished job nobody claimed and the agent doesn't already know about. */
	onFinished?: (job: Job) => void;
	/** Called whenever a job starts, moves to the background, ends or is cleared. */
	onChange?: () => void;

	constructor(readonly dir: string) {}

	static dirFor(sessionId: string): string {
		return path.join(os.tmpdir(), `pi-jobs-${os.userInfo().username}`, sessionId.replace(/[^\w.-]/g, "_"));
	}

	start(o: StartOptions): Job {
		if (!fs.existsSync(o.cwd)) throw new Error(`Working directory does not exist: ${o.cwd}\nCannot execute bash commands.`);
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const log = path.join(this.dir, `run-${++this.runs}.log`);
		const fd = fs.openSync(log, "w", 0o600);
		let resolveExit!: () => void;
		const job: Job = {
			id: "", command: o.command, cwd: o.cwd, log, startedAt: Date.now(), state: "running", keep: o.keep,
			read: 0, silent: false, exited: new Promise(r => { resolveExit = r; }),
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (exitCode: number) => {
			if (job.endedAt) return;
			if (timer) clearTimeout(timer);
			job.endedAt = Date.now();
			job.exitCode = exitCode;
			job.state = job.why ? (job.why.startsWith("timed out") ? "failed" : "killed") : exitCode === 0 ? "done" : "failed";
			let claimed = false;
			for (const hook of [...this.hooks]) claimed = hook(job) || claimed;
			if (job.id && !claimed && !job.silent) this.onFinished?.(job);
			resolveExit();
			this.onChange?.();
		};
		try {
			const child = spawn(o.shell, o.stdin ? o.shellArgs : [...o.shellArgs, o.script], {
				cwd: o.cwd, env: o.env, detached: process.platform !== "win32", stdio: [o.stdin ? "pipe" : "ignore", fd, fd], windowsHide: true,
			});
			if (o.stdin) { child.stdin?.on("error", () => {}); child.stdin?.end(o.script); }
			job.pid = child.pid;
			child.once("error", err => { fs.appendFileSync(log, `\n${err.message}\n`); finish(127); });
			child.once("exit", (code, signal) => finish(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)));
			// Pi keeps running whatever its jobs do; a kept job must not hold the event loop open either.
			child.unref();
		} finally {
			fs.closeSync(fd);
		}
		if (o.timeoutMs !== undefined) {
			timer = setTimeout(() => this.kill(job, `timed out after ${o.timeoutMs! / 1000}s`), o.timeoutMs);
			timer.unref?.();
		}
		return job;
	}

	/** The command outlived the foreground window: give it an id and track it as a job. */
	promote(job: Job): Job {
		job.id = `j${++this.seq}`;
		const log = path.join(this.dir, `${job.id}.log`);
		try { fs.renameSync(job.log, log); job.log = log; } catch { /* keep the run's name */ }
		this.list.push(job);
		this.onChange?.();
		return job;
	}

	get(id: string): Job | undefined {
		return this.list.find(j => j.id === id);
	}

	running(): Job[] {
		return this.list.filter(j => j.state === "running");
	}

	/** Running jobs that the session should count as its own outstanding work. */
	holding(): Job[] {
		return this.list.filter(j => j.state === "running" && !j.keep);
	}

	/** Stop a command and everything it started (its process group): TERM, then KILL after a grace period. */
	kill(job: Job, why: string): void {
		if (job.state !== "running" || !job.pid) return;
		job.why ??= why;
		const signal = (s: NodeJS.Signals) => {
			try { process.kill(process.platform === "win32" ? job.pid! : -job.pid!, s); } catch { /* already gone */ }
		};
		signal("SIGTERM");
		const t = setTimeout(() => { if (job.state === "running") signal("SIGKILL"); }, KILL_GRACE_MS);
		t.unref?.();
	}

	/** Synchronous last resort when this process exits: whatever isn't kept dies with it. */
	killNow(): void {
		for (const job of this.list) if (job.state === "running" && !job.keep && job.pid) {
			try { process.kill(-job.pid, "SIGKILL"); } catch { /* already gone */ }
		}
	}

	/** Wait until a job matching `match` ends (resolving to it) or `ms` passes (undefined). Claims what it returns. */
	waitFor(match: (job: Job) => boolean, ms: number, signal?: AbortSignal): Promise<Job | undefined> {
		return new Promise(resolve => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (job: Job | undefined) => {
				this.hooks.delete(hook);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(job);
			};
			const hook: ExitHook = job => { if (!match(job)) return false; done(job); return true; };
			const onAbort = () => done(undefined);
			this.hooks.add(hook);
			if (Number.isFinite(ms)) timer = setTimeout(() => done(undefined), ms);
			if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	size(job: Job): number {
		try { return fs.statSync(job.log).size; } catch { return 0; }
	}

	/** The log from byte `from` on, at most the last `max` bytes of it. */
	read(job: Job, from = 0, max = 1024 * 1024): { text: string; end: number; skipped: number } {
		const end = this.size(job);
		const start = Math.max(from, end - max);
		if (end <= start) return { text: "", end, skipped: 0 };
		const buf = Buffer.alloc(end - start);
		const fd = fs.openSync(job.log, "r");
		try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
		return { text: buf.toString("utf8"), end, skipped: start - from };
	}

	/** The last `n` lines of a job's log. */
	tail(job: Job, n: number): string[] {
		const lines = this.read(job, 0, 64 * 1024).text.replace(/\n$/, "").split("\n");
		return lines.length === 1 && !lines[0] ? [] : lines.slice(-n);
	}

	/** Forget finished jobs (their logs stay on disk until the session ends). */
	clearFinished(): number {
		const before = this.list.length;
		for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.state !== "running") this.list.splice(i, 1);
		this.onChange?.();
		return before - this.list.length;
	}

	/** One line about a job, for the agent and for people. */
	describe(job: Job, now = Date.now()): string {
		const how = job.state === "running" ? `running ${formatAge(now - job.startedAt)}`
			: `${job.why ?? job.state}${job.why?.startsWith("timed out") ? "" : `, exit ${job.exitCode}`}, took ${formatAge((job.endedAt ?? now) - job.startedAt)}`;
		return `${job.id} · ${how}${job.keep ? " · kept" : ""} · ${job.command.split("\n")[0]}`;
	}
}
