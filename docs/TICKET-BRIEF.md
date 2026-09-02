# Ticket brief for `bs` build subagents

You are a fresh engineer picking up ONE beads ticket for the `bs` Brightspace
CLI. You work inside a treehouse worktree that the orchestrator leased for you;
the path is in your task prompt. Do everything in that worktree; never touch
the main checkout at `/Users/davidchen/Developer/BrightspaceCLI` except to
run `bd`, which auto-redirects there.

## Read first (in this order)

1. `bd show <your-bead-id>` — the ticket: scope, acceptance criteria, evidence pointers.
2. `docs/PRD.md` — the frozen product spec (v1.0). The sections your ticket cites are binding.
3. `docs/evidence/*.md` — recorded evidence (routes, response blocks, quirks). Prefer these over memory or guesses; the D2L docs are quoted in `docs/evidence/d2l-api-web.md`, and real recorded payloads live in `reference/Brightspace-Bar/session-capture/tests/fixtures/`.
4. `docs/reference-gogcli.md` and `docs/reference-brightspace-bar.md` — the design lineage.
5. `AGENTS.md` at the repo root (once it exists) — build/test/commit rules.
6. The existing `src/` and `test/` — reuse the seams that earlier tickets built (paths, config, output, errors, http, session, ladder). Do not re-implement them.

## Rules

- **Scope is the bead.** If you discover necessary work outside it, create a
  bead: `bd create "<title>" -t task -d "<why>" --deps discovered-from:<your-id>`
  and note it in your report. Do not silently expand scope.
- **Red → green.** Write the tests first (`node:test`, hermetic, no network,
  no browser), watch them fail for the right reason, then implement.
- **Hermetic tests only** in `test/**`. Anything needing the tenant goes under
  `test/live/` behind `BS_LIVE=1` (only the live-E2E ticket adds those).
- **Secrets discipline (D7):** never log or print cookies, XSRF tokens, JWTs,
  or passwords; log lengths/labels only. Never commit credentials.
- **Stdout is an API:** data only on stdout (`--json`/`--plain`); all human
  text, progress, prompts, and errors on stderr.
- **Exit codes** come from `src/core/errors.ts` only. Never call
  `process.exit` with a literal outside `src/bin/bs.ts`.
- Keep `--help`, `version`, and `schema` free of side effects: no state
  directories created, no `playwright-core` import.
- Toolchain: Node ≥ 22.12, TypeScript ESM (`NodeNext`, explicit `.js` in
  relative imports), Biome. `npm run build && npm test && npm run lint` must be
  green before you close the ticket.
- Fixtures copied from `reference/Brightspace-Bar` go under `test/fixtures/`
  with a `README.md` line stating provenance (file, date, faithful vs synthetic).
- Do not add dependencies beyond: `commander`, `playwright-core`, `env-paths`,
  `typescript`, `tsx`, `@biomejs/biome`, `@types/node`. Ask (via a note in
  your report) if you believe another is essential.

## Git

- In the worktree: `git switch -c bead/<id>` first (the worktree starts detached at `main`).
- Conventional Commits with the ticket id: `feat(auth): silent rung (bs-30m)`,
  `test(http): retry policy (bs-hop)`, `chore: …`.
- Stage explicit paths; never `git add -A`. Never commit `node_modules`, `dist`, or anything under a `BS_ROOT`.
- End every commit message with:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Do not merge, rebase onto, or push anything. The orchestrator merges.

## Finishing

1. Run `npm run build && npm test && npm run lint` and paste the summary lines in your report.
2. `bd close <your-bead-id> --reason "<one-line summary of what shipped and how it was verified>"`.
3. Your final message: what you built (files), how you verified it (commands + results), any beads you created, anything left open or uncertain. The orchestrator reviews the diff and merges `bead/<id>` into `main`.
