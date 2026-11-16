/**
 * The jobs view (/jobs in the terminal UI), laid out like pi-loop's /loop view.
 *
 *   list    one row per job: its state as a symbol (the key is at the bottom), command, age
 *           ↑/↓ or j/k move · Enter watch its output · x kill · c clear finished · Esc close
 *   watch   its log, live · x kill · Esc back to the list
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
	private note = "";
	private timer: ReturnType<typeof setInterval>;

	constructor(private tui: { requestRender(): void }, private theme: any, private deps: ViewDeps, private done: () => void) {
		this.timer = setInterval(() => this.tui.requestRender(), 1000);
	}

	private fg(color: string, s: string) { try { return this.theme.fg(color, s); } catch { return s; } }
	private finish() { clearInterval(this.timer); this.done(); }

	invalidate() {}

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
			if (matchesKey(data, "escape") || data === "q") { this.watching = undefined; this.note = ""; }
			else if (data === "x") this.killJob(job);
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
		else if (matchesKey(data, "return")) { this.watching = row.id; this.note = ""; }
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
			const job = rows.find(j => j.id === this.watching);
			put(this.fg("accent", `job ${this.watching}`) + this.fg("muted", job ? ` · ${job.why ?? job.state} · ${age(job)}${job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ""}` : " · gone"));
			if (job) put(this.fg("muted", `$ ${job.command.split("\n")[0]}`));
			put(this.fg("muted", "─".repeat(Math.min(w, 80))));
			const lines = job ? this.deps.lines(job, 18) : [];
			if (!lines.length) put(this.fg("muted", "(no output yet)"));
			for (const l of lines) put(l);
			put(this.fg("muted", "─".repeat(Math.min(w, 80))));
			put(this.fg("muted", this.note || (job ? `${job.log} · ${job.state === "running" ? "x kill · " : ""}Esc back` : "Esc back")));
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
