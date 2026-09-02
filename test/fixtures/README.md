# Test fixtures

Recorded payloads used by the hermetic suites. Each entry states where the bytes came from
and whether they are a faithful copy of a live capture or a synthetic stand-in.

| File | Provenance | Copied | Fidelity |
| --- | --- | --- | --- |
| `session-expired-stub.html` | `reference/Brightspace-Bar/session-capture/tests/fixtures/session-expired-stub.html` (vendored at a17c41f) | 2026-09-02 | faithful: the 294-byte HTML stub the JWT mint returns with HTTP 200 once the session cookie is ~15.6 h old; the `sessionExpired=1` marker is the only ladder-climb signal (Brightspace-Bar sweep Extra 2) |
| `bogus-bearer-response.txt` | `reference/Brightspace-Bar/BrightspaceBar/Modules/CoursePipeline/Tests/Fixtures/bogus-bearer-response.txt` (vendored at a17c41f) | 2026-09-02 | faithful: first line `STATUS 401`, second line the RFC-7807 `problem+json` body D2L returns for an unparseable bearer token |
| `myenrollments-200.json` | `reference/Brightspace-Bar/session-capture/tests/fixtures/myenrollments-200.json` (vendored at a17c41f) | 2026-09-02 | faithful: the live `GET /d2l/api/lp/1.62/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true` answer, 27 items, `Bookmark` string, `HasMoreItems` false; `HomeUrl` null on 25/27, `CanAccess` true on 2/27 (Brightspace-Bar sweep A-09). The two-page paging case in `test/commands/courses.test.ts` is derived from it at test time (synthetic split) |
| `whoami-doc-shaped.json` | hand-written from the D2L docs block in `docs/evidence/d2l-api-web.md` A-08 (no live capture exists: sweep A-08) | 2026-09-02 | synthetic: `WhoAmIUser` with the documented six fields; `Identifier` a numeric string |
| `course-offering-1498777.json` | hand-written from the D2L docs block in `docs/evidence/d2l-api-web.md` A-10 for org unit 1498777 (a real id from `myenrollments-200.json`) | 2026-09-02 | synthetic: `CourseOffering` with millisecond dates, `Semester`/`Department`/`CourseTemplate` BasicOrgUnit refs and a `Description{Text,Html}` |
