/**
 * The jobs view (/jobs in the terminal UI), laid out like pi-loop's /loop view.
 *
 *   list    one row per job: its state as a symbol (the key is at the bottom), command, age
 *           ↑/↓ or j/k move · Enter watch its output · x kill · c clear finished · Esc close
 *   watch   its log full screen, live · PgUp/PgDn ↑↓ scroll · x kill · Esc back to the list
 */
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatAge, type Job, type JobState } from "./jobs.ts";

export const GLYPH: Record<JobState, { glyph: string; color: string; meaning: string }> = {
	running: { glyph: "◉", color: "accent", meaning: "running" },
	done: { glyph: "●", color: "dim", meaning: "done" },
	failed: { glyph: "✕", color: "error", meaning: "failed" },
	killed: { glyph: "◌", color: "dim", meaning: "killed" },
};

export interface ViewDeps {
	jobs(): Job[];
	lines(job: Job, n: number): string[];
	kill(job: Job): void;
	clearFinished(): number;
	title: string;
}

export class JobsView {
	private sel = 0;
	private watching?: string;
	get watchingId() { return this.watching; }
	/** Lines up from the bottom of the log while watching; 0 follows it. */
	private scroll = 0;
	private note = "";
	private timer: ReturnType<typeof setInterval>;

	constructor(private tui: { requestRender(): void }, private theme: any, private deps: ViewDeps, private done: (watch?: string) => void, watch?: string, select?: string) {
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
		if (select) this.sel = Math.max(0, deps.jobs().findIndex(j => j.id === select));
		if (watch) { this.watching = watch; this.sel = Math.max(0, deps.jobs().findIndex(j => j.id === watch)); }
	}

	private fg(color: string, s: string) { try { return this.theme.fg(color, s); } catch { return s; } }
	private finish(watch?: string) { clearInterval(this.timer); this.done(watch); }

	invalidate() {}

	private height(): number { return Number((this.tui as any)?.terminal?.rows) || 40; }

	/** Pi disposes the component when the interaction ends, however it ends. */
	dispose() { clearInterval(this.timer); }

	private killJob(job: Job | undefined) {
		if (!job) return;
		if (job.state !== "running") { this.note = `${job.id} isn't running`; return; }
		this.deps.kill(job);
		this.note = `killing ${job.id}…`;
	}

	handleInput(data: string): void {
		const rows = this.deps.jobs();
		if (this.watching) {
			const job = rows.find(j => j.id === this.watching);
			const page = Math.max(1, this.height() - 6);
			if (matchesKey(data, "escape") || data === "q") { this.finish(); return; }
			else if (data === "x") this.killJob(job);
			else if (matchesKey(data, "pageUp") || data === "b") this.scroll += page;
			else if (matchesKey(data, "pageDown") || data === " ") this.scroll = Math.max(0, this.scroll - page);
			else if (matchesKey(data, "up") || data === "k") this.scroll += 1;
			else if (matchesKey(data, "down") || data === "j") this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "home") || data === "g") this.scroll = Number.MAX_SAFE_INTEGER;
			else if (matchesKey(data, "end") || data === "G") this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") { this.finish(); return; }
		if (data === "c") { const n = this.deps.clearFinished(); this.note = n ? `cleared ${n}` : "nothing finished to clear"; this.sel = 0; this.tui.requestRender(); return; }
		if (!rows.length) return;
		this.sel = Math.min(this.sel, rows.length - 1);
		const row = rows[this.sel]!;
		if (matchesKey(data, "up") || data === "k") this.sel = Math.max(0, this.sel - 1);
		else if (matchesKey(data, "down") || data === "j") this.sel = Math.min(rows.length - 1, this.sel + 1);
		else if (matchesKey(data, "return")) { this.finish(row.id); return; }
		else if (data === "x") this.killJob(row);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const out: string[] = [];
		const w = Math.max(1, width);
		const put = (s: string) => out.push(truncateToWidth(s, w));
		const rows = this.deps.jobs();
		const now = Date.now();
		const age = (j: Job) => formatAge((j.endedAt ?? now) - j.startedAt);
		if (this.watching) {
			// Full screen: the job's log as far up as the terminal allows, following its end unless scrolled.
			const job = rows.find(j => j.id === this.watching);
			const body = Math.max(3, this.height() - 4);
			const pad = (s: string) => out.push(truncateToWidth(s, w, "", true));
			pad(this.fg("accent", ` job ${this.watching}`) + this.fg("muted", job ? ` · ${job.why ?? job.state} · ${age(job)}${job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ""}` : " · gone"));
			pad(this.fg("muted", job ? ` $ ${job.command.split("\n")[0]}` : ""));
			const all = job ? this.deps.lines(job, 5000).flatMap(l => l.split("\r").pop()!.split("\n")) : [];
			this.scroll = Math.min(this.scroll, Math.max(0, all.length - body));
			const end = all.length - this.scroll;
			const view = all.slice(Math.max(0, end - body), end).map(l => ` ${l}`);
			if (!all.length) view.push(this.fg("muted", " (no output yet)"));
			while (view.length < body) view.push("");
			for (const l of view) pad(l);
			pad(this.fg("muted", "─".repeat(w)));
			const where = this.scroll ? this.fg("warning", `${this.scroll} lines up (End follows) · `) : "";
			pad(this.fg("muted", ` ${this.note || `${where}${job ? job.log + " · " : ""}PgUp/PgDn ↑↓ scroll · ${job?.state === "running" ? "x kill · " : ""}Esc back`}`));
			return out;
		}
		put(this.fg("accent", `jobs · ${this.deps.title}`));
		if (!rows.length) put(this.fg("muted", "No jobs. A command still running after a few seconds shows up here."));
		rows.forEach((j, i) => {
			const mark = i === this.sel ? "▸ " : "  ";
			const g = GLYPH[j.state];
			const id = i === this.sel ? this.fg("accent", j.id) : j.id;
			const how = j.state === "running" ? age(j) : `${j.why ?? j.state}${j.exitCode !== undefined && !j.why ? ` ${j.exitCode}` : ""} · ${age(j)}`;
			put(`${mark}${this.fg(g.color, `${g.glyph} `)}${id}  ${j.command.split("\n")[0]}  ${this.fg("muted", how)}${j.keep ? this.fg("muted", " · kept") : ""}`);
		});
		put("");
		put(Object.values(GLYPH).map(g => `${this.fg(g.color, g.glyph)} ${this.fg("muted", g.meaning)}`).join("   "));
		put(this.fg("muted", this.note || "Enter watch · x kill · c clear finished · Esc close"));
		return out;
	}
}
