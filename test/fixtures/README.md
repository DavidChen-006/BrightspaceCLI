# Test fixtures

Recorded payloads used by the hermetic suites. Each entry states where the bytes came from
and whether they are a faithful copy of a live capture or a synthetic stand-in.

| File | Provenance | Copied | Fidelity |
| --- | --- | --- | --- |
| `session-expired-stub.html` | `reference/Brightspace-Bar/session-capture/tests/fixtures/session-expired-stub.html` (vendored at a17c41f) | 2026-09-02 | faithful: the 294-byte HTML stub the JWT mint returns with HTTP 200 once the session cookie is ~15.6 h old; the `sessionExpired=1` marker is the only ladder-climb signal (Brightspace-Bar sweep Extra 2) |
| `bogus-bearer-response.txt` | `reference/Brightspace-Bar/BrightspaceBar/Modules/CoursePipeline/Tests/Fixtures/bogus-bearer-response.txt` (vendored at a17c41f) | 2026-09-02 | faithful: first line `STATUS 401`, second line the RFC-7807 `problem+json` body D2L returns for an unparseable bearer token |
