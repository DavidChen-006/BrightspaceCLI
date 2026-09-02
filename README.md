# bs — Brightspace CLI

`bs` is a read-only command-line interface to Brightspace (D2L) built for AI agents, scripts
and humans: `--json` on stdout, everything else on stderr, named exit codes, and a
machine-readable contract from `bs schema --json`. After one `bs auth login` it reads your
courses, assignments, quizzes, grades, announcements, content, discussions and calendar
unattended.

**Work in progress.** Only the scaffold (`bs version`, `bs schema`) exists so far; see
`docs/PRD.md` for the full command surface and `AGENTS.md` for how to build and test.

```sh
npm install
npm run build
node dist/bin/bs.js --help
node dist/bin/bs.js schema --json
```
