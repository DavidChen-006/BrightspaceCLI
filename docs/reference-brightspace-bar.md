# Reference study: `Brightspace-Bar` — how to access and use the D2L endpoints

Source: `reference/Brightspace-Bar` (DavidChen-006/Brightspace-Bar, Swift +
Node, MIT). The question it answers: **"How do I access and use the
Brightspace D2L endpoints?"** The Swift half is a menu-bar renderer and is not
relevant here; the whole answer lives in the Node daemon `session-capture/`
and the ground-truth design doc `docs/LADDER-PLAN.md`.

## 1. The access model in one paragraph

Purdue Brightspace sits behind Microsoft Entra SSO with number-match MFA.
There is no API key or OAuth client a student can register, so the daemon
**captures a real browser session**: a persistent Chromium profile (Playwright)
holds the Entra cookie (`ESTSAUTHPERSISTENT`, ~90-day life); loading
`/d2l/home` re-mints the D2L cookies silently through SSO; the page's JS
context yields an XSRF token; cookie + XSRF mint a short-lived JWT via
`POST /d2l/lp/auth/oauth2/token`; every REST call then carries
`Authorization: Bearer <jwt>`. Credentials are typed once by the human (or
autofilled from a 0600 file) and never logged.

```
Entra cookie (profile/) ─silent SSO─▶ d2lSessionVal + d2lSecureSessionVal
        ─page load─▶ XSRF token ─POST oauth2/token─▶ JWT ─Bearer─▶ /d2l/api/…
```

## 2. The login ladder (docs/LADDER-PLAN.md, src/orchestrate.mjs, src/rungs/)

The daemon "climbs" only as far as it must:

| Rung | Kind | Human? | Mechanism | File |
| --- | --- | --- | --- | --- |
| 0 | existing creds | no | read `session.json`, try to mint JWT | `fetch-engine.mjs` |
| 1 | silent | no | headless persistent profile, `trySilentLogin` → cookies + XSRF | `rungs/silent.mjs`, `rungs/browser.mjs`, `login-flow.mjs` |
| 2 | full | yes (MFA tap) | autofill email/password, scrape number-match digits, wait for auth | `rungs/full-login.mjs`, `rungs/browser.mjs`, `rungs/mfa-file.mjs` |

Rules pinned by tests (binding):

- A rung is a value `{ kind: "silent"|"full", attempt({paths, log}) → {ok} | {ok:false, reason} }`. Success is a side effect on `session.json`.
- `sessionExpired` is the **only** fetch failure that makes the ladder climb; transport/outage errors never drag a human through a login.
- `full` rungs run only with `--allow-full-login` (proof a human is present). Unattended runs may never open a window or prompt.
- A failed run never truncates existing data; `status.json` reports the truth, carrying forward `lastSuccessAt`.
- Exit codes: `0` fresh, `2` needs-login, `1` unexpected error.

### Silent SSO mechanics (`login-flow.mjs`)

- `trySilentLogin(page, context, baseUrl, log, timeoutMs=30s)`: `goto ${base}/d2l/home`, poll `isAuthenticated`; if an email field becomes visible, fail immediately (silent can never pass "who are you?").
- `isAuthenticated`: **positive** check — `d2lSessionVal` cookie present **and** `window.D2L.LP` reachable. URL-shape is not a signal (the login stub sets cookies too).
- `clickThroughSilentSurfaces`: two no-secret clicks — the Brightspace campus selector (`Purdue West Lafayette`, tenant-specific) and Microsoft's "Stay signed in? → Yes" (`#idSIButton9`, only when `#KmsiCheckboxField` or the KMSI title proves it is that page).
- `extractXsrf`: `window.D2L.LP.Web.Authentication.Xsrf.GetXsrfToken()` with `meta[name="d2l-xsrf-token"]` fallback, polled 10×1s.

### Full login mechanics (`rungs/browser.mjs`)

- Headless by default (`BSB_FULL_HEADED=1` shows the window).
- Selectors: email `input[type=email]`, `input[name=loginfmt]`; password `input[type=password]`, `input[name=passwd]`; submit `#idSIButton9`, `input[type=submit]`, `button[type=submit]`. Fields are polled every 250 ms for up to 30 s (`fillWhenReady`/`clickWhenReady`), so a page that never shows a field fails promptly.
- MFA number-match digits are plain DOM text at `#idRichContext_DisplaySign`; polled every 2 s for up to 5 min; announced on change via `onMfaNumber` (written to `cache/mfa.json` `{number, mintedAt}` for the app, deleted on every exit path).
- Credentials come from env `BS_EMAIL`/`BS_PASSWORD` (both must be set) else `credentials.json` (0600) via `credentials.mjs`; the password is typed, never logged.

### Session file contract (`session.mjs`)

```json
{ "capturedAt": 1755..., "baseUrl": "https://purdue.brightspace.com",
  "cookieHeader": "d2lSessionVal=…; d2lSecureSessionVal=…",
  "cookies": [{"name":"d2lSessionVal","value":"…"}, {"name":"d2lSecureSessionVal","value":"…"}],
  "csrfToken": "…", "landedUrl": "https://…/d2l/home" }
```

Cookie order is fixed so two captures of one session are byte-identical.

### Session lifetime (session-capture/README.md)

| Age | State |
| --- | --- |
| 4.4 h | alive |
| 15.6 h | dead: mint returns HTTP 200 + HTML stub containing `sessionExpired=1` |
| 28.4 h | dead: mint returns hard `403 Not authenticated` |

Two different death signatures on the same endpoint; code must check the
marker first, then status. The mint also answers 403 when `x-csrf-token` is
missing even with a good cookie.

## 3. The endpoints (`src/fetch-engine.mjs`)

Versions confirmed against the tenant's `GET /d2l/api/versions/`:
`LP_VERSION = "1.62"`, `LE_VERSION = "1.96"`.

| Purpose | Request | Auth | Response shape |
| --- | --- | --- | --- |
| Mint JWT | `POST {base}/d2l/lp/auth/oauth2/token`, body `scope=*:*:*`, `content-type: application/x-www-form-urlencoded` | `cookie:` header + `x-csrf-token:` | `{ "access_token": "…", … }`; dead session = 200 + stub with `sessionExpired=1` |
| Enrollments | `GET {base}/d2l/api/lp/1.62/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true` | Bearer | `{ "Items": [ { "OrgUnit": {Id, Name, Code, HomeUrl}, "Access": {IsActive, ClasslistRoleName, StartDate, EndDate} } ] }`; **paginates at 100** when unfiltered |
| Assignments | `GET {base}/d2l/api/le/1.96/{ou}/dropbox/folders/` | Bearer | **bare array** of `{Id, Name, DueDate, GradeItemId, …}` |
| Quizzes | `GET {base}/d2l/api/le/1.96/{ou}/quizzes/` | Bearer | `{ "Objects": [ {QuizId, Name, DueDate, GradeItemId, …} ] }` |
| Gradebook | `GET {base}/d2l/api/le/1.96/{ou}/grades/` | Bearer | bare array of grade objects `{Id, Name, GradeObjectTypeId, AssociatedTool{ToolId, ToolItemId}}`; types 1–4 are student-scored |
| My grade values | `GET {base}/d2l/api/le/1.96/{ou}/grades/values/myGradeValues/` (per LADDER-PLAN survey) | Bearer | array with `LastModified` etc. |
| Announcements | `GET {base}/d2l/api/le/1.96/{ou}/news/` | Bearer | bare array of `{Id, Title, IsPublished, StartDate, CreatedDate, …}` |
| Content TOC | `GET {base}/d2l/api/le/1.96/{ou}/content/toc` (survey rung 2 item) | Bearer | modules/topics with quickLink `Url`, `ToolId`, `ToolItemId` |
| Discussions | `GET {base}/d2l/api/le/1.96/{ou}/discussions/forums/` + topics (survey) | Bearer | topics carry `DueDate`, `ScoringType`, `ScoreOutOf` |

Deep links (harvested from Brightspace's own markup):

- Assignment: `{base}/d2l/lms/dropbox/user/folder_submit_files.d2l?db={folderId}&grpid=0&ou={ou}`
- Quiz: `{base}/d2l/lms/quizzing/user/quiz_summary.d2l?qi={quizId}&ou={ou}`
- Gradebook: `{base}/d2l/lms/grades/my_grades/main.d2l?ou={ou}`

Behaviour measured on this tenant:

- `403` on per-course routes is the normal steady state for past-term courses (not an error condition worth escalating).
- `HomeUrl` is null on 25 of 27 enrollments.
- Dates arrive as `2026-03-01T04:59:00.000Z` and sometimes `2026-09-15T23:59:00Z`; normalize to whole seconds UTC.
- Calendar (`/calendar/events`) is empty on this tenant (instructors do not opt in); dropped.
- Grade columns can point to quizzes the student's `quizzes/` call cannot see (release-gated); neither list is a superset of the other.

## 4. Failure taxonomy (fetch-engine.mjs header)

- HTTP is the one injected effect; parsers are pure functions of `(status, body)`, so classification is testable without a socket.
- Only the two whole-run steps (mint, enrollments) may report `sessionExpired`. A stub on one course's route is that course failing; the next run's mint self-heals it.
- Per course, the four routes run in `Promise.all`; the course is "unknown" only when **both** content routes (dropbox, quizzes) fail; gradebook and news add rows or report why they could not, they never veto.
- "Fatal id, survivable date": a row without id/name fails its list (would be unclickable), an unreadable date costs one field.
- A missing `session.json` is the same answer as an expired one: a rung can produce it.

## 5. On-disk layout and isolation (`paths.mjs`)

Everything hangs off one root (`BSB_ROOT`, default
`~/Library/Application Support/BrightspaceBar`):

| Path | What | Sensitivity |
| --- | --- | --- |
| `profile/` | persistent Chromium profile (Entra cookie) | credential store |
| `session.json` | D2L cookies + XSRF | secret, 0600 |
| `credentials.json` | email + password (optional) | secret, 0600 |
| `cache/data.json` | courses + items + announcements | data |
| `cache/status.json` | `{state, rungUsed, lastAttemptAt, lastSuccessAt, error}` | data |
| `cache/mfa.json` | ephemeral number-match digits | display-only |

Tests point the root at a temp dir; that is the entire isolation story.
Writes are atomic (temp file + rename, `atomic-write.mjs`).

## 6. Secrets discipline (invariant D7)

Cookies, CSRF token, JWT, and password are read from files, sent as headers,
and **never logged, never returned to callers, never written to the cache**.
Logs print lengths or labels only.

## 7. Testing approach

- `node:test` hermetic suites with fake rungs and fake HTTP; seam-contract
  tests run every fake and real rung/fetcher through the same assertions.
- Fixture tests record real payload shapes (`myenrollments-200.json`).
- Live tests gated by `BS_LIVE=1`; a tiered E2E: tier 0 (live session →
  refetch), tier 1 (creds deleted, profile kept → silent re-mint), tier 2
  (empty root → full login, one MFA).

## 8. What the Brightspace CLI should take from this

1. **Port the session ladder as-is**: profile dir + `session.json`, silent rung, full rung, `sessionExpired`-only climb rule, `--allow-full-login` style gate (the CLI's `login` command is the human-present path).
2. **Port `fetch-engine.mjs`'s request builders and parsers**: mint, enrollments, dropbox, quizzes, grades, news, plus the survey-identified content TOC and discussions routes.
3. **Keep the failure taxonomy and exit-code semantics**, mapped onto the richer gogcli exit-code table (needs-login → `auth_required`).
4. **Keep the secrets discipline** (D7) and the single-root `paths` module with an env override (`BS_ROOT`).
5. **Reuse Playwright + Chromium** for the browser rungs; the CLI is therefore Node/TypeScript (the daemon is Node, and no Go toolchain is installed here).
6. **Tenant-specific bits belong in config**: base URL, campus-selector text, LP/LE versions.
7. Add a `raw` command (`bs api GET /d2l/api/le/1.96/{ou}/…`) so agents can reach endpoints the curated commands do not model yet.
