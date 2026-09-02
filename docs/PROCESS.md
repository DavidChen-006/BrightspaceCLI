# Build process: beads tickets × treehouse worktrees × fresh subagents

This is how the `bs` CLI is built, ticket by ticket. It was decided after
probing the tools (`bd` 1.0.3, `treehouse` 2.3.0) on 2026-09-02.

## Tracker: beads (`bd`)

- Initialized with `bd init --prefix bs --non-interactive --skip-hooks --skip-agents`.
  Issues are `bs-<hash>`. Data lives in `.beads/` (Dolt, embedded); the
  JSONL export in `.beads/` is what git tracks.
- The PRD milestones become one **epic** each (`bd create -t epic`), with
  child **task** beads (`--parent`). Ordering is expressed with blocking
  dependencies: `bd dep add <blocked> <blocker>`.
- `bd ready --json` lists the claimable work (open, unblocked). The orchestrator
  takes the highest-priority ready bead.
- Inside a treehouse worktree `bd` auto-redirects to the main checkout's
  `.beads/` (`bd context` shows `worktree: yes`), so a subagent can run
  `bd close <id> --reason "…"` from its worktree and the orchestrator sees it
  with `bd show <id> --json`.

## Worktrees: treehouse

- Pool config: `treehouse.toml` (root defaults to `~/.treehouse/<repo>-<hash>/`).
- Claim without a subshell: `treehouse get --lease --json --lease-holder <bead-id>`
  → `{path, lease_id, …}`. The worktree starts as a detached HEAD at `main`.
- The subagent creates a branch `bead/<id>` inside the worktree and commits
  there.
- Release after merge: `treehouse return --force <path>`.

## Per-ticket loop (orchestrator)

1. `bd ready --json` → pick bead → `bd update <id> --claim`.
2. `treehouse get --lease --json --lease-holder <id>` → worktree path.
3. Spawn a **fresh** subagent (general-purpose) with: the repo goal, the
   worktree path, the bead id + `bd show <id>` text, pointers to
   `docs/PRD.md`, `docs/reference-*.md`, `AGENTS.md`, and the agile rules
   below. The Agent tool notifies the orchestrator on completion; no polling
   timer is needed (a 20-minute fallback `ScheduleWakeup` may be used if a run
   goes silent).
4. Subagent works red→green (tests first), commits on `bead/<id>`, runs
   `npm test`, then `bd close <id> --reason "<summary>"`.
5. Orchestrator verifies personally: `bd show <id> --json` is closed; run
   `npm run build && npm test && npm run lint` on the branch; review the
   diff. Failing review → reopen the bead with notes (`bd reopen`, `bd note`)
   and re-dispatch to a new subagent in the same worktree.
6. In the main checkout: `git merge --no-ff bead/<id> -m "merge: <id> <title>"`
   so every ticket lands as one merge commit, then **`git push origin main`
   immediately** — the pushed history is the progress record (user
   requirement, 2026-09-02).
7. `treehouse return --force <path>`; delete the merged branch.
7. Repeat until `bd ready` is empty and `bd list --status open` is empty.

## Agile rules for a ticket subagent

- Scope is the bead. Discovered work → `bd create … --deps discovered-from:<id>`,
  not a scope expansion.
- Tests beside code, hermetic by default (`node:test`); live tests only behind
  `BS_LIVE=1`.
- Conventional Commits: `feat(scope): …`, `test(scope): …`, `chore: …`.
- Never commit secrets, never log cookies/tokens/passwords (D7).
- Stage explicit paths; never `git add -A`.
- Report: what was built, how it was verified, anything left open.
