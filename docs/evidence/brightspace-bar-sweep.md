# Evidence sweep: Brightspace-Bar (local reference) — 2026-09-02

Produced by an Explore subagent over `reference/Brightspace-Bar`. Paths are
relative to that directory. Items marked NOT FOUND were routed to the D2L web
research wave (`docs/evidence/d2l-api-web.md`).

## A-01 / A-02 — Node floor, Playwright, `launchPersistentContext`

- `session-capture/package.json:5-20`: `"engines": {"node": ">=20"}`, `"playwright": "1.58.2"` (devDependency, exact pin), `"postinstall": "playwright install chromium"`, `"test": "node --test \"tests/**/*.test.mjs\""`.
- `.nvmrc` = `20`; `Makefile:20-21` refuses `make setup` below 20; CI (`.github/workflows/ci.yml:26-27`) runs Node **20 and 22**; CI installs with `npm ci --ignore-scripts` because unit tests import playwright but never launch a browser.
- `session-capture/src/rungs/browser.mjs:152-163`:

```js
async function withBrowser({ profileDir, headless }, drive) {
  const { chromium } = await import("playwright");   // LAZY: --help must not pay for the bundle
  mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, { headless });
  try { const page = context.pages()[0] ?? (await context.newPage()); return await drive({ page, context }); }
  finally { await context.close(); }
}
```

Verdict: A-01 and A-02 RESOLVED. Lazy-import playwright; create the profile dir on first use; always close in `finally`.

## A-08 — whoami: NOT FOUND (routed to web). Only user ids appear in news fixtures (`CreatedBy`).

## A-09 — Enrollments pagination

- Envelope confirmed from the live fixture `session-capture/tests/fixtures/myenrollments-200.json`: `{"PagingInfo":{"Bookmark":"1498777","HasMoreItems":false},"Items":[…27…]}`. `Bookmark` is a **string**.
- `docs/LADDER-PLAN.md:405-408`: "unfiltered call paginates at 100; current fetcher would silently truncate a >100 filtered set someday" (LATENT BUG). Page size 100 is measured; the continuation query parameter name is NOT recorded (routed to web).
- Per-item shape: `{OrgUnit{Id, Type{Id,Code,Name}, Name, Code, HomeUrl, ImageUrl}, Access{IsActive, StartDate, EndDate, CanAccess, ClasslistRoleName, LISRoles[], LastAccessed}, PinDate}`. All 27 `Type.Id=3`, role `Learner`; **`IsActive` true for all 27 but `CanAccess` true for only 2**; `HomeUrl` null for 25/27. `ImageUrl` is `…/d2l/api/lp/1.9/courses/{ou}/image`.
- 9 Fall-2026 sections are visible only with the `orgUnitTypeId=3` filter dropped (`LADDER-PLAN.md:381`).

## A-10 — `courses/{ou}`: NOT FOUND as a called endpoint (route family exists via `ImageUrl`). Course home is derived as `{base}/d2l/home/{ou}` (`MenuModel.swift:203-206`).

## A-11 / A-12 — Dropbox folders (list shape RESOLVED; single/submissions NOT FOUND)

- Route `GET /d2l/api/le/1.96/{ou}/dropbox/folders/` → **bare array** (`fetch-engine.mjs:297-306`).
- Complete recorded folder (28 keys), `session-capture/tests/fixtures/dropbox-folders-440703.json:2-31`: `Id, CategoryId, Name, CustomInstructions{Text,Html}, Attachments[], TotalFiles, UnreadFiles, FlaggedFiles, TotalUsers, TotalUsersWithSubmissions, TotalUsersWithFeedback, Availability, IsHidden, Assessment{ScoreDenominator,Rubrics[]}, DropboxType, GroupTypeId, DueDate, DisplayInCalendar, NotificationEmail, LinkAttachments[], ActivityId, IsAnonymous, SubmissionType, CompletionType, AllowableFileType, CustomAllowableFileTypes, GradeItemId, AllowOnlyUsersWithSpecialAccess`.
- Measured (`AssignmentPipeline/Tests/Fixtures/README.md:26-54`): `Availability` is **null itself**; `ActivityId` is a **string URI** (`https://ids.brightspace.com/activities/dropbox/…`); the six counters are `-1` for a student; `DueDate`, `GradeItemId`, `GroupTypeId`, `CategoryId` null on real data; instructions live in `CustomInstructions{Text,Html}` (no top-level `Instructions`).
- Trap: `LinkAttachments[].Href` is an instructor-attached external resource, never the assignment page (`dropbox-folders-with-link-attachment.json` exists to forbid deriving a click target from it).

## A-13 — Quizzes (list shape RESOLVED; single NOT FOUND)

- Route `GET /d2l/api/le/1.96/{ou}/quizzes/` → `{"Objects":[…],"Next":null}` (`QuizPipeline/Tests/Fixtures/README.md:27-50`).
- 37 keys measured by name (values captured only for `QuizId, Name, DueDate, IsActive`): `ActivityId, AllowHints, AllowOnlyUsersWithSpecialAccess, AttemptsAllowed, AutoExportToGrades, CalcTypeId, CategoryId, DeductionPercentage, Description, DisablePagerAndAlerts, DisableRightClick, DisplayInCalendar, DueDate, EndDate, Footer, GradeItemId, Header, HideQuestionPoints, Instructions, IsActive, IsAutoSetGraded, IsRetakeIncorrectOnly, IsSingleSession, IsSynchronous, LateSubmissionInfo, Name, NotificationEmail, PagingTypeId, Password, PreventMovingBackwards, QuizId, RestrictIPAddressRange, Shuffle, SortOrder, StartDate, SubmissionGracePeriod, SubmissionTimeLimit`. There is **no `TimeLimit`** field.
- Warning: `brightspace-mcp-server`'s TypeScript types are wrong three times over (`TimeLimit`, 12/37 keys, `Availability`, `ActivityId`). Never inherit third-party D2L types.

## A-14 / A-15 — Gradebook (`grades/` RESOLVED; `myGradeValues` shape and final NOT FOUND)

- Route `GET /d2l/api/le/1.96/{ou}/grades/` → **bare array** of GradeObjects; fields used `Id, Name, GradeObjectTypeId, AssociatedTool{ToolId,ToolItemId}` (`LADDER-PLAN.md:459-467`, `fetch-engine.mjs:346-384`). Student-scored types `{1,2,3,4}` = numeric/passfail/selectbox/text. `ToolId` 19 = quizzes, 6 = dropbox, 390000 = LTI.
- Proven live that a student can call `grades/`; joins: `folder/quiz.GradeItemId == gradeObject.Id` (primary), `AssociatedTool.ToolItemId == folder Id / QuizId` (reverse). **Neither list is a superset** (release-gated quizzes; grade objects that 404).
- `myGradeValues` was probed (`LastModified` mentioned) but no path/shape recorded; `grades/final` zero hits. No gradebook fixture exists (synthesized in tests).

## A-16 — News (RESOLVED)

- Route `GET /d2l/api/le/1.96/{ou}/news/` → **bare array**. Complete 19-key item (`session-capture/tests/fixtures/news-412690.json:50-79`): `PinnedDate, Id, IsHidden, Attachments[{FileId,FileName,Size}], CreatedBy, CreatedDate, LastModifiedBy, LastModifiedDate, Title, Body{Text,Html}, StartDate, EndDate, IsGlobal, IsPublished, ShowOnlyInCourseOfferings, IsAuthorInfoShown, IsPinned, IsStartDateShown, SortOrder`.
- Rules pinned by tests (`fetch-engine.mjs:394-408`): exclude only `IsPublished === false`; date = `StartDate ?? CreatedDate`; sort newest-first yourself; cap (`ANNOUNCEMENT_LIMIT=10`). One course carries **467** announcements. `Body.Text` is server-provided plain text; `Body.Html` carries entities and mailto links.

## A-17 / A-18 / A-19 — Content: NOT FOUND as endpoints. Survey facts (`LADDER-PLAN.md:396-404`): TOC is 1 GET per course; entries carry a server-provided quickLink `Url` (prefer over hand-built templates) and `(ToolId, ToolItemId)`; `ToolId 390000` = LTI (externally hosted, not downloadable); `content/root/` children are stubs; `modules/{id}/structure/` costs 10–20 calls/course.

## A-20 — Discussions: NOT FOUND as endpoints. Survey (`LADDER-PLAN.md:400-401`): call pattern `1+F` GETs (forums, then topics per forum); topics carry first-class `DueDate`, `ScoringType`, `ScoreOutOf`. No posts-level evidence.

## A-21 — Calendar: route probed live (experiment 8) and answers HTTP 200 but is effectively empty on this tenant (3 events / 27 courses / 3 years); every dropbox folder and quiz has `DisplayInCalendar: false`. `bs upcoming` must compute its window from item due dates (`docs/NewVertical-3.md:141-146`). Route string not recorded.

## A-22 — Concurrency

- Actual shape (`fetch-engine.mjs:66-93, 122-160`): courses walked **sequentially**; the four routes per course run in one `Promise.all` → high-water mark **4 in-flight**. One refresh ≈ **55 requests** (`live.test.mjs:41-43`, memoized to avoid being "rude to Brightspace").
- **No 429, rate limit, throttle, or Retry-After anywhere in the repo.** Swift side notes URLSession's default of 6 connections/host (`AssignmentFetcher.swift:27-30`) — the origin of "6", never a measured tenant limit.

## A-24 — JWT lifetime

- `tests/phase2-helpers.mjs:98-105`: "no capture of a successful `POST /d2l/lp/auth/oauth2/token` body was ever recorded"; `expires_in: 3600` is synthesized. Swift tests document 3600 s as "the JWT lifetime" (`PollPolicyTests.swift:15`); production poll = 30 min. No `exp` decoding, no token caching (one mint per run, pinned by `fetch-engine.test.mjs:230-235`).

## A-25 — `GET /d2l/api/versions/` called against the tenant; constants `LP_VERSION="1.62"`, `LE_VERSION="1.96"` (`fetch-engine.mjs:31-33`), stable across captures dated 2026-08-09/10. Response body not checked in.

## A-29 — MFA selector (RESOLVED)

- `browser.mjs:44-52, 173-186`: `#idRichContext_DisplaySign`, plain DOM text (proven by experiment-10 `prove-number.mjs`), polled every 2 s for 5 min; `isVisible()` non-retrying; `.trim()`; empty = scrape failure, not a number. Live E2E twice: "72" at 69 s; "68" at 68 s, login done 16 s after phone tap. Read the number **before** the auth check; announce only on change (Entra re-mints on resend).

## A-30 — Campus selector and login flow (RESOLVED)

- `login-flow.mjs:62-93`: `getByText(/Purdue West Lafayette/i)` only when URL contains `/d2l/login`; KMSI "Yes" only when `#KmsiCheckboxField` or text "Stay signed in?" is visible. Chain: campus selector → `sso.purdue.edu` → `login.microsoftonline.com` → authenticated. Silent rung navigates `${base}/d2l/home`; positive auth = `d2lSessionVal` cookie AND `window.D2L.LP`; email field visible ⇒ fail fast. XSRF via `window.D2L.LP.Web.Authentication.Xsrf.GetXsrfToken()` then `<meta name="d2l-xsrf-token">`, 10×1 s.

## Extra 1 — Deep links (all derived from ids, never read from payloads)

| Target | Template | Verification |
|---|---|---|
| Assignment | `{base}/d2l/lms/dropbox/user/folder_submit_files.d2l?db={folderId}&grpid=0&ou={ou}` | experiment 7 |
| Quiz summary | `{base}/d2l/lms/quizzing/user/quiz_summary.d2l?qi={quizId}&ou={ou}` | live probe |
| Quiz attempts | `{base}/d2l/lms/quizzing/user/quiz_submissions.d2l?qi={quizId}&ou={ou}` | `QuizLink.swift:37-38` |
| Gradebook | `{base}/d2l/lms/grades/my_grades/main.d2l?ou={ou}` | shipped |
| Announcements | `{base}/d2l/lms/news/main.d2l?ou={ou}` | `Announcement.swift:66-74` |
| Course home | `{base}/d2l/home/{ou}` | derived |
| SSO wrapper | `{origin}/d2l/lp/auth/saml/initiate-login?entityId={enc}&target={enc}` | experiment 19; do NOT use after a cookie transplant |
| Mint | `POST {base}/d2l/lp/auth/oauth2/token` body `scope=*:*:*` | production |

## Extra 2 — Death signatures

1. Mint → HTTP **200** + 294-byte HTML stub redirecting to `/d2l/login?sessionExpired=1&target=…` (~15.6 h). The ONLY ladder-climb signal. Verbatim: `session-capture/tests/fixtures/session-expired-stub.html`.
2. Mint → hard **403 Not authenticated** (~28.4 h), and also 403 when `x-csrf-token` is missing even with a live cookie. Always send the header.
3. Bearer API → **401** RFC-7807 `{"type":"http://docs.valence.desire2learn.com/res/apiprop.html#invalid-token","title":"Unauthorized","status":401,"detail":"Couldn't parse token"}` — classified transport, not sessionExpired (`fetch-engine.test.mjs:321-330`).
- Check order: on the mint, marker before status; on enrollments, marker only after the `{Items}` envelope fails to decode (so a 502 page stays transport). 403 on per-course routes = past-term steady state (25/27 courses).

## Extra 3 — credentials.json

`credentials.mjs`: env wins only when BOTH `BS_EMAIL` and `BS_PASSWORD` set; else `<ROOT>/credentials.json`; missing/corrupt = none. Atomic write then explicit `chmod 0600`. Prompt is TTY-only (throws otherwise); close readline before raw-mode password read (live bug 2026-08-24); prompts to stderr; credentials to child via env, never argv.

## Extra 4 — atomic-write.mjs / mfa-file.mjs

Temp file in the same dir, dot-prefixed + PID-suffixed, rename, cleanup on failure, trailing newline. One atomic write = two dir events (first a lie) — re-read and compare. `mfa.json` = `{number, mintedAt}`; cleared before attempt and in `finally`; writes `guarded()` so a side channel never fails the login.

## Extra 5 — Fixtures (bold = faithful live capture)

`session-capture/tests/fixtures/`: **myenrollments-200.json**, **dropbox-folders-440703.json** (3), **dropbox-folders-412690.json** (1), dropbox-folders-empty/malformed/with-due-date, **quizzes-412690.json** (3), **quizzes-440703.json** (1), quizzes-empty/bare-array/malformed/with-due-date, **news-412690.json** (4), **news-440703.json** (12 of 467), news-empty/malformed/with-mixed-dates, **session-expired-stub.html**. Swift: `CoursePipeline/Tests/Fixtures/bogus-bearer-response.txt` (**the 401**), AssignmentPipeline and QuizPipeline fixture READMEs (provenance tables). Error bodies are RFC-7807 `{title,status,detail[,type]}`. No gradebook, whoami, content, discussion, or calendar fixtures exist.

## Extra 6 — Tenant quirks

1. `#idSIButton9` is on every Entra page; require a KMSI marker before clicking.
2. 403 on past-term courses is steady state (two lines per course buried real output → summarize, detail under `--verbose`).
3. `HomeUrl` null in 25/27.
4. Dates arrive both with and without milliseconds; normalize to whole-second `Z`; unreadable → null.
5. Bare arrays (`dropbox`, `grades`, `news`) vs `{Objects,Next}` (`quizzes`).
6. `LinkAttachments[].Href` ≠ assignment.
7. Third-party D2L types are wrong.
8. Mint 403s without `x-csrf-token`; XSRF rotates independently of the cookie.
9. Cold deep links need the SAML wrap; never after a cookie transplant.
10. Profile Entra cookies can expire while everything looks green if the silent rung never runs.
11. (macOS app) `pgrep -f` matched the profile Chromium.
12. `node --test` needs the glob form on Node 26.
13. `open -n` does not inherit env.
14. Future-term sections hidden by the default `orgUnitTypeId=3` filter.

## Item 20 — RepoBar patterns

Poison-pill cache read (`RepoDetailCacheStore.swift:38-61`: decode failure deletes the file, returns nil, never throws; `.atomic` writes; `.iso8601` both directions). Spawning CLIs: redirect to temp files not pipes (64 KB deadlock), SIGTERM then 1 s grace. Anti-pattern: the auth trapdoor that wipes cache on auth failure — `bs auth logout` must be the only thing that deletes credentials.
