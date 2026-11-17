# pi-jobs

A Pi extension: it overrides `bash` so a command still running after the threshold (default 5 s)
moves to the background as a job, adds the `jobs` tool and the `/jobs` view, and sends the session
one message when a job finishes.

- `index.ts` holds the extension: completion messages, the status line, liveness, `/jobs` and the
  session lifecycle. `bash.ts` is the `bash` override; `jobs.ts` the registry (process groups, one
  log file per job); `tool.ts` the `jobs` tool; `view.ts` the `/jobs` view; `settings.ts` reads
  `jobs.threshold` and Pi's shell settings.
- Jobs live process-wide (`shared` in `index.ts`), because Pi rebuilds extensions on every reload
  and session switch. They follow the current session: a reload keeps them, and a switch (new,
  resume, fork) hands them to the session you land in, which reports them. Quitting Pi stops all but
  kept ones. Keep that: no job outlives Pi unless it was started with `keep`.
- `background: true` only skips the threshold: the job holds the session (print mode, liveness) and
  reports like any job. Only `service` (or `keep`) jobs don't hold it.
- A command that ends inside the threshold must return exactly what the built-in `bash` returns
  (text, details, `isError`, structured output).
- A job the agent already knows the end of (it killed it, or `jobs wait`/`output` returned it) gets
  no completion message. Exactly one message per other finished job.
- What an agent using pi-jobs knows comes from the tools' descriptions, `promptSnippet` and
  `promptGuidelines` (`BASH_GUIDELINES`, `JOBS_GUIDELINES`), and the notes in their results. Keep
  them short and consistent with each other.
- Care for the surrounding design and keep changes focused and reversible.
  Do not add, maintain or run unit-test suites. Build/static checks must be measured under 60 seconds.
  Temporary checks are minimal and ephemeral, never required build/deploy gates.
- Optional nonblocking end-to-end checks run the real `pi` binary with no mocks (`npm test`): they
  drive Pi the way an agent or user does, never unit tests or stand-ins for Pi or a model. A test that
  can't reach a real piece (no model key) is skipped with the reason, not faked.
  Live models require explicit PI_E2E_PROVIDER and PI_E2E_MODEL (see README); never silently choose
  a paid provider. Start with one selected case and run sequentially. Context-layer changes need the
  cases checking that a real agent uses the package correctly.
- Pi supplies `@earendil-works/*` and `typebox`: keep them optional peer dependencies, never installed
  with the package (a git install runs `npm install`).
- No terminal multiplexer or other host is assumed: everything works in plain Pi.
- The `[job <id> · …]` header of completion messages and the `statusbar:*` events are public
  contracts. Change them only in a major version.

## Writing for people

- The README is for a person deciding in seconds whether this is worth their time. Lead with
  what it does and why it matters, keep only what they need to start, and cut anything else.
- Keep this file minimal: only what an agent needs to work here.
- Readers can be anywhere in the world. Don't assume a time zone, place, language or setup.
- Keep it generic: nothing specific to any one user, company or setup.
