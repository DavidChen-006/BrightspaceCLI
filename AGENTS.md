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
  the payload as decoded, `--select` ignored, `--wrap-untrusted` still applied). It also owns the
  partial-result vocabulary (bs-6j8): `RouteFailure {route, status, message}`, `httpStatusOf()`,
  `routeFailure()` and `forbiddenNote(course)` (the 403 sentence a command may add once it holds
  the enrollment: `This course ended on <date>; …` or `The course is active; …`). `route` and
  `message` inside a `failures[]` entry are bs-generated, so `src/core/output.ts` demotes exactly
  those two keys under that parent and `--wrap-untrusted` leaves them readable.
- `src/cli/download.ts` — what every `download` verb shares (bs-rst): `filenameFromContentDisposition()`
  (RFC 6266/5987 `filename*` first, then quoted, then bare), `safeFileName()` (one path component,
  control and `<>:"|?*` characters stripped, no leading dots, 255-byte cap keeping the extension,
  fallback), `resolveOutTarget(ctx, out, defaultName)` (`-` → stdout; omitted → `<cwd>/<name>`;
  trailing slash or an existing directory → the file inside it; anything else the exact file path;
  directories created on demand), `resolveOutDir()`, `writeStreamToFile()` (same-directory `.part` +
  rename, never a partial file under the final name; an existing file is refused without `--force`
  as a `UsageError` exit 2 naming `--force`; a body failing mid-stream is `RetryableError` exit 8; a
  filesystem failure is exit 1), `writeStreamToSink()` (bytes to `ctx.stdout`, honouring `drain`)
  and `downloadTo()` dispatching on the target. `Sink` in `src/core/output.ts` accepts
  `string | Uint8Array`, so no command casts a byte sink.
- `src/cli/commands/auth.ts` — `bs auth status|refresh|login|logout`. `login` is the ONLY
  command that climbs the full rung: it resolves credentials first (so a non-interactive run
  with nothing to type is exit 4 before any browser), builds the full rung inside the action
  (`ctx.fullRung ?? fullRung`, never from `ctx.rungs`, so the silent path runs once, inside the
  full rung), runs `climb` with `allowFull: true`, prints the `auth status` shape, and maps
  `rung.failure` to a specific hint (exit 4). `--save-credentials` writes `credentials.json`
  only after a successful login. The MFA relay is a plain stderr line via `ctx.log`.
  `doctor [--install-browser]` (bs-6cu) is the read-only diagnosis: it never climbs a rung, never
  mints and never creates the root; it runs `runDoctor()` from `src/auth/doctor.ts`, emits
  `{ok, root, baseUrl, browserChannel, checks[{name, ok, status: ok|warn|fail, detail, hint?}]}`
  (human: a ✓/!/✗ table on stdout), then throws `ConfigError` (10) when a check failed or
  `RetryableError` (8) when the only failure is an unreachable tenant. `--install-browser` asks
  `Download Chromium (~300 MB) ...? [y/N]` on stderr (non-interactive/--no-input: `UsageError` 2
  with the command in the hint), runs `deps.install` and re-runs only the browser check.
- `src/cli/commands/whoami.ts`, `src/cli/commands/courses.ts` — `bs whoami`, `bs courses list|get`
  (bs-0am): thin actions that parse flags, call `src/d2l/` through `withData`, shape, emit.
  `courses get` merges `myenrollments/(ou)` (the primitive; its 404/403 is fatal) with
  `courses/(ou)` and always emits `partial` and `failures[{route, status, message}]` beside the
  PRD CourseDetail (bs-6j8): `false`/`[]` on full success, `true` plus the one entry when
  `courses/(ou)` failed and `path`/`description`/`semester`/`department` are therefore null. The
  stderr warning stays, and on a 403 it appends `forbiddenNote()` — the enrollment is in hand, so
  it can say whether the term ended or the tool is closed to the role. `--plain` gets `partial`
  and `failures` rows for free (the shape is key/value); `--raw` is unchanged (`{enrollment,
  offering}`).
- `src/cli/commands/content.ts` — `bs content toc|get|module|download <ou> [<id>]` (bs-kzf): `toc` is one
  GET emitting the module tree (`--flat`: one Topic row per topic with its module `path`; `--plain` is
  always the flat rows); `get` adds `dueDate`/`description` and maps a 400 (a module id) to exit 2;
  `module` lists one module's children; `download` streams `topics/(id)/file` through
  `requestStream` and `src/cli/download.ts` to `--out <dir|file>` (`.part` then rename; parents
  created on demand; an existing file is exit 2 without `--force`) or `--out -`/`--stdout`, names
  the file from `Content-Disposition`, else the topic's file `Url`, else its title, and maps the 400
  "not a file" to exit 2 with the topic type and `url`. 404 → exit 5 with a `content toc --flat` hint.
- `src/cli/commands/quizzes.ts` — `bs quizzes list|get|attempts <ou> [<quizId>]` (bs-440): `list`
  walks `Next`; `get` maps 404 to a `bs quizzes list <ou>` hint; `attempts` calls `whoami` first for
  `?userId=` and rewrites a 403 with the learner-access caveat plus the quiz deep link.
- `src/cli/commands/grades.ts` — `bs grades list|final <ou>` (bs-6mw). `list` fetches `grades/` and
  `grades/values/myGradeValues/` concurrently and left-joins them on the grade object id (values
  404 = "no grades yet" → every `myValue` null; objects failing while values answer costs only the
  object fields with a warning; both failing reports the objects' error: 403 → 6, 404 → 5). `final`
  emits the released final grade or the `released: false` shape with exit 0 (3 under
  `--fail-empty`). `--plain` flattens `associatedTool`/`myValue` into one row per item.
- `src/cli/commands/assignments.ts` — `bs assignments list|get|submissions|download` (bs-e4i).
  `list`/`submissions` decode the bare arrays into the PRD Item (`kind: 'assignment'`) and
  Submission shapes (undecodable items skipped with a warning; none decodable → exit 1);
  `get` adds `instructions {text, html}`, `attachments`, `linkAttachments`, `availability`
  (null-safe) and decoded enums; 404 → exit 5 with a `bs assignments list <ou>` hint, 403 →
  exit 6 (past-term). RichText fields are emitted as `{text, html}` so both forms wrap under
  `--wrap-untrusted`. `download <ou> <folderId> <fileId> [--submission <sid>] [--out path|-]
  [--force]` streams one file via `requestStream` (attachment route, or the submission-file
  route with `--submission`) through `src/cli/download.ts`: `--out` is a directory (existing or
  trailing slash, created on demand), a file path, or `-` for raw bytes on stdout (refused with
  `--json`/`--plain`, exit 2); the name comes from `Content-Disposition` (RFC 6266 `filename*`
  first), sanitised to one path component, fallback `file-<fileId>`; existing files are never
  overwritten without `--force` (exit 2); the summary is `{fileId, submissionId, fileName, path,
  bytes, contentType}`.
- `src/cli/commands/announcements.ts` — `bs announcements list|get|download` (bs-ni1). `list <ou>`
  is one GET on `news/` (bare array, no paging) with `--since` (ISO timestamp, `YYYY-MM-DD`, or a
  duration `7d|36h|90m|2w` via `parseSince`) and `--limit` (default 20, applied after the
  newest-first sort); `get <ou> <newsId>` is a filter of that list (D2L has no single-item news
  route; an unknown or draft id is exit 5); `download <ou> <newsId> [fileId] [--out <dir>]
  [--force]` streams every attachment (or the one `fileId`) through `requestStream` and
  `src/cli/download.ts` into `--out` (created if missing; names deduplicated within one run as
  `<stem>-<fileId><ext>`, fallback `attachment-<fileId>`; an existing file is exit 2 without
  `--force`), and emits `{fileId, fileName, path, bytes}` rows.
- `src/cli/commands/calendar.ts` — `bs calendar events [ou...] [--from] [--to] [--type] [--limit]`
  (bs-bbc): one `calendar/events/myEvents/` ObjectListPage walk per chunk of <=100 org units
  (`orgUnitIdsCSV`, dates via `toD2lDateTime`, window default now → +30 days, `--type due` =
  `eventType=6`). Without org units it resolves active course offerings through `listEnrollments`
  (the `bs courses list` defaults) first; no active course → empty list plus a warning, no calendar
  request. Chunks fan out through `boundedPool(cfg.concurrency)` with per-chunk isolation (one chunk
  failing warns; all failing reports the first error). The tenant answers an empty page (instructors
  never opt in): exit 0, or 3 under `--fail-empty`. Bad ids/dates/windows/types → exit 2 before any
  request (`parseDate` accepts `YYYY-MM-DD` or an ISO timestamp and rejects calendar-invalid days).
- `src/cli/commands/discussions.ts` — `bs discussions forums <ou>`, `topics <ou> [forumId]`,
  `posts <ou> <forumId> <topicId> [--threads-only] [--limit] [--page-size]` (bs-bbc). `topics`
  without a forum lists `forums/` then every forum's `topics/` through `boundedPool(cfg.concurrency)`
  with per-forum isolation (a failing forum warns and costs only its topics; every forum failing
  reports the first error). `posts` pages with `pageNumbered` (`pageSize` default 100, max 1000;
  stop on a short page; `--limit` stops fetching). 404s carry the parent-listing hint
  (`bs discussions forums <ou>` / `bs discussions topics <ou> <forumId>`).
- `src/cli/commands/upcoming.ts` — `bs upcoming [--days 14] [--kinds a,b] [--course <ou>]... [--limit n]`
  (bs-cv2), the one workflow command (PRD 6.2 upcoming row, 9 fan-out). Active courses come from
  `listEnrollments` (the `bs courses list` defaults; ids are deduped) or the repeatable `--course`
  (no enrollment request, so `courseName` is null). Pool units go through
  `boundedPool(cfg.concurrency)`: one unit per course (`dropbox/folders/`, `quizzes/` and
  `discussions/forums/` + every forum's `topics/`, run in sequence so `BS_CONCURRENCY` bounds the
  requests in flight) plus one `content/myItems/due/?orgUnitIdsCSV=` unit per chunk of <=100
  courses; `--kinds` drops the routes of the kinds not asked for. Every route is isolated: a failure
  costs only its items and lands in the envelope's `failures[{courseId, courseName, status,
  message}]` (`courseId` null for a content chunk). The first 403 ends a course and skips its
  remaining routes; denied courses are ONE stderr line that NAMES them (bs-6j8: `N course(s)
  returned 403: Name (id), …`, and past the third `… and N more; details with --verbose`), with
  per-course lines plus `forbiddenNote()`'s diagnosis under `--verbose`; other failures warn one
  line each. The command only fails when no route at all answered and no course was denied
  (then the first error is rethrown), on auth (a 401 re-mints once through `withData`) or
  cancellation; every course 403 is exit 0 with an empty list (3 under `--fail-empty`).
  `mergeUpcoming` keeps items due in `[now, now + days]`, dedupes by `(kind, id)`, sorts by
  `dueDate` then `title`; `--limit` slices after the sort (every course is still fetched). `--plain`
  columns: `kind courseId courseName id title dueDate url`.
- `src/cli/commands/api.ts` — `bs api <METHOD> <path> [--query k=v]... [--raw]` (bs-cv2): one
  authenticated request against any `/d2l/` route, the payload emitted losslessly (PRD 6.2 api row,
  gogcli §7/§14). `<method>` is GET/HEAD/OPTIONS (`Argument.choices` for the schema enum plus a
  case-folding parser; anything else is exit 2 before any request, the HTTP layer's guard being
  the second line of defence). `<path>` must start with `/d2l/` and is normalised against the
  tenant (`..` cannot escape it, no host); a `?query` in it is kept and `--query` pairs (split at
  the first `=`) are appended through `d2lUrl`. There is deliberately no `--header` (so
  `X-HTTP-Method-Override` cannot be sent) and no `--body`. Non-2xx → `classify`/`toError` (404 →
  5, 403 → 6, 401 → one re-mint then 4). A JSON body is emitted parsed (`--select`,
  `--wrap-untrusted`, `--plain` all apply); a non-JSON body is printed as text (a JSON string under
  `--json` so stdout stays JSON); `--raw` prints the body exactly as received in every mode (still
  wrapped under `--wrap-untrusted`); HEAD prints the response headers (lower-cased) as an object.
- `src/core/paths.ts` — the single layout decision (PRD 8.1). Resolution is pure;
  `ensureDirs()` creates 0700 dirs and is never called by `--help`, `version`, `schema`.
- `src/core/config.ts` — tenant knobs (PRD 8.3): flags > `BS_*` env > `config.json` > defaults.
- `src/core/errors.ts` — `BsError` classes, `EXIT_CODES`, `exitCodeFor()`, `formatError()`.
- `src/core/output.ts` — JSON/TSV writers, `--select`, `--results-only`, untrusted wrapping,
  `Table`, color. `--wrap-untrusted` wraps the PRD 10.3 keys, `courseName`, every key ending in
  `Html`/`Text`/`Name` (`instructionsHtml`, `feedbackHtml`, `bodyText`, `shortName`, a raw
  payload's `OrgUnitName`, ...) and, on rows whose `kind` is `content`, `path` (module titles);
  `METADATA_KEYS`/suffixes (`id`, `url`, `fileName`, `uniqueName`, `mimeType`, dates) always win,
  so a download summary's filesystem `path` is never wrapped.
- `src/core/http/` — the one HTTP seam (PRD 9), imported via `index.js`: `types.ts` (the
  `Transport`/`HttpClient` seam types), `client.ts`
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
  `full.ts`: `fullRung(input, deps)` (`kind: 'full'`, PRD 7 rung 2): silent path first, then
  the Entra choreography (email → `#idSIButton9` → password → submit, each field polled 250 ms up
  to 30 s), then the number-match loop (2 s up to 5 min: read `#idRichContext_DisplaySign`
  BEFORE the auth check, announce `Type NN into Authenticator on your phone` on change through
  `input.announce`, write `cache/mfa.json {number, mintedAt}` 0600, click KMSI, check auth,
  harvest). `cache/mfa.json` is cleared before the attempt and in `finally`; its writes are
  guarded. Failures are a null plus one `warn` line plus `rung.failure` (`bad-password`,
  `unknown-account`, `mfa-timeout`, `mfa-denied`, `no-field`, `no-xsrf`, `browser`, `error`) so
  `bs auth login` can hint. Headless unless `input.headed`. `RunIO.fullRung` is the test seam
  for how `bs auth login` builds it; `createContext()` never registers a full rung.
- `src/auth/doctor.ts` — the `bs auth doctor` checks, each a `{name, ok, status, detail, hint?}`
  row: `node` (>= 22.12), `root` (path, origin, exists/writable; a missing root is fine), `permissions`
  (0700 dirs, 0600 secret files; config.json only warns; skipped on Windows), `session` (cached
  `jwtExpiresAt` only: fresh / expired warn → `bs auth status` / none warn → login), `profile`
  (non-empty `profile/`), `playwright` (lazy import + package version), `browser` (`chromium` →
  `chromium.executablePath()` exists; `chrome`/`msedge` families → playwright's per-platform paths in
  `channelExecutables()`; other channels warn) and the anonymous `GET /d2l/api/versions/` as
  `tenant` + `lp` + `le` (configured == LatestVersion ok; in SupportedVersions warn with
  `BS_LP_VERSION=<latest>`; else fail; unreachable → `tenant` fails with a retry hint and lp/le are
  "not checked"). Every probe is behind `DoctorDeps` (`RunIO.doctor` overrides it in tests):
  `nodeVersion`, `platform`, `importer`, `playwrightVersion`, `fileExists`, `cliPath` (resolved from
  `playwright-core/package.json`, since `cli.js` is not in the exports map) and `install` (default
  `spawnInstaller`: `node <cli.js> install chromium`, both child streams to stderr). The install hint
  always names the command, the ~300 MB cost and `BS_BROWSER_CHANNEL=chrome` as the no-download route.
- `src/auth/credentials.ts` — where `bs auth login` gets its credentials, in one fixed order:
  `BS_EMAIL` + `BS_PASSWORD` (both or neither; one alone is `ConfigError` exit 10) →
  `--email` + `--password-stdin` (whole stdin, one trailing newline trimmed) → `credentials.json`
  (`readCredentialsFile()`; corrupt = absent) → a TTY prompt on stderr (readline for the email,
  closed before the raw-mode masked password read) → no terminal / `--no-input` is
  `AuthRequiredError` exit 4 at once with `HINT_CREDENTIALS`. `writeCredentialsFile()` (atomic,
  0600) is the only writer and only `--save-credentials` calls it. The password never reaches a
  log, a prompt echo, or an error message.
- `src/d2l/` — the typed D2L route layer commands call (one file per resource, evidence in
  `docs/evidence/d2l-api-web.md`). `common.ts`: `LpTenant`, `LeTenant`, `d2lId()` (string D2LID → number when
  numeric), `orgUnitRefOf()`. `links.ts`: every deep-link template from PRD 6.3 (`courseHomeUrl`,
  `assignmentUrl`, `quizUrl`, `gradebookUrl`, `announcementsUrl`); nothing else derives URLs.
  `users.ts`: `whoami()`, `userOf()`. `courses.ts`: `enrollmentsUrl()` (query builder:
  `orgUnitTypeId`/`isActive`/`startDateTime`/`sortBy`), `listEnrollments()` (async iterable over
  `pagedResultSet`; `--limit` stops fetching), `getEnrollment()`, `getCourse()`, and the pure
  parsers `courseOf()`/`courseDetailOf()` onto the PRD 6.3 Course shape (every value read, only
  `url` computed, dates through `isoSeconds`). Route helpers take `(http, cfg, ...)` where `cfg`
  is the tenant config (versions from `lpVersion`/`leVersion`, never hard-coded). `LeTenant`
  (the LE twin of `LpTenant`) is defined once in `common.ts` and re-exported by quizzes, grades,
  assignments, announcements and content, so either import path resolves.
  `content.ts`: `contentTocUrl()`/`contentTopicUrl()`/`contentTopicFileUrl()`/`contentModuleStructureUrl()`,
  `getToc()`, `getTopic()` (400 → UsageError), `getModuleStructure()`, `streamTopicFile()` (a
  `StreamOutcome` for the command to classify), and the pure parsers `tocTree()`/`flattenToc()` (PRD 6.3
  Topic shape with `kind: 'content'`, `path` (module titles joined with " / ", wrapped under
  `--wrap-untrusted` because the row kind is `content`), `depth`; the server `Url` absolutised, never templated;
  CONTENTACTIVITYTYPE_T / CONTENT_TOPIC_T mapped to names with the numeric id kept),
  `topicDetailOf()`, `moduleChildOf()`/`moduleChildren()`, plus `fileNameFromTopicUrl()` (the
  basename of a File topic's `Url`; header parsing and sanitising live in `src/cli/download.ts`).
  `quizzes.ts`: `quizzesUrl()`/`quizItemUrl()`/`quizAttemptsUrl()`, `listQuizzes()` and
  `listAttempts()` (async iterables over `objectListPage`, which rejects the dropbox bare-array
  shape), `getQuiz()`, and the pure parsers `quizOf()`/`quizDetailOf()`/`attemptOf()` onto the PRD
  6.3 Item shape with `kind: 'quiz'` (`attemptsAllowed`/`unlimitedAttempts` from `AttemptsAllowed`,
  `timeLimit` from `SubmissionTimeLimit`; rich text read from either `{Text:{Text,Html},IsDisplayed}`
  or flat `{Text,Html}`; `instructions`/`feedback` are text only so every free-text key is one
  `--wrap-untrusted` wraps).
  `grades.ts`: the three gradebook routes (`listGradeObjects`
  bare array; `listMyGradeValues` maps 404 → `[]`; `getMyFinalGrade` maps 404 → `null`), and the
  pure parsers `gradeTypeOf()` (GRADEOBJ_T 1..9 incl. the tenant's category row, numeric
  `GradeObjectTypeId` before the docs' `GradeType` string), `gradeValueOf()`, `gradeOf()`,
  `joinGrades()` (objects keep their order, orphan values follow) and `finalGradeOf()`.
  `assignments.ts`: the dropbox routes (`foldersUrl()` bare array, `folderUrl()`,
  `mySubmissionsUrl()`, `attachmentUrl()`, `submissionFileUrl()`), `listFolders()` /
  `getFolder()` / `listMySubmissions()` (a non-array 2xx is a shape error), the pure parsers
  `assignmentOf()` / `assignmentDetailOf()` / `submissionOf()` (`Id` and `Name` fatal, every
  other field survives as null; `url` is always `assignmentUrl()`, never
  `LinkAttachments[].Href`) and `enumName()` (int index or name → canonical name).
  `announcements.ts`: `newsUrl()`/`attachmentUrl()`, `listNews()` (bare array or a shape error),
  `streamAttachment()` (non-2xx classified like any route), and the pure parsers
  `announcementOf()`/`announcements()` onto the PRD 6.3 Announcement shape with the
  Brightspace-Bar rules: drop only `IsPublished === false`, `date = StartDate ?? CreatedDate`
  (unreadable falls through), sort newest-first with undated last, attachment `size` from
  `FileSize` then `Size` (the tenant sends `Size`), `bodyText` from `Body.Text` else
  `stripHtml(Body.Html)`.
  `discussions.ts`: `forumsUrl()`/`topicsUrl()`/`postsUrl()` (`sort=-creationdate`, optional
  `threadsOnly`), `listForums()`/`listTopics()` (bare arrays; anything else is "expected a bare
  array"), `listPosts()` (page-numbered async iterable) and the pure parsers `forumOf()`/`topicOf()`
  (PRD 6.3 Discussion topic; `forumId` from the payload, falling back to the listed forum)/`postOf()`
  (PRD 6.3 post: `author` = `PostingUserDisplayName`, `authorId` via `d2lId`, `replies` =
  `ReplyPostIds`, `attachments[{fileId,fileName,size}]`, `url` = thread view, else topic view).
  `calendar.ts`: `EVENT_TYPES` (EVENTTYPE_T names → numbers), `myEventsUrl()`/`listMyEvents()`
  (ObjectListPage over `orgUnitIdsCSV`/`startDateTime`/`endDateTime`/`eventType`, ≤100 org units
  per request) and `eventOf()` onto the PRD 6.3 Event shape (`type` the EVENTTYPE_T name, `url` =
  `CalendarEventViewUrl` else `calendarUrl(ou)`). `links.ts` also holds `discussionsUrl`,
  `discussionTopicUrl`, `discussionThreadUrl` and `calendarUrl` (standard D2L paths, not yet
  probed live).
  `upcoming.ts`: `chunkOrgUnits()` (<=100 ids), `myItemsDueUrl()`/`listMyItemsDue()` (ObjectListPage
  over `content/myItems/due/?orgUnitIdsCSV=`, one walk per chunk; d2l-api-web Extra E),
  `scheduledItemOf()` (ScheduledItem → Item with `kind: 'content'`; string `OrgUnitId` via `d2lId`,
  `ItemUrl` absolutised through `content.ts` `absoluteUrl`, never templated), the
  `candidateOf*()` adapters from the Assignment/Quiz/DiscussionTopic shapes, and the pure
  `mergeUpcoming(sources, {now, days}, courseNames)` (window inclusive at both ends, dedupe by
  `(kind, id)` first wins, sort by `dueDate`, `title`, `kind`, `id`; failures copied through).
- `src/cli/commands/schema.ts`, `version.ts`, `whoami.ts` — the three side-effect-free commands
  (`bs schema` is JSON only and rejects `--plain`; `bs version` prints `{version, commit, date}`).
- `src/cli/commands/skill.ts` — `bs skill [--check [file]]` (bs-u1f): renders the agent SKILL.md
  from the live schema and prints it on stdout (`--json` wraps it as `{markdown}`; the text is
  local metadata, so `--wrap-untrusted` never applies). `--check` compares the render with
  `skills/bs/SKILL.md` (or the given file): exit 0 when identical, exit 1 with the first
  differing line and `Run: npm run skill` when stale. Creates no state dir, opens no browser.
- `src/schema/schema.ts` — `bs schema --json` from the live commander tree.
- `src/skill/render.ts` — `renderSkill(doc, {version})`, the pure renderer behind `bs skill`
  (PRD 10.2). Nothing is hand-listed: the `| Command | Purpose |` table is the schema's leaf
  commands in schema order, the exit-code table is `EXIT_CODES`, the env table is `CONFIG_ENV`
  + `DEFAULT_CONFIG`. It renders the version but never the build commit or date, so the file is
  byte-stable across builds. `leafCommands()`, `cleanCell()` (pipes escaped, newlines flattened)
  and `firstDifference()` live here.
- `src/buildinfo.ts` — version from `package.json`; commit/date from `dist/buildinfo.json`
  (written by `scripts/buildinfo.mjs` during `npm run build`; "unknown" in dev).
- `test/**/*.test.ts` — hermetic `node:test` suites mirroring `src/` (`test/core/paths.test.ts`
  tests `src/core/paths.ts`). `test/helpers/cli.ts` runs the CLI with captured streams (pass
  `transport` to script HTTP); `test/helpers/http.ts` fakes the transport; `test/helpers/auth.ts`
  builds fake sessions/JWTs, loads the auth fixtures and asserts secret-free output.
  `test/auth/no-playwright-load.test.ts` spawns `test/helpers/playwright-probe.ts` to prove
  `--help`, `version`, `schema`, `skill`, `auth status` and `auth doctor --help` never load
  `playwright-core`.
  `test/auth/doctor-command.test.ts` drives `bs auth doctor` with fake `RunIO.doctor` deps (no
  download, no launch) and a scripted versions probe.
  `test/fixtures/` holds recorded payloads with a provenance README. `test/live/` (behind
  `BS_LIVE=1`) is the only place that may touch the tenant.
- `test/cli/skill.test.ts` — the SKILL.md render (required blocks, every schema leaf command in
  the table exactly once, the footer without the commit), `--check` on a matching and a stale
  file, the `--json` shape, and that the committed `skills/bs/SKILL.md` is the current render.
- `test/cli/download.test.ts` — unit tests for the shared download plumbing (names, `--out`
  resolution, `.part` + rename, the overwrite rule, stdout sink backpressure).
- `test/commands/<name>.test.ts` — hermetic command suites: seed a session in a temp `--root`
  (`tempRoot()` + `writeSession(fakeSession({jwt}))`), script HTTP with `fakeTransport`, assert
  on exit code, stdout, stderr and the recorded requests. `test/d2l/` unit-tests the pure
  builders and parsers on the recorded fixtures.
- `skills/bs/SKILL.md` — generated by `npm run skill`; never edited by hand. `npm run skill:check`
  fails the build when it is stale.
- `reference/` — vendored reference projects (read-only, excluded from lint).

## Build, test, lint

- `npm run build` — `tsc` to `dist/`, then writes `dist/buildinfo.json`.
- `npm run dev -- <args>` — run from source via `tsx` (e.g. `npm run dev -- schema --json`).
- `npm test` — `node --test --import tsx "test/!(live)/**/*.test.ts"` (hermetic: no network,
  no browser). The glob deliberately excludes `test/live/`; see "Live E2E" below.
- Run one file: `node --test --import tsx test/core/output.test.ts`.
- Run one test: `node --test --import tsx --test-name-pattern "select" test/core/output.test.ts`.
- `npm run lint` / `npm run lint:fix` — Biome check / auto-fix (format + lint).
- `npm run typecheck` — type-checks `src/`, `test/` and `scripts/` without emitting.
- `npm run skill` — rebuilds and regenerates `skills/bs/SKILL.md` from the built binary.
  `npm run skill:check` re-renders and diffs it; run it after adding or renaming any command,
  changing a command description, an exit code or a tenant knob, and commit the result.
- `npm run build && npm test && npm run lint && npm run typecheck && npm run skill:check` must all
  be green before a ticket closes.

## Live E2E (`test/live/`, `scripts/e2e.sh`) — bs-bo2

Everything that touches the real tenant lives behind `BS_LIVE` and is kept out of `npm test`.
Nothing here holds a credential: both entry points read an existing `BS_ROOT`, and tier 2 (the one
tier that needs an MFA tap) is documented, never automated.

- `test/live/harness.ts` — the only seam the live suites use, and the only part of them that is
  hermetically testable: `liveGate()` (skip cleanly when `BS_LIVE` is unset), `requireLiveRoot()` /
  `requireBuild()` (fail fast with the command that fixes it), `runBs()` (spawns
  `node dist/bin/bs.js` so the tests exercise the shipped binary, its exit codes and its
  stdout/stderr split), `parseJsonStdout()` / `itemsOf()` / `describeRun()`, `chooseCourse()` (the
  first enrollment that is both `isActive` and `canAccess` — 25 of 27 are past-term and 403 on
  every per-course route) and `isDeepLinkAlive()`.
- `test/live/tier0.test.ts` — a session is already in place: `auth status`, `whoami`,
  `courses list`, then the chosen course's `assignments`/`quizzes`/`grades`/`announcements`/
  `content toc --flat`/`discussions forums`+`topics`/`calendar events`, `upcoming` (its `failures`
  may only hold past-term 403s), `api GET /d2l/api/lp/<lp>/users/whoami` against `whoami`, the
  generated deep links fetched with the session cookies and asserted non-404 (bs-fwr), and the
  output contract (`--wrap-untrusted`, `--plain`, `--select`, `--fail-empty` → exit 3).
- `test/live/tier1.test.ts` — tier 1 (opt in with `BS_LIVE_TIER=1`): `BS_ROOT` is copied to a
  temp directory, the copy loses `session.json`, and `bs auth refresh` must re-mint from the
  surviving `profile/` (headless Chromium). The real root is never mutated. Tier 2 is a skipped
  test carrying the manual commands.
- `test/live-harness/*.test.ts` — hermetic, inside `npm test`: the gate, the fail-fast messages,
  the parsing helpers, the course choice, the redactor, and `scripts/e2e.sh`'s refusals (spawned).
- `scripts/e2e.sh` — the PRD 12 Definition-of-done run: refuses without `BS_LIVE=1` and `BS_ROOT`
  (exit 2, before it builds or creates anything), builds, preflights `bs auth doctor --json` (a
  failing `browser`/`playwright` row is only a warning here) and the anonymous
  `GET /d2l/api/versions/`, then runs the DoD commands in order, each with its exit code and a
  one-line summary, and prints one pass/fail table (exit 1 if any required check failed).
  `--tier 1` adds the refresh tier on a copy of the root; `--keep` leaves the per-check logs under
  `$BS_ROOT/cache/e2e/<timestamp>/`; `--ou <id>` overrides the course choice.
- `scripts/lib/redact.mjs` — the fail-closed scrubber every captured stderr passes through before
  it reaches a log or the terminal (`Authorization`, `cookie`, `x-csrf-token`, `d2lSessionVal*`,
  `Bearer …`, passwords, and anything JWT-shaped). Plain ESM so bash can run it with bare `node`;
  `scripts/lib/redact.d.mts` is what lets the hermetic test import it.

How the orchestrator runs them (from a root that already holds a session):

```sh
npm run build
BS_LIVE=1 BS_ROOT="$HOME/Library/Application Support/bs" npm run test:live              # tier 0
BS_LIVE=1 BS_LIVE_TIER=1 BS_ROOT="$HOME/Library/Application Support/bs" npm run test:live  # + tier 1
BS_LIVE=1 BS_ROOT="$HOME/Library/Application Support/bs" bash scripts/e2e.sh [--tier 1] [--keep]
```

`npm run test:live` without `BS_ROOT` (or against a root with no `session.json`) fails immediately
with the command that fixes it; `bash scripts/e2e.sh` without `BS_LIVE=1` exits 2 having done
nothing. Tier 2 stays manual: `bs auth login` against an empty root, one Authenticator number.

## Rules

- **Stdout is an API.** Only data goes to stdout (`--json` / `--plain` / the human rendering
  of a result). Progress, prompts, warnings and errors go to stderr through `ctx.log`,
  `ctx.warn`, `ctx.debug` or a thrown `BsError`.
- **Exit codes come from `src/core/errors.ts` only.** Throw a `BsError` subclass; never call
  `process.exit` outside `src/bin/bs.ts`, never invent a numeric code.
- **Secrets never leak (PRD 8.2).** Cookies, XSRF tokens, JWTs and passwords are never
  printed, logged, serialized into output, or committed. `--verbose` logs lengths and labels
  only. Credentials reach child processes via env, never argv.
- `--help`, `version`, `schema` and `skill` must stay side-effect free: no state directory, no
  network, no `playwright-core` import (import it lazily inside the auth rungs only).
  `test/auth/no-playwright-load.test.ts` proves it from a child process.
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
