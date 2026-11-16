// End-to-end check: the real `pi` binary in RPC mode, with this package loaded from the repository,
// in a throwaway project and agent dir, driven by a real model. No mocks or stand-ins.
//
//   1. a fast command comes back inline, as the built-in bash would return it
//   2. a slow command moves to the background, and its completion message arrives by itself
//   3. jobs output reads a background job and jobs kill stops it
//   4. hold: in print mode (as a loop run), a `background: true` job keeps the run open until it reports;
//      a `service: true` one doesn't
//
// A model is needed to call tools, so it is opt-in: PI_E2E_PROVIDER and PI_E2E_MODEL select it
// (never chosen silently). PI_E2E_MODELS_FILE points at a Pi models.json with that provider;
// PI_E2E_AUTH_FILE at an auth.json if the provider needs one. Without them every case skips.
// Needs `pi` on PATH (PI_BIN to override). Run: npm test   (CASE=fast|slow|kill|hold runs one case)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const PI = process.env.PI_BIN || "pi";
const { PI_E2E_PROVIDER: PROVIDER, PI_E2E_MODEL: MODEL } = process.env;
for (const k of ["PI_SESSION_ID", "PI_SESSION_FILE"]) delete process.env[k];

function setup() {
	const cwd = fs.mkdtempSync(path.join(tmpdir(), "pi-jobs-e2e-cwd-"));
	const agent = fs.mkdtempSync(path.join(tmpdir(), "pi-jobs-e2e-agent-"));
	if (process.env.PI_E2E_MODELS_FILE) {
		const provider = JSON.parse(fs.readFileSync(process.env.PI_E2E_MODELS_FILE, "utf8")).providers?.[PROVIDER];
		if (!provider) throw new Error("the selected provider is absent from PI_E2E_MODELS_FILE");
		fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { [PROVIDER]: provider } }), { mode: 0o600 });
	}
	if (process.env.PI_E2E_AUTH_FILE) fs.symlinkSync(path.resolve(process.env.PI_E2E_AUTH_FILE), path.join(agent, "auth.json"));
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, defaultThinkingLevel: "off", retry: { enabled: false } }));
	return { cwd, agent, cleanup: () => { for (const d of [cwd, agent]) fs.rmSync(d, { recursive: true, force: true }); } };
}

/** A real Pi in RPC mode; records every JSON line it prints. */
class Pi {
	constructor(p) {
		this.lines = []; this.buf = ""; this.seq = 0;
		this.proc = spawn(PI, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", PACKAGE], { cwd: p.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: p.agent } });
		this.proc.stdout.setEncoding("utf8");
		this.proc.stdout.on("data", d => {
			this.buf += d;
			let i;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
				try { this.lines.push(JSON.parse(line)); } catch { /* not a record */ }
			}
		});
		this.proc.stderr.on("data", () => {});
	}
	send(cmd) {
		const id = `t${++this.seq}`;
		this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		return this.waitFor(l => l.type === "response" && l.id === id, 30_000);
	}
	async prompt(message) {
		const r = await this.send({ type: "prompt", message });
		assert.equal(r.success, true, JSON.stringify(r));
	}
	async waitFor(pred, ms, what = "a line") {
		const end = Date.now() + ms;
		for (;;) {
			const hit = this.lines.find(pred);
			if (hit) return hit;
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last lines:\n${this.lines.slice(-6).map(l => JSON.stringify(l).slice(0, 300)).join("\n")}`);
			await new Promise(r => setTimeout(r, 200));
		}
	}
	/** Until the agent has started at least `runs` runs and none is going. */
	async settled(runs = 1, ms = 180_000) {
		await this.waitFor(() => {
			const starts = this.lines.filter(l => l.type === "agent_start").length, ends = this.lines.filter(l => l.type === "agent_end").length;
			return starts >= runs && starts === ends;
		}, ms, `${runs} settled run(s)`);
	}
	toolEnds(name) { return this.lines.filter(l => l.type === "tool_execution_end" && l.toolName === name); }
	stop() { this.proc.kill("SIGTERM"); setTimeout(() => this.proc.kill("SIGKILL"), 5_000).unref(); }
}
const textOf = r => (r?.content ?? []).map(c => c.text ?? "").join("");

const cases = {
	async fast(pi) {
		await pi.prompt("Use the bash tool to run exactly `echo fast-$((40+2))`, then reply with just its output.");
		await pi.settled();
		const ends = pi.toolEnds("bash");
		assert.ok(ends.length >= 1, "bash was called");
		const r = ends[0].result;
		assert.match(textOf(r), /fast-42/);
		assert.doesNotMatch(textOf(r), /background/);
		assert.equal(ends[0].isError, false);
	},
	async slow(pi) {
		await pi.prompt("Use the bash tool once to run exactly `sleep 7; echo slow-done-$((6*7))` (no other parameters). Don't wait for it, don't sleep, and don't call any other tool; reply with one word: started. When it finishes, reply with its last line of output.");
		const started = Date.now();
		await pi.waitFor(l => l.type === "tool_execution_end" && l.toolName === "bash", 60_000, "the bash call");
		const r = pi.toolEnds("bash")[0];
		assert.match(textOf(r.result), /moved to the background as job j1/);
		assert.ok(Date.now() - started < 30_000);
		const done = await pi.waitFor(l => l.type === "message_start" && l.message?.role === "custom" && l.message.customType === "pi-jobs", 60_000, "the completion message");
		const content = typeof done.message.content === "string" ? done.message.content : textOf(done.message);
		assert.match(content, /j1 · done, exit 0/);
		assert.match(content, /slow-done-42/);
		await pi.settled(2);
		const messages = pi.lines.filter(l => l.type === "message_start" && l.message?.customType === "pi-jobs");
		assert.equal(messages.length, 1, "exactly one completion message");
	},
	async kill(pi) {
		// A marker of this run's own, so the process check below can't match anything else on the machine.
		const mark = `k${process.pid}x${Date.now() % 100_000}`;
		await pi.prompt(`Do these steps with tools, one at a time: 1) bash with background: true running exactly \`for i in $(seq 1 300); do echo tick-$i-${mark}; sleep 1; done\`; 2) bash running \`sleep 3\`; 3) the jobs tool with action output for that background job; 4) the jobs tool with action kill for it. Then reply done.`);
		await pi.settled();
		const bg = pi.toolEnds("bash").map(e => textOf(e.result)).filter(t => /Started in the background as job (j\d+)/.test(t));
		// The model must start exactly one; a second, never killed, would rightly still be running.
		assert.equal(bg.length, 1, "one background job was started");
		const outputs = pi.toolEnds("jobs").map(e => textOf(e.result));
		assert.ok(outputs.some(t => /tick-\d+/.test(t) && /running/.test(t)), `jobs output showed ticks: ${outputs.join(" | ")}`);
		assert.ok(outputs.some(t => /killed by the agent/.test(t)), `jobs kill stopped it: ${outputs.join(" | ")}`);
		await new Promise(r => setTimeout(r, 3_000));
		assert.ok(!pi.lines.some(l => l.type === "message_start" && l.message?.customType === "pi-jobs"), "no completion message for a job the agent killed");
		const ps = await new Promise(res => { const p = spawn("pgrep", ["-af", mark]); let o = ""; p.stdout.on("data", d => (o += d)); p.on("close", () => res(o.trim())); });
		assert.equal(ps, "", `the killed job's processes are gone: ${ps}`);
	},
};

/** `pi -p` with this package, as a loop run would use it; resolves to its exit, output and duration. */
function printRun(p, prompt, ms = 180_000) {
	return new Promise(resolve => {
		const t0 = Date.now();
		const proc = spawn(PI, ["-p", "--no-session", "--no-extensions", "-e", PACKAGE, prompt], { cwd: p.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: p.agent }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		proc.stdout.on("data", d => (out += d));
		proc.stderr.on("data", () => {});
		const t = setTimeout(() => proc.kill("SIGKILL"), ms);
		proc.on("close", code => { clearTimeout(t); resolve({ code, out, s: (Date.now() - t0) / 1000 }); });
	});
}

const printCases = {
	async hold(p) {
		const a = await printRun(p, "Call bash exactly once with background: true and command exactly `sleep 15; echo held-$((6*7))`. Then end your turn at once with the single word: started. When a message says the job finished, reply with its last output line.");
		assert.equal(a.code, 0, a.out);
		assert.match(a.out, /held-42/, `the run stayed open for the background job's result: ${a.out}`);
		assert.ok(a.s >= 15, `ran ${a.s}s`);
		const b = await printRun(p, "Call bash exactly once with service: true and command exactly `sleep 120`. Then end your turn at once with the single word: started.");
		assert.equal(b.code, 0, b.out);
		assert.ok(b.s < 90, `a service didn't hold the run (${b.s}s)`);
	},
};

const only = process.env.CASE;
let failed = 0;
for (const [name, run] of Object.entries(cases)) {
	if (only && only !== name) continue;
	if (!PROVIDER || !MODEL) { console.log(`skip ${name}: set PI_E2E_PROVIDER and PI_E2E_MODEL to opt in (a real model calls the tools)`); continue; }
	const p = setup();
	const pi = new Pi(p);
	const t0 = Date.now();
	try {
		await run(pi);
		console.log(`ok   ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}: ${e.stack ?? e}`);
	} finally {
		pi.stop();
		await new Promise(r => setTimeout(r, 1_000));
		p.cleanup();
	}
}
for (const [name, run] of Object.entries(printCases)) {
	if (only && only !== name) continue;
	if (!PROVIDER || !MODEL) { console.log(`skip ${name}: set PI_E2E_PROVIDER and PI_E2E_MODEL to opt in (a real model calls the tools)`); continue; }
	const p = setup();
	const t0 = Date.now();
	try {
		await run(p);
		console.log(`ok   ${name} (${Math.round((Date.now() - t0) / 1000)}s)`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}: ${e.stack ?? e}`);
	} finally {
		p.cleanup();
	}
}
process.exit(failed ? 1 : 0);
