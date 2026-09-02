# PRD: `bs` — a Brightspace (D2L) CLI for AI agents

Status: **DRAFT v0.1 (no references consulted yet)**. Every statement whose
exact technical implementation is not known for certain is tagged
`[A-nn]` (assumption). Assumptions are resolved to evidence in the
"Evidence" column of §12 before the PRD is frozen.

## 1. Problem

AI coding/assistant agents need to read a student's Brightspace (D2L) data
(courses, assignments, quizzes, grades, announcements, content) from a shell.
Brightspace at Purdue sits behind Microsoft Entra SSO with number-match MFA, so
no API key exists for a student. A prior project (Brightspace-Bar) proved a
browser-session-capture approach for a GUI app; nothing exposes it as an
agent-friendly CLI.

## 2. Goals

1. One command surface for humans, scripts, and agents: stable `--json` output,
   named exit codes, errors that say what to run next.
2. Zero-friction reads once logged in: `bs courses list --json` works for weeks
   without a human, via silent SSO re-mint.
3. Exactly one human moment per Entra session (one MFA tap), initiated only by
   an explicit `bs auth login`.
4. Secrets never appear in stdout, logs, the repo, or agent transcripts.
5. A machine-readable contract (`bs schema --json`) and a generated agent
   `SKILL.md`.

## 3. Non-goals (v1)

- Writes to Brightspace (submitting assignments, posting discussions). All v1
  commands are read-only; the HTTP layer enforces it.
- Instructor/admin APIs.
- A daemon or background refresh; every invocation is run-and-exit (a cache is
  optional, see §8).
- Tenants other than Purdue Entra in v1, though the tenant knobs are config.
- MCP server (deferred; the CLI contract is designed so one can be added).

## 4. Users and primary flows

- **Agent** (Claude Code, etc.): `bs auth status --json` → if `auth_required`,
  ask the human to run `bs auth login` → `bs upcoming --json`,
  `bs assignments list <ou> --json`, `bs content get …`.
- **Human at terminal**: `bs auth login` (types MFA number into phone),
  `bs courses list`, `bs upcoming`.
- **Script/CI**: `bs --no-input --json …`, branch on exit code.

## 5. Language, runtime, packaging

- TypeScript on Node ≥ 20, ESM, strict mode. Rationale: the proven login
  ladder and fetcher are Node + Playwright; no Go toolchain on this machine;
  Playwright is Node-native. `[A-01]` Node 20 is a sufficient floor for the
  APIs used (global `fetch`, `node:test`).
- Browser automation: Playwright + bundled Chromium. `[A-02]` Playwright's
  `chromium.launchPersistentContext` is the right primitive for a persistent
  Entra profile.
- CLI framework: `commander`. `[A-03]` commander exposes enough introspection
  (command tree, options, descriptions) to generate `schema --json` and
  `SKILL.md` from the live program.
- Build: `tsc` to `dist/`, `bin: { "bs": "dist/bin/bs.js" }`; run in dev via
  `tsx`. `[A-04]` a plain `tsc` build (no bundler) is enough for an npm
  bin and `npx` usage.
- Tests: `node:test` + `node:assert` (zero extra deps), `c8` for coverage
  optional. Live tests gated by `BS_LIVE=1`.
- Lint/format: `biome` (single tool). `[A-05]`
- Distribution: npm package `brightspace-cli` (bin `bs`), also
  `npm link` for local use. Postinstall runs `playwright install chromium`.
  `[A-06]` postinstall browser download is acceptable for users (≈150 MB).

## 6. Command surface

Binary: `bs`. Pattern: `bs <resource> <verb> [args] [flags]`.

### 6.1 Global flags (apply anywhere)

| Flag | Env | Meaning |
| --- | --- | --- |
| `--json` | `BS_JSON=1` | JSON to stdout (data only) |
| `--plain` | `BS_PLAIN=1` | TSV to stdout; no color |
| `--results-only` | | unwrap the envelope (requires `--json`) |
| `--select a,b.c` | | project fields (requires `--json`) |
| `--wrap-untrusted` | | mark fetched free text as untrusted for LLM readers |
| `--no-input` | `BS_NO_INPUT=1` | never prompt; fail with `auth_required`/`usage` |
| `--readonly` | `BS_READONLY=1` | reject non-GET at the HTTP layer (default **on** in v1) |
| `--color auto|always|never` | `BS_COLOR`, `NO_COLOR` | |
| `--base-url` | `BS_BASE_URL` | tenant, default `https://purdue.brightspace.com` |
| `--root` | `BS_ROOT` | state directory (profile, session, cache) |
| `--timeout <s>` | `BS_TIMEOUT` | per-request timeout, default 30s `[A-07]` |
| `--verbose` | `BS_VERBOSE=1` | debug logs to stderr (never secrets) |

`--json` and `--plain` together → usage error (exit 2).

### 6.2 Commands

| Command | Purpose | Notes |
| --- | --- | --- |
| `bs auth login [--headed] [--email <e>] [--password-stdin]` | Climb the full ladder with a human present | Prints MFA number to stderr and to `cache/mfa.json`; `--no-input` → fails fast |
| `bs auth status` | Report session state without a browser | states: `fresh`, `expired`, `none`; exit 0 or 4 |
| `bs auth refresh` | Silent rung only (cron-safe) | exit 0 or 4 |
| `bs auth logout [--purge-profile]` | Delete `session.json` (and optionally the Chromium profile) | confirm unless `--force` |
| `bs auth doctor` | Check Node, Playwright/Chromium, root perms, base URL reachability | |
| `bs whoami` | Current user | `[A-08]` `GET /d2l/api/lp/{lp}/users/whoami` exists and returns `{Identifier, FirstName, LastName, UniqueName}` |
| `bs courses list [--all] [--inactive]` | Enrollments | default filter `orgUnitTypeId=3&isActive=true`; `[A-09]` pagination uses a `bookmark` query param with `PagingInfo.HasMoreItems` |
| `bs courses get <ou>` | One course | `[A-10]` `GET /d2l/api/lp/{lp}/courses/{ou}` |
| `bs assignments list <ou>` | Dropbox folders | bare array |
| `bs assignments get <ou> <folderId>` | One folder incl. instructions | `[A-11]` `GET …/dropbox/folders/{id}` |
| `bs assignments submissions <ou> <folderId>` | My submissions | `[A-12]` `GET …/dropbox/folders/{id}/submissions/mine/` |
| `bs quizzes list <ou>` | Quizzes | `{Objects:[…]}` envelope |
| `bs quizzes get <ou> <quizId>` | One quiz | `[A-13]` `GET …/quizzes/{id}` |
| `bs grades list <ou>` | Grade objects joined with my values | `[A-14]` `GET …/grades/values/myGradeValues/` returns `[{GradeObjectIdentifier, DisplayedGrade, PointsNumerator, PointsDenominator, …}]` |
| `bs grades final <ou>` | My final grade | `[A-15]` `GET …/grades/final/values/myGradeValue` |
| `bs announcements list <ou> [--limit n]` | News items | HTML body → text, `--raw-html` keeps it `[A-16]` |
| `bs content toc <ou>` | Table of contents (modules/topics tree) | `[A-17]` `GET …/content/toc` |
| `bs content get <ou> <topicId>` | Topic metadata | `[A-18]` `GET …/content/topics/{id}` |
| `bs content download <ou> <topicId> [--out path|-]` | Topic file bytes | `[A-19]` `GET …/content/topics/{id}/file` streams the file |
| `bs discussions forums <ou>` / `topics <ou> <forumId>` / `posts <ou> <forumId> <topicId>` | Discussions | `[A-20]` `…/discussions/forums/`, `…/forums/{f}/topics/`, `…/topics/{t}/posts/` |
| `bs calendar events <ou> [--from --to]` | Calendar events | `[A-21]` `GET …/calendar/events/` (empty on this tenant, kept for others) |
| `bs upcoming [--days 14] [--kinds assignment,quiz]` | Workflow: every active course's dated items, sorted | fan-out with bounded concurrency `[A-22]` 6 is safe |
| `bs api <METHOD> <path> [--body @file|json] [--query k=v]` | Raw escape hatch | Bearer auto-attached; `--readonly` blocks non-GET |
| `bs schema [cmd...] --json` | Machine contract | command tree, flags, exit codes, safety |
| `bs skill` | Print the generated agent `SKILL.md` | |
| `bs version` | | |

Every list command also supports `--raw` to return the lossless D2L payload.

### 6.3 Output shapes (curated JSON)

Envelope for lists: `{ "items": [...], "count": n, "fetchedAt": ISO }`.
Single: the object itself. Dates normalized to whole-second UTC ISO-8601
(`2026-09-15T23:59:00Z`). IDs are numbers. Every item carries a `url` deep link
where one is known.

Course: `{ id, name, code, role, isActive, startDate, endDate, homeUrl }`.
Item (assignment/quiz): `{ id, courseId, kind, title, dueDate, startDate, endDate, url, gradeItemId, instructions? }`.
Grade: `{ id, name, type, maxPoints, weight, myValue: { displayed, numerator, denominator, lastModified } | null, url }`.
Announcement: `{ id, courseId, title, body, bodyText, date, url }`.

### 6.4 Exit codes

| Code | Name | When |
| ---: | --- | --- |
| 0 | ok | |
| 1 | error | unclassified |
| 2 | usage | bad flags/args, contradictory output flags |
| 3 | empty_results | list returned nothing (only where a flag opts in: `--fail-empty`) `[A-23]` |
| 4 | auth_required | no session / expired and silent rung failed / `--no-input` blocked login |
| 5 | not_found | HTTP 404 |
| 6 | permission_denied | HTTP 403 (past-term course, etc.) |
| 7 | rate_limited | HTTP 429 |
| 8 | retryable | HTTP 5xx, network/timeout |
| 10 | config | root not writable, Chromium missing, bad base URL |
| 130 | cancelled | SIGINT |

`bs schema --json` publishes this table under `automation.exit_codes`.

## 7. Authentication design

Port of the Brightspace-Bar ladder, run-and-exit inside each command:

1. **Rung 0**: read `session.json` (cookies + XSRF) → mint JWT via
   `POST /d2l/lp/auth/oauth2/token` (`scope=*:*:*`, `x-csrf-token`). Cache the
   JWT in `session.json` with its expiry to skip re-minting on every command.
   `[A-24]` the JWT carries an `exp` claim (≈ 1 h) that can be decoded without
   verification.
2. **Rung 1 (silent)**: headless Playwright on the persistent profile; navigate
   `/d2l/home`; click campus selector + KMSI "Yes"; positive auth check
   (`d2lSessionVal` cookie **and** `window.D2L.LP`); extract XSRF; write
   `session.json`. Fails fast when an email field appears.
3. **Rung 2 (full)**: only in `bs auth login`. Autofill email/password (env
   `BS_EMAIL`/`BS_PASSWORD`, `--password-stdin`, or interactive prompt on TTY),
   scrape `#idRichContext_DisplaySign`, print "Type NN into Authenticator" to
   stderr, write `cache/mfa.json`, poll up to 5 min, then harvest.

Rules: `sessionExpired` (200 + `sessionExpired=1` stub, or 403 on mint) is the
**only** signal that climbs; other failures map to their exit code. Data
commands climb at most to rung 1; they never open a window or prompt. When
rung 1 fails they exit 4 with the message `Run: bs auth login`.

Tenant knobs (config/env): base URL, campus selector text (`BS_CAMPUS_TEXT`,
default `Purdue West Lafayette`), LP/LE API versions (`BS_LP_VERSION=1.62`,
`BS_LE_VERSION=1.96`). `[A-25]` these versions are still current on the
tenant; `bs auth doctor` verifies via `GET /d2l/api/versions/`.

## 8. State on disk

Root `BS_ROOT`, default `~/Library/Application Support/brightspace-cli` on
macOS, `$XDG_DATA_HOME/brightspace-cli` elsewhere `[A-26]`.

| Path | Content | Mode |
| --- | --- | --- |
| `profile/` | Chromium persistent profile (Entra cookie) | 0700 |
| `session.json` | baseUrl, cookies, cookieHeader, csrfToken, jwt, jwtExpiresAt, capturedAt | 0600 |
| `credentials.json` | optional email/password (only if user opts in via `bs auth login --save-credentials`) | 0600 |
| `cache/mfa.json` | ephemeral number-match digits | 0600 |
| `cache/status.json` | last ladder outcome | 0600 |
| `config.json` | optional overrides (baseUrl, campusText, versions) | 0600 |

Secrets discipline (D7): cookies/CSRF/JWT/password never in stdout, stderr,
logs, or JSON output; logs report lengths only. `--verbose` still redacts.

## 9. HTTP layer

- Single `http` seam (`fetch` wrapper) with injected transport for tests.
- Attaches `Authorization: Bearer`, per-request timeout, retries with jittered
  backoff on 429/5xx/network (max 3) `[A-27]`.
- `--readonly` guard: any method other than GET/HEAD/OPTIONS is rejected
  before dispatch (mint POST is exempt as the auth step).
- Classification: `(status, body)` → typed error (`SessionExpired`,
  `NotFound`, `Forbidden`, `RateLimited`, `Retryable`, `Transport`,
  `BadShape`) → exit code + next-step message.
- Pagination helper for `{Items, PagingInfo{Bookmark, HasMoreItems}}`
  envelopes `[A-09]`.

## 10. Agent contract

- `bs schema --json`: `{ schema_version, commands: [...], global_flags,
  automation: { output_formats, exit_codes, safety } }` generated from the
  commander tree at runtime.
- `bs skill`: generated `SKILL.md` with a "Safe start" block:
  `bs auth status --json --no-input`, `bs schema --json`, `bs upcoming --json
  --wrap-untrusted`; the rule "never guess syntax, read `--help`".
- `AGENTS.md` at repo root: build/test/commit instructions.
- Untrusted wrapping: free-text fields (announcement bodies, instructions,
  discussion posts) wrapped in `<untrusted source="brightspace">…</untrusted>`
  markers when `--wrap-untrusted` `[A-28]` format choice.

## 11. Testing and acceptance

- Hermetic `node:test` suites: parsers on recorded fixtures (myenrollments,
  dropbox, quizzes, grades, news, toc), ladder with fake rungs/fetcher, exit
  code mapping, output modes, schema generation, secret-redaction.
- Live suite behind `BS_LIVE=1`: tier 0 (session present → commands succeed),
  tier 1 (session deleted, profile kept → silent re-mint), tier 2 (empty root
  → `bs auth login`, one MFA).
- E2E definition of done: from a clean root, `bs auth login` completes with
  one MFA, then `bs courses list --json`, `bs upcoming --json`, `bs
  announcements list <ou> --json`, `bs content toc <ou> --json`, `bs api GET
  /d2l/api/lp/1.62/users/whoami --json` all return real data with exit 0;
  `bs auth status` after deleting `session.json` recovers silently (exit 0).

## 12. Assumption register

| ID | Assumption | Evidence (filled during reference sweep) |
| --- | --- | --- |
| A-01 | Node 20 floor suffices | |
| A-02 | Playwright `launchPersistentContext` is the profile primitive | |
| A-03 | commander introspection suffices for `schema --json` | |
| A-04 | plain `tsc` build is enough for the bin | |
| A-05 | biome for lint/format | |
| A-06 | postinstall `playwright install chromium` acceptable | |
| A-07 | 30 s default request timeout | |
| A-08 | `users/whoami` endpoint and shape | |
| A-09 | enrollments pagination via `bookmark` + `PagingInfo.HasMoreItems` | |
| A-10 | `lp/{v}/courses/{ou}` endpoint | |
| A-11 | `dropbox/folders/{id}` single-folder endpoint | |
| A-12 | `dropbox/folders/{id}/submissions/mine/` | |
| A-13 | `quizzes/{id}` single-quiz endpoint | |
| A-14 | `grades/values/myGradeValues/` shape | |
| A-15 | `grades/final/values/myGradeValue` | |
| A-16 | announcement `Body{Html,Text}` shape | |
| A-17 | `content/toc` endpoint and shape | |
| A-18 | `content/topics/{id}` | |
| A-19 | `content/topics/{id}/file` streams bytes | |
| A-20 | discussions forums/topics/posts routes | |
| A-21 | `calendar/events/` route | |
| A-22 | concurrency 6 is safe on the tenant | |
| A-23 | empty_results only with opt-in flag | |
| A-24 | JWT `exp` claim decodable, ~1 h | |
| A-25 | LP 1.62 / LE 1.96 still current | |
| A-26 | state dir conventions per OS | |
| A-27 | retry policy 3× jittered backoff on 429/5xx | |
| A-28 | untrusted wrapper format | |
| A-29 | MFA number-match selector `#idRichContext_DisplaySign` still valid | |
| A-30 | campus selector text `Purdue West Lafayette` still valid | |
| A-31 | PDF export of this PRD via a locally available tool | |

## 13. Milestones (to become beads)

1. Scaffold: package, tsconfig, commander root, global flags, output modes, exit codes, `paths`, `version`, `schema`.
2. HTTP layer + error classification + readonly guard + retries + pagination.
3. Session store + JWT mint (rung 0) + `auth status`.
4. Silent rung (Playwright) + `auth refresh` + `auth logout` + `auth doctor`.
5. Full login rung + `auth login` (MFA relay, credentials input).
6. Courses + whoami.
7. Assignments + quizzes (+ submissions).
8. Grades.
9. Announcements + content (toc/get/download).
10. Discussions + calendar.
11. `upcoming` workflow + `api` raw command.
12. Schema/skill generation, AGENTS.md, README, docs.
13. Live E2E script and final verification.
