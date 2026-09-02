# Repository guidelines for `bs` (brightspace-cli)

`bs` is a read-only Brightspace (D2L) CLI for AI agents, scripts and humans. The frozen
spec is `docs/PRD.md`; evidence for every decision is under `docs/evidence/`. Read the PRD
sections your ticket cites before writing code.

## Project structure

- `src/bin/bs.ts` — shebang entry; the only file that calls `process.exit`.
- `src/cli/program.ts` — commander root, global flags, env defaults, validation, exit-code
  mapping; `run(argv, io)` returns an exit code (tests call it in-process).
- `src/cli/context.ts` — per-invocation `CliContext` (streams, env, resolved globals, lazy
  `paths()`/`config()`/`http()`, the `rungs` list the auth tickets register) and `emit()`, the
  one output seam for json/plain/human. Tests inject `transport` through `RunIO`.
- `src/cli/options.ts` — global flag definitions (PRD 6.1) and the flag type registry.
- `src/cli/commands/<name>.ts` — one file per resource exporting `register(program, ctx)`;
  add it to the list in `src/cli/commands/index.ts`.
- `src/cli/data.ts` — what every data command uses: `withData(ctx, (http, cfg) => ...)` (runs
  `retryOnceOnSessionExpired` and routes against the session's tenant; no session → exit 4 with
  no data request; never opens a browser), `listEnvelope()`/`emitList()` (PRD 6.3 `{items, count,
  fetchedAt}` plus `--fail-empty` → exit 3 after the output is written) and `emitRaw()` (`--raw`:
  the payload as decoded, `--select` ignored, `--wrap-untrusted` still applied).
- `src/cli/commands/whoami.ts`, `src/cli/commands/courses.ts` — `bs whoami`, `bs courses list|get`
  (bs-0am): thin actions that parse flags, call `src/d2l/` through `withData`, shape, emit.
- `src/cli/commands/content.ts` — `bs content toc|get|module|download <ou> [<id>]` (bs-kzf): `toc` is one
  GET emitting the module tree (`--flat`: one Topic row per topic with its module `path`; `--plain` is
  always the flat rows); `get` adds `dueDate`/`description` and maps a 400 (a module id) to exit 2;
  `module` lists one module's children; `download` streams `topics/(id)/file` through
  `requestStream` to `--out <dir|file>` (`.part` then rename) or `--out -`/`--stdout`, names the file
  from `Content-Disposition`, else the topic's file `Url`, else its title, and maps the 400 "not a
  file" to exit 2 with the topic type and `url`. 404 → exit 5 with a `content toc --flat` hint.
- `src/cli/commands/quizzes.ts` — `bs quizzes list|get|attempts <ou> [<quizId>]` (bs-440): `list`
  walks `Next`; `get` maps 404 to a `bs quizzes list <ou>` hint; `attempts` calls `whoami` first for
  `?userId=` and rewrites a 403 with the learner-access caveat plus the quiz deep link.
- `src/core/paths.ts` — the single layout decision (PRD 8.1). Resolution is pure;
  `ensureDirs()` creates 0700 dirs and is never called by `--help`, `version`, `schema`.
- `src/core/config.ts` — tenant knobs (PRD 8.3): flags > `BS_*` env > `config.json` > defaults.
- `src/core/errors.ts` — `BsError` classes, `EXIT_CODES`, `exitCodeFor()`, `formatError()`.
- `src/core/output.ts` — JSON/TSV writers, `--select`, `--results-only`, untrusted wrapping,
  `Table`, color.
- `src/core/http/` — the one HTTP seam (PRD 9), imported via `index.js`: `client.ts`
  (`createHttp()` with injectable transport/clock/sleep/random/log, read-only guard, retries,
  first-byte timeout, `withBearer`), `classify.ts` (`classify()`, `problemDetails()`, `readJson()`,
  `toError()` → BsError + exit code), `paginate.ts` (`pagedResultSet`, `objectListPage`,
  `pageNumbered`, `collect`), `pool.ts` (`boundedPool`), `url.ts` (`d2lUrl`). Commands never call
  `fetch` directly; tests inject a fake transport (`test/helpers/http.ts`).
- `src/core/dates.ts` — `toD2lDateTime()` (UTCDateTime with milliseconds), `isoSeconds()`
  (whole-second UTC or null) and `isoAtMs()` (epoch ms to whole-second UTC).
- `src/core/atomic.ts` — `writeJsonAtomic()` (same-dir temp + rename, chmod 0600) and
  `readJsonFile()` (missing/corrupt → undefined). Directories come from `paths.ensureDirs()`.
- `src/auth/` — the session ladder (PRD 7, 8.1–8.2). `session.ts`: the `session.json` contract,
  `readSession()` (corrupt → null, never throws), `writeSession()` (atomic 0600 in 0700 dirs),
  `deleteSession()` (only `bs auth logout` may call it), `buildCookieHeader()` (fixed order),
  `jwtExpiry()`/`jwtIsFresh()` (60 s skew, 3600 s fallback). `mint.ts`: `mintJwt()`, the one
  permitted mutation (`POST /d2l/lp/auth/oauth2/token`), classified marker first then status.
  `ladder.ts`: the `Rung` seam (`kind: 'silent' | 'full'`, `attempt({paths, config, log})`),
  `climb()` (rung 0 → rungs in order, `full` only with `allowFull`; never throws, never deletes
  state, always writes `cache/status.json`), `authorizedHttp(ctx)` (Bearer-attaching client or
  `AuthRequiredError`/`RetryableError`) and `retryOnceOnSessionExpired()` for data commands.
  Browser rungs import `playwright-core` lazily and live in their own files.
  `RungContext` also carries an optional `warn` (a line the user sees without `--verbose`;
  `authorizedHttp` and `auth refresh` wire it to `ctx.warn`).
- `src/auth/rungs/` — the browser rungs (PRD 7 rung 1, PRD 5 browser row). `browser.ts`: the
  narrow `PageLike`/`LocatorLike`/`BrowserContextLike` seam, `withBrowser()` (lazy
  `import('playwright-core')` through an injectable `importer`, `launchPersistentContext` on
  `profile/` 0700, `channel` from `BS_BROWSER_CHANNEL`, always closed in `finally`) and the
  login mechanics: `isAuthenticated()` (tenant `d2lSessionVal` AND `window.D2L.LP`),
  `extractXsrf()` (D2L JS then the meta tag, 10 x 1 s), `clickThroughSilentSurfaces()` (campus
  text on `/d2l/login`; `#idSIButton9` only behind a KMSI marker), `trySilentLogin()` (goto
  `/d2l/home`, 30 s, fail fast on an email field) and `harvestSession()` (cookies filtered to
  the tenant host + XSRF → `buildSession`). Browser-side JS is the exported `*_JS` strings so a
  fake page can match them. `silent.ts`: `silentRung()` (`kind: 'silent'`, headless; a missing
  `playwright-core` or browser executable is a null plus a one-line `Run: bs auth doctor` on
  `warn`, never a throw). `createContext()` registers it by default; `RunIO.rungs` overrides it
  (tests get `rungs: []` from `test/helpers/cli.ts`, so no test ever opens a real browser) and
  `RunIO.stdin` feeds prompts. `test/helpers/browser.ts` is the scripted `FakeBrowser`
  (surfaces, clicks, waits on a fake clock, a fake importer).
- `src/d2l/` — the typed D2L route layer commands call (one file per resource, evidence in
  `docs/evidence/d2l-api-web.md`). `common.ts`: `LpTenant`, `d2lId()` (string D2LID → number when
  numeric), `orgUnitRefOf()`. `links.ts`: every deep-link template from PRD 6.3 (`courseHomeUrl`,
  `assignmentUrl`, `quizUrl`, `gradebookUrl`, `announcementsUrl`); nothing else derives URLs.
  `users.ts`: `whoami()`, `userOf()`. `courses.ts`: `enrollmentsUrl()` (query builder:
  `orgUnitTypeId`/`isActive`/`startDateTime`/`sortBy`), `listEnrollments()` (async iterable over
  `pagedResultSet`; `--limit` stops fetching), `getEnrollment()`, `getCourse()`, and the pure
  parsers `courseOf()`/`courseDetailOf()` onto the PRD 6.3 Course shape (every value read, only
  `url` computed, dates through `isoSeconds`). Route helpers take `(http, cfg, ...)` where `cfg`
  is the tenant config (versions from `lpVersion`/`leVersion`, never hard-coded).
  `content.ts`: `contentTocUrl()`/`contentTopicUrl()`/`contentTopicFileUrl()`/`contentModuleStructureUrl()`,
  `getToc()`, `getTopic()` (400 → UsageError), `getModuleStructure()`, `streamTopicFile()` (a
  `StreamOutcome` for the command to classify), and the pure parsers `tocTree()`/`flattenToc()` (PRD 6.3
  Topic shape with `kind: 'content'`, `path`, `depth`; the server `Url` absolutised, never templated;
  CONTENTACTIVITYTYPE_T / CONTENT_TOPIC_T mapped to names with the numeric id kept),
  `topicDetailOf()`, `moduleChildOf()`/`moduleChildren()`, plus the download-name helpers
  `filenameFromContentDisposition()` (RFC 6266/5987), `safeFileName()` and `fileNameFromTopicUrl()`.
  `quizzes.ts`: `LeTenant`, `quizzesUrl()`/`quizItemUrl()`/`quizAttemptsUrl()`, `listQuizzes()` and
  `listAttempts()` (async iterables over `objectListPage`, which rejects the dropbox bare-array
  shape), `getQuiz()`, and the pure parsers `quizOf()`/`quizDetailOf()`/`attemptOf()` onto the PRD
  6.3 Item shape with `kind: 'quiz'` (`attemptsAllowed`/`unlimitedAttempts` from `AttemptsAllowed`,
  `timeLimit` from `SubmissionTimeLimit`; rich text read from either `{Text:{Text,Html},IsDisplayed}`
  or flat `{Text,Html}`; `instructions`/`feedback` are text only so every free-text key is one
  `--wrap-untrusted` wraps).
- `src/schema/schema.ts` — `bs schema --json` from the live commander tree.
- `src/buildinfo.ts` — version from `package.json`; commit/date from `dist/buildinfo.json`
  (written by `scripts/buildinfo.mjs` during `npm run build`; "unknown" in dev).
- `test/**/*.test.ts` — hermetic `node:test` suites mirroring `src/` (`test/core/paths.test.ts`
  tests `src/core/paths.ts`). `test/helpers/cli.ts` runs the CLI with captured streams (pass
  `transport` to script HTTP); `test/helpers/http.ts` fakes the transport; `test/helpers/auth.ts`
  builds fake sessions/JWTs, loads the auth fixtures and asserts secret-free output.
  `test/auth/no-playwright-load.test.ts` spawns `test/helpers/playwright-probe.ts` to prove
  `--help`, `version`, `schema` and `auth status` never load `playwright-core`.
  `test/fixtures/` holds recorded payloads with a provenance README. `test/live/` (behind
  `BS_LIVE=1`) is the only place that may touch the tenant.
- `test/commands/<name>.test.ts` — hermetic command suites: seed a session in a temp `--root`
  (`tempRoot()` + `writeSession(fakeSession({jwt}))`), script HTTP with `fakeTransport`, assert
  on exit code, stdout, stderr and the recorded requests. `test/d2l/` unit-tests the pure
  builders and parsers on the recorded fixtures.
- `reference/` — vendored reference projects (read-only, excluded from lint).

## Build, test, lint

- `npm run build` — `tsc` to `dist/`, then writes `dist/buildinfo.json`.
- `npm run dev -- <args>` — run from source via `tsx` (e.g. `npm run dev -- schema --json`).
- `npm test` — `node --test --import tsx "test/**/*.test.ts"` (hermetic: no network, no browser).
- Run one file: `node --test --import tsx test/core/output.test.ts`.
- Run one test: `node --test --import tsx --test-name-pattern "select" test/core/output.test.ts`.
- `npm run lint` / `npm run lint:fix` — Biome check / auto-fix (format + lint).
- `npm run typecheck` — type-checks `src/`, `test/` and `scripts/` without emitting.
- All three of `npm run build && npm test && npm run lint` must be green before a ticket closes.

## Rules

- **Stdout is an API.** Only data goes to stdout (`--json` / `--plain` / the human rendering
  of a result). Progress, prompts, warnings and errors go to stderr through `ctx.log`,
  `ctx.warn`, `ctx.debug` or a thrown `BsError`.
- **Exit codes come from `src/core/errors.ts` only.** Throw a `BsError` subclass; never call
  `process.exit` outside `src/bin/bs.ts`, never invent a numeric code.
- **Secrets never leak (PRD 8.2).** Cookies, XSRF tokens, JWTs and passwords are never
  printed, logged, serialized into output, or committed. `--verbose` logs lengths and labels
  only. Credentials reach child processes via env, never argv.
- `--help`, `version` and `schema` must stay side-effect free: no state directory, no
  `playwright-core` import (import it lazily inside the auth rungs only).
- Toolchain: Node >= 22.12, TypeScript ESM (`NodeNext`), explicit `.js` extensions in relative
  imports, Biome for format + lint. Dependencies are limited to `commander`, `env-paths`,
  `playwright-core` and the dev tools; pin exact versions.
- Tests first (red, then green). Hermetic by default; inject `env`, streams and TTY flags
  rather than reading `process.*` in tests.

## Commits

- Conventional Commits with the ticket id: `feat(auth): silent rung (bs-30m)`,
  `test(http): retry policy (bs-hop)`, `chore: ...`.
- Stage explicit paths (never `git add -A`); never commit `node_modules`, `dist`, `.env`, or
  anything under a `BS_ROOT`.
- Work on `bead/<id>` branches; the orchestrator merges. Do not push, rebase or merge.
