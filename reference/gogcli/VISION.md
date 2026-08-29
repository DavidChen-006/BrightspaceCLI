# Vision

`gog` is a pragmatic Google Workspace CLI for humans and agents.

The project should expose commonly useful Google Workspace operations with
stable, scriptable output, predictable safety controls, and commands that are
easy to compose in automation. It does not need to cover every Google API or
every advanced product feature.

## What Fits

- Bug fixes, especially for commands that already exist.
- Small, useful primitives in areas `gog` already supports.
- Agent-friendly workflows: explicit accounts, JSON output, dry-runs where
  useful, clear errors, no hidden prompts in automation.
- Human-friendly command surfaces that remain simple enough to remember.
- Incremental Google Workspace capabilities that make common work easier for
  Docs, Sheets, Drive, Gmail, Calendar, Slides, Forms, Admin, and other already
  supported areas.
- Security and reliability improvements for auth, keyring, credentials,
  retries, output hygiene, and live-provider behavior.

## Discuss First

- New product areas or new API surfaces.
- Large PRs, broad refactors, or changes that reshape command structure.
- Features that are unusual, niche, mostly speculative, or hard to validate.
- Behavior changes that could break existing scripts.
- New dependencies or new long-running/background machinery.
- Anything that cannot be live-tested against Google APIs when live behavior is
  the point of the change.

## Merge Bar

Small fixes and useful primitives in supported areas should usually merge after
review, tests, docs/changelog updates when user-visible, and live Google proof
where the behavior depends on Google Workspace APIs.

If a change needs discussion, keep the PR open until the product direction is
clear. If live testing is blocked, state the exact missing account, API access,
or credential needed.
