# pi-jobs

**Your [Pi](https://pi.dev) agent never sits blocked on a shell command.**

`bash` works as it always has, but a command still running after a few seconds moves to the
background as a job. The call returns right away with the job's id and its output so far, and the
agent carries on. When the job finishes, the session gets one message with how it ended and its
last lines.

```
[Still running after 5s: moved to the background as job j1. Log: /tmp/pi-jobs-you/…/j1.log. …]
…
[job j1 · done, exit 0, took 2m 14s · npm test]
```

- **Fast commands are unchanged.** Anything that ends within the threshold comes back exactly as
  Pi's built-in `bash` would return it.
- **Servers and watchers start in the background.** `bash` with `background: true` skips the wait,
  and such a job never holds the session open.
- **Nothing is left behind.** Each command runs in its own process group, and leaving the session
  (quit, new, resume, fork) stops its jobs and everything they started. A job that must outlive the
  session is started with `background: true, keep: true`.
- **A reload keeps the jobs.** They carry on, and the reloaded session still gets their messages.
- **The agent can check in.** The `jobs` tool lists jobs, reads a job's new output, waits a bounded
  time for one, or kills one.

## Install

```bash
pi install git:github.com/recursive-systems/pi-jobs
```

Add `-l` to install it for one project only.

## /jobs

`/jobs` shows every job in the session: its state, command and age.

```
↑/↓ or j/k   move
Enter        watch its output, live
x            kill it
c            clear finished jobs
Esc          close (or, while watching, back to the list)
```

`◉` running, `●` done, `✕` failed, `◌` killed. The status line shows what's going on now, as Claude
Code's footer does: one glyph per running job, failed and killed ones for 30 s, and a job that
finished fine leaves at once with a `1 done, /jobs` hint for 30 s (`jobs ◉✕ · 1 done, /jobs`, or
`jobs none`). `/jobs` keeps every job until you clear it there.

pi-jobs bundles [pi-statusbar](https://github.com/recursive-systems/pi-statusbar), so that line gets
its own row below the editor (`id: "jobs"`, order 25; opening it shows `/jobs`) instead of a footer
status. Only one bar is drawn when pi-loop or pi-statusbar is installed too.

## Settings

In `.pi/settings.json`, or your agent dir's `settings.json`:

```json
{ "jobs": { "threshold": 5 } }
```

`threshold` is how many seconds a command runs before it moves to the background (default 5). The
agent can set its own for one call. Pi's `shellPath` and `shellCommandPrefix` apply as they do to the
built-in `bash`.

## Good to know

- Logs live in your temp folder, one per job, and go when the session ends (a kept job's log stays).
- `timeout` still applies once a command is a job.
- In print and JSON mode (`pi -p`), Pi stays until running jobs finish (not `background: true` ones), so their results aren't lost.
- A host can see that a turn still owns running jobs through the session-liveness v1 registry, if one
  is present.

## Optional end-to-end checks

Outside the build, nonblocking and against the real `pi`, with no mocks: `npm test`
(`CASE=fast|slow|kill` runs one case).

A real model calls the tools, so these are opt-in: set `PI_E2E_PROVIDER` and `PI_E2E_MODEL`
explicitly. For an existing Pi gateway connection, also set `PI_E2E_MODELS_FILE` and
`PI_E2E_AUTH_FILE` to absolute paths to your Pi models and auth files. Without a model selection
every case skips. There is no automatic provider fallback.

MIT
