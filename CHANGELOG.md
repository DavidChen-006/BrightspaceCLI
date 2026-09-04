# Changelog

All notable changes to `bs` (brightspace-cli) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

### Changed
- Unauthenticated data commands exit 4 immediately when no browser profile exists instead of
  launching Chromium first.
- `courses get` reports `partial` and `failures` in JSON when the course-offering route is denied.
- The 403 hint is neutral and, where the enrollment is known, says whether the course has ended.
- `upcoming` names the denied course(s) in its one-line 403 summary.

## [0.1.0] - 2026-09-02

### Added
- Read-only D2L commands: `whoami`, `courses`, `assignments`, `quizzes`, `grades`,
  `announcements`, `content`, `discussions`, `calendar`, `upcoming`, and raw `api`.
- Auth ladder: cookie JWT mint, silent Playwright Chromium rung, full Entra login with the
  Authenticator number-match relay; `auth status|refresh|login|logout|doctor`.
- Agent contract: `--json`/`--plain` stdout API, named exit codes, `schema --json`,
  generated `skills/bs/SKILL.md`, `--wrap-untrusted` markers.
- Hermetic test suite, live `BS_LIVE=1` tiers, and `scripts/e2e.sh`.
