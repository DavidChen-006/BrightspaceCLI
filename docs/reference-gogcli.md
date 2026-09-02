# Reference study: `gogcli` — how to build a good CLI for agents

Source: `reference/gogcli` (openclaw/gogcli, Go, MIT). The question it answers:
**"How do I create a good CLI for my agent?"** This note records what the repo
teaches, with file pointers, so the Brightspace CLI can borrow the design
rather than the product.

## 1. The product thesis (docs/why-gog.md, VISION.md)

- **One command surface for humans, scripts, and agents.** There is no separate
  "agent mode"; the same commands, flags, and output serve a person at a
  terminal, a CI script, and a coding agent. Global contracts (output mode,
  exit codes, safety flags) are what make composition safe.
- **Workflows before endpoint spelling.** First-class commands encode the parts
  raw API calls leave to the caller: name resolution, pagination, time parsing,
  content sanitation, dry-run plans, stable output shapes.
- **Stdout is an API.** `--json` / `--plain` keep stdout parseable; human
  guidance, warnings, prompts, and progress go to stderr. Stable exit codes let
  automation branch without matching prose.
- **Auth is a routing problem.** Multiple accounts and clients resolve through
  one command layer (`--account`, aliases, env defaults).
- **Safety is layered.** Dry-run for mutations, confirmation for destructive
  ops, runtime `--readonly` enforced before network dispatch, command
  allow/denylists, untrusted-content markers, MCP writes off by default.
- **The live CLI generates its own contract.** `gog schema --json` is the
  source of truth for docs and generated agent skills, so documentation never
  drifts from the binary that is actually running.

## 2. Repository shape (AGENTS.md, layout)

```
cmd/gog/main.go                entrypoint (tiny)
internal/cmd/*.go              one file per command family (auth_*.go, calendar_*.go …) + *_test.go beside it
internal/outfmt/               output modes: JSON / plain TSV / table, --results-only, --select, untrusted wrapping
internal/errfmt/               error → user-facing message + exit-code classification
internal/ui/                   TTY/color detection (NO_COLOR, --color)
internal/config/               config dir layout, credentials files, aliases (JSON5 config.json)
internal/secrets/              keyring-backed token store with file fallback + timeouts
internal/googleapi/, googleauth/  API client + OAuth flows (the "what", separated from the CLI "how")
internal/app/runtime.go        root runtime: wires flags → context (output mode, safety)
internal/integration/          opt-in live tests behind a build tag + env var
docs/                          spec.md (the contract), automation.md, agent-skills.md, commands/ (generated)
.agents/skills/<service>/SKILL.md   generated per-service agent skills
Makefile                       build / fmt / lint / test / ci / agent-skills
```

Lessons:

- `AGENTS.md` at the root tells an agent how to build, test, and commit. Keep
  it short and operational.
- Every command family is its own file with tests next to it; the CLI is a
  thin layer over an internal API package. Tests use stdlib `testing` +
  `httptest`; live tests are opt-in (`GOG_IT_ACCOUNT` + build tag).
- Secrets never enter the repo; config JSON is written 0600; tokens live in the
  OS keychain with an encrypted-file fallback for headless runs.

## 3. Output contract (docs/automation.md, internal/outfmt)

- Global flags: `--json`, `--plain` (TSV), `--color=auto|always|never`,
  `--no-input`, `--force`, `--readonly`, `--wrap-untrusted`, `--results-only`,
  `--select a.b,c` (dot-path projection; requires `--json`).
- Env defaults: `GOG_JSON=1`, `GOG_PLAIN=1`, `GOG_READONLY=1`, `GOG_ACCOUNT`.
  Explicit flags override env. Contradictory flags (`--json --plain`) fail with
  usage exit code 2 (`outfmt.FromFlags`).
- Output mode travels in `context.Context` (`outfmt.WithMode`,
  `outfmt.IsJSON(ctx)`) so any command can ask "am I in JSON mode?" without
  plumbing a parameter.
- `WriteJSON` applies `--results-only` (unwrap envelope) and `--select`
  (project fields) uniformly; `PrimaryResult(v)` marks a value as already
  primary so unwrapping is skipped.
- `--wrap-untrusted` marks fetched free text as external content for LLM
  consumers while preserving IDs and URLs (`internal/outfmt/untrusted.go`).
- Every service has a `raw` command (`docs/raw-api.md`) that dumps the lossless
  upstream payload: the escape hatch for fields the curated output does not
  model yet.

## 4. Exit codes (docs/automation.md)

| Code | Name | Meaning |
| ---: | --- | --- |
| 0 | ok | Success |
| 1 | error | Generic failure |
| 2 | usage | Bad syntax/flags |
| 3 | empty_results | Query succeeded, nothing found (where applicable) |
| 4 | auth_required | Missing/expired/revoked auth |
| 5 | not_found | Resource missing |
| 6 | permission_denied | Authenticated but forbidden |
| 7 | rate_limited | Quota/rate limit |
| 8 | retryable | Transient network/server |
| 10 | config | Required local config missing |
| 130 | cancelled | Ctrl-C |

The map is published in `schema --json` under `automation.exit_codes`; scripts
branch on the number, never on stderr text. New codes may be added; scripts
keep a generic non-zero fallback.

## 5. Error formatting (internal/errfmt)

`errfmt.Format(err)` walks typed errors (`UserFacingError`, kong parse
errors, `AuthRequiredError`, `CredentialsMissingError`, keyring not-found, API
errors) and turns each into a message that **tells the user the exact next
command to run** (e.g. "No auth for … Run: gog auth add <email>"). Errors are
printed by the CLI itself (`SilenceUsage`), colored on TTY, plain otherwise.

## 6. Auth model (docs/spec.md)

- Non-secret client config on disk (`$CONFIG/gogcli/credentials*.json`, 0600).
- Secrets (refresh tokens) in the OS keyring, keyed `token:<client>:<email>`;
  encrypted-file backend + `GOG_KEYRING_PASSWORD` for headless.
- Keyring operations are bounded by a timeout so a hung Keychain prompt fails
  with guidance instead of hanging.
- `auth add` (browser / manual / remote 2-step flows with PKCE), `auth list
  --check`, `auth doctor --check`, `auth import` for unattended token install,
  `auth tokens list/delete`.
- `--no-input` makes interactive flows fail fast instead of blocking.

## 7. Agent-facing surface (docs/agent-skills.md, .agents/skills/*)

- `gog schema [cmd] --json` emits the full command tree, flags, exit codes,
  output formats, and effective safety state for the running binary.
- Per-service `SKILL.md` files are **generated** from the schema; each has a
  "Safe start" block (check auth, read schema, run a read-only command with
  `--json --wrap-untrusted`), a command table, and the rule "do not guess
  command syntax — run `--help` / `schema`".
- Workflow skills (multi-step tasks) stay hand-written because ordering and
  safety need judgment.
- `gog mcp` exposes a typed, read-only-by-default MCP tool surface; writes
  require `--allow-write`, tool list narrowed with `--allow-tool`.

## 8. Safety layers (docs/automation.md, safety-profiles/)

- `--readonly` rejects mutating HTTP methods before dispatch, independent of
  scopes and command names.
- Allow/deny command lists via flags/env (`GOG_ENABLE_COMMANDS`,
  `GOG_DISABLE_COMMANDS`), plus baked "safety profiles" that remove commands
  from help and schema at build time.
- Mutations offer `--dry-run`; destructive commands confirm unless `--force`.

## 9. Testing and release discipline

- Unit tests beside code; `httptest` servers for API paths; opt-in live suite.
- `make ci` = fmt + lint + test; lefthook pre-commit hooks.
- Conventional Commits; CHANGELOG entries for user-visible changes; goreleaser
  for binaries; `commands.generated.md` and skills regenerated from schema and
  checked in CI (`make agent-skills-check`).

## 10. What the Brightspace CLI should take from this

1. Single surface, no agent mode: `bs <resource> <verb>` for humans and agents.
2. Global `--json` / `--plain`, stdout data only, stderr for everything else.
3. Named exit codes (at minimum: ok, error, usage, empty, auth_required,
   not_found, permission_denied, rate_limited, retryable, config) published via
   `schema --json`.
4. Errors that name the next command to run.
5. `schema --json` as the machine contract, and a generated `SKILL.md` for agents.
6. `raw` escape hatch commands that return the lossless D2L payload.
7. `--no-input` for automation; interactive login fails fast without it.
8. Secrets (cookies/JWT) never in stdout, logs, or the repo; 0600 files; a
   `paths` module as the single place the on-disk layout is decided.
9. `--readonly` enforced at the HTTP layer; `--dry-run` on any future mutation.
10. Tests beside code, hermetic by default, live tests gated by an env var.
