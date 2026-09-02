# Evidence sweep: gogcli (local reference) — 2026-09-02

Produced by an Explore subagent over `reference/gogcli`. Paths are relative to
that directory. HTML entities in the original report were unescaped.

## 1. `schema --json` generated from the live command tree

**Location:** `internal/cmd/schema.go` 19–51 (doc types), 97–139 (Run), 141–190 (automation block), 253–299 (recursive node walk), 317–343 (flags).

```go
type schemaDoc struct {
	SchemaVersion int              `json:"schema_version"`
	Build         string           `json:"build"`
	Automation    schemaAutomation `json:"automation"`
	Command       *schemaNode      `json:"command"`
}
type schemaAutomation struct {
	OutputFormats []string          `json:"output_formats"`
	ExitCodes     map[string]int    `json:"exit_codes"`
	Safety        schemaSafetyState `json:"safety"`
}
type schemaSafetyState struct {
	DryRun bool; NoInput bool; WrapUntrusted bool; GmailNoSend bool; ReadOnly bool
	BakedProfile schemaBakedProfile; CommandRules schemaCommandRules
}
```

Node/flag shapes (53–95): `schemaNode{type, name, aliases, help, detail, path, usage, hidden, passthrough, default_cmd, flags, positionals, subcommands, requirements}`; `schemaFlag{name, aliases, short, help, type, required, default, has_default, enum, placeholder, envs, hidden, negated}`; `schemaArg{name, help, type, required, default, has_default, enum, cumulative}`.

**Mechanism:** `SchemaCmd.Run` walks the live parsed command tree (`kctx.Model.Node`), optionally narrowed by a positional command path (`gog schema drive ls`); children sorted by name for determinism; hidden nodes skipped unless `--include-hidden`. `buildSchemaAutomation` emits `output_formats: ["json","plain"]`, the exit-code map, and the *effective* safety state of this invocation.

**Gotchas:** `schema` rejects `--plain` (JSON-only). It clears `--results-only`/`--select` and `--wrap-untrusted` before writing (schema is trusted local metadata). `build` is `VersionString()`.

## 2. Agent `SKILL.md` generation

**Location:** `scripts/gen-agent-skills.mjs` 45–61 (schema load), 63–104 (template), 115–126 (render), 135–153 (`--check`). Example output `.agents/skills/gog-calendar/SKILL.md`.

Template (81–103): front-matter `name`/`description`; "Generated … do not edit" comment; `## Safe start` fenced block (`auth list --check --json --no-input`, `schema <service> --json`, one read-only example); five safety bullets (explicit account, `--json --wrap-untrusted`, `--readonly`, `--no-input` + `--dry-run`, confirm before writes); `## Commands` table `| Command | Purpose |` from each child's `name` + `help`; footer: "Run `gog <service> <command> --help` … Do not guess command syntax."

**Mechanism:** Runs the built binary's `schema --json` in a scrubbed environment (fresh `XDG_CONFIG_HOME`, all `GOG_*` env deleted) so the emitted safety state is the default. `cleanText` escapes `|` and flattens newlines so help text cannot break the table. `--check` re-renders into a tmpdir and diffs; CI gates it (`make agent-skills-check`). A hand-authored root skill `.agents/skills/gog/SKILL.md` holds shared rules; generated skills link to it — a two-tier structure.

## 3. Exit code definitions and classification

**Location:** `internal/cmd/exit_codes.go` 16–49 (constants), 53–120 (`stableExitCode`), 137–157 (HTTP mapping); `internal/cmd/exit.go` 5–36; `internal/cmd/paging.go:8`.

```go
func httpStatusExitCode(code int, reason string) int {
	switch code {
	case 401: return exitCodeAuthRequired
	case 403:
		if isQuotaOrRateLimitReason(reason) { return exitCodeRateLimited }
		return exitCodePermissionDenied
	case 404: return exitCodeNotFound
	case 429: return exitCodeRateLimited
	default: if code >= 500 { return exitCodeRetryable }
	}
	return 1
}
```

**Mechanism:** Classification happens once after the command returns (`root.go:346`): existing `*ExitError` wins; `context.Canceled`→130; `ErrReadOnly`→**2 (usage)**; auth/scope/keyring-missing→4; credentials-missing→10; HTTP status; circuit breaker / `net.Error.Timeout()` / `DeadlineExceeded`→8; else 1.

**Gotchas:** 403 disambiguated by Google's reason string for quota → 7. For `bs`, D2L's 403-on-mint is the session-expired climb signal and must be handled before this mapper.

## 4. `--results-only` and `--select`

**Location:** `internal/outfmt/outfmt.go` 64–99, 101–138 (`WriteJSON`), 166–257 (`unwrapPrimary`), 259–322 (`selectFields`/`getAtPath`); validation `internal/cmd/root.go:396–414`.

**Mechanism:** One `JSONTransform{ResultsOnly, Select}` in context. `WriteJSON` marshals to generic `any` with `UseNumber()` (large IDs stay exact), unwraps, projects, wraps untrusted, encodes with `SetEscapeHTML(false)` + 2-space indent. `unwrapPrimary`: explicit `results` key wins; else drop meta keys (`nextPageToken, next_cursor, has_more, count, query, dry_run, op, action, note, notes`), take the sole remaining key, else a known result-array name, else any array. `PrimaryResult(v)` suppresses unwrapping. `selectFields` maps over a list; `getAtPath` walks dot segments incl. numeric indexes.

**Gotchas:** dot paths do not broadcast through nested arrays; output keys are the full dot path; unmatched fields silently omitted; both flags require `--json` (exit 2 otherwise).

## 5. `--wrap-untrusted` marker format

**Location:** `internal/outfmt/untrusted.go` 14–19, 52–55, 91–110, 112–132, 170–217, 219–253, 262–346.

Rendered form:

```
<<<EXTERNAL_UNTRUSTED_CONTENT id="a1b2c3d4e5f60718">>>
Source: google_api
---
…content…
<<<END_EXTERNAL_UNTRUSTED_CONTENT id="a1b2c3d4e5f60718">>>
```

**Mechanism:** Per-string wrapping while walking the JSON tree. Wrap if key ∈ allow-list (body, comment, content, description, displayName, formattedValue, message, name, note, question, snippet, subject, summary, text, title, value, raw, renderedText, …) or any ancestor ∈ {cells,row,rows,values}; never wrap metadata keys (id, url, mimeType, etag, *Time, *Link, threadId, pageToken, …) — deny wins. Keys normalized (strip `_`/`-`, lowercase). Adds top-level `externalContent: {untrusted:true, source, wrapped:true}`. Random 8-byte hex id on both markers prevents forged closers; embedded markers rewritten to `[[MARKER_SANITIZED]]`; ~20 LLM special tokens replaced with `[REMOVED_SPECIAL_TOKEN]`.

**Gotchas:** The `SECURITY NOTICE` preamble is opt-in and not emitted by default. Also applies to raw output. Bare top-level strings always wrapped.

## 6. `--plain` TSV rules

**Location:** `internal/outfmt/table.go` 14–68; `table_test.go` 23–54 (`"ID\tNAME\n1\tone\n22\ttwo\n"`).

**Mechanism:** `WriteTable[T](ctx, w, rows, columns)`; columns are an ordered slice `{Header, Value func(T) string}` so order is by construction. Header row always emitted. Human mode uses `text/tabwriter`; `--plain` writes raw `\t`-joined lines.

**Gotchas:** No escaping of tabs/newlines in cells (an improvement point for `bs`: escape `\t`→`\\t`, `\n`→`\\n`). `--plain` forces color off.

## 7. `--readonly` at the HTTP layer

**Location:** `internal/googleapi/read_only.go` 11–31, 33–70 (transport), 72–90 (method check), 92–119 (POST allowlist); wiring `root.go:234`.

```go
func ReadOnlyRequestAllowed(request *http.Request) bool {
	if request.Header.Get("X-HTTP-Method-Override") != "" { return false }
	switch request.Method {
	case GET, HEAD, OPTIONS: return true
	case POST: return readOnlyPOSTRequest(request) // https + host + path-suffix allowlist
	default: return false
	}
}
```

**Mechanism:** A RoundTripper decorator installed only when the context carries readonly; rejects before any network I/O with `ErrReadOnly` (exit 2). Allowlist of query-POSTs (Calendar freeBusy, Sheets getByDataFilter, Analytics runReport, …).

**Gotchas:** `X-HTTP-Method-Override` rejected outright. Propagates into MCP child argv. For `bs`, the JWT mint POST must be exempted like these query-POSTs.

## 8. `--no-input`

**Location:** `root.go` 235–237; `internal/cmd/confirm.go` 21–44; `googleapi/auth_dependencies.go:227–236`.

**Mechanism:** Flag read directly by commands → `usage` errors (exit 2) with an alternative ("run `gog auth import`"); a context marker set when the flag is present **or stdin is not a TTY** suppresses browser re-auth deep in the auth layer → exit 4. Prompts go to stderr.

**Gotchas:** refused prompt = 2; suppressed re-auth = 4; EOF during prompt = 1.

## 9. Retry / backoff

**Location:** `internal/googleapi/retry_constants.go` 5–14; `transport.go` 45–72, 75–219, 222–280, 298–323.

```go
MaxRateLimitRetries = 3; RateLimitBaseDelay = 1s   // 429
Max5xxRetries = 1; ServerErrorRetryDelay = 1s       // 5xx
// backoff = base << attempt, + crypto-random jitter in [0, base/2)
```

**Mechanism:** 429 → up to 3 retries honoring `Retry-After` (seconds or HTTP-date); 5xx → 1 retry after 1s, feeding a circuit breaker; sleeps cancellable via ctx. Bodies buffered up to 16 MiB for replay. On exhaustion the 429/5xx *response* is returned so normal classification yields 7/8.

**Correction to PRD A-27:** 3× applies to 429 only; 5xx gets 1 retry.

## 10. Default timeouts

**Location:** `internal/googleapi/client.go` 20–30, 251–256, 292–318.

**Mechanism:** `http.Client.Timeout` deliberately unset; `ResponseHeaderTimeout = 30s` on the transport; TLS ≥1.2; token exchange bounded at 30s. No global `--timeout` flag exists in gogcli.

**Correction to PRD A-07:** apply the 30s to response headers (or per-request with a streaming exception for downloads), not to the whole body.

## 11. Config/state directories and modes

**Location:** `internal/config/layout.go` 32–64, 245–286, 330–360, 432–439; modes in `config.go:64,103`, `client_credentials_store.go:29,53`, `layout_paths.go:43`; prose `docs/paths.md`.

**Mechanism:** Four kinds (config, data, state, cache). Precedence: `GOG_<KIND>_DIR` → `--home` → `GOG_HOME` → `XDG_*_HOME` → platform default. macOS/Windows: all collapse into `os.UserConfigDir()` (`~/Library/Application Support` on darwin). Linux/BSD: config `~/.config`, data `~/.local/share`, state `~/.local/state`, cache `~/.cache`. Overrides must be absolute. Dirs 0700, secret files 0600 via atomic write. Resolver injectable for tests.

**Correction to PRD A-26:** on Linux use `XDG_STATE_HOME`/`~/.local/state` (state) or `XDG_DATA_HOME` (data) — not one env for everything; on macOS `~/Library/Application Support/<app>` is correct.

## 12. `empty_results` (3)

**Location:** `internal/cmd/paging.go` 8–15; `--fail-empty` (aliases `--non-empty`, `--require-results`) on ~42 list commands; default use in `docs_at_anchor.go:70–83`.

**Mechanism:** Opt-in for lists: the empty output is still written, then a messageless `ExitError{Code:3}` is returned (silent for humans, branchable for scripts). Confirms A-23.

## 13. Error message style

**Location:** `internal/errfmt/errfmt.go` 33–63; `errfmt/googleapi.go` 44–61; `googleapi/transport.go` 119–130.

Examples: "No auth for <service> <email>.\n\nOAuth (browser flow):\n  gog auth add <email> --services <svc>"; "OAuth client credentials missing … Then run: gog auth credentials <credentials.json> (expected at <path>)"; "Secret not found in keyring … Run: gog auth add <email>"; "refresh token expired or revoked: …; run 'gog auth add' to re-authorize".

**Mechanism:** One ordered `errors.As` ladder; shape = diagnosis line → blank → indented copy-pasteable command with the user's real values. Parse errors get "Run with --help …" appended. All to stderr, red on TTY.

## 14. `raw` commands

**Location:** `internal/cmd/calendar_raw.go` 7–53; `internal/outfmt/raw.go` 10–45.

**Mechanism:** Same positional selectors as the curated sibling + one flag `--pretty`; reuses resolution helpers; `requireRawResponse(v, "event not found")`; compact single-line JSON by default, HTML escaping off, trailing newline; skips `--results-only`/`--select` but still honors `--wrap-untrusted`. Doc comment links the REST reference.

## 15. Testing pattern

**Location:** `internal/cmd/execute_calendar_paging_test.go` 15–69; `cmd_testutil_test.go` 196–227; `google_service_testutil_test.go` 71–96; `api_test.go` 49–64.

**Mechanism:** `httptest.NewServer` whose handler asserts on the request and returns fixtures → real SDK client pointed at it → `executeWithTestRuntime(args, runtime)` runs the real argv path with stdout/stderr buffers → `json.Unmarshal(stdout)` into a typed struct; `ExitCode(err)` asserted. `unexpectedGoogleTestService` fails if any network factory is called. Stdin is a non-TTY reader, so the no-input path is exercised by default.

## 16. Root runtime wiring

**Location:** `internal/cmd/root.go` 33–57, 223–237, 306–336; `internal/app/runtime.go` 40–44, 147–178.

**Mechanism:** Context carries behavior (output mode, JSON transform, untrusted wrapper, readonly, no-input, UI, runtime); the framework binds `*RootFlags` for values. Order: parse → baked profile → locked flags → output precedence → command guards → logging → validate → context → run → classify → print. Env defaults (`GOG_JSON`) are template defaults silently overridden by explicit flags; `--json --plain` = usage error; `GOG_AUTO_JSON` flips to JSON when stdout is not a TTY.

## 17. `AGENTS.md` and Makefile

**Location:** `AGENTS.md` (49 lines); `Makefile` 13–16, 38–40, 81–85, 150–152, 163.

`ci: pnpm-gate docker-version-check fmt-check lint deadcode test docs-check agent-skills-check`. Generation checks (docs, skills) run against the actual built binary. AGENTS.md sections: structure, build/test commands, style ("keep stdout parseable; hints to stderr"), testing, commit/PR protocol, security.

## 18. Color

**Location:** `internal/ui/ui.go` 30–69, 83; `root.go:320–323`; `docs/spec.md:64–88`.

**Mechanism:** stdout and stderr get independent profiles; `never`→ASCII, `always`→TrueColor (overrides `NO_COLOR`, tested), `auto`→terminal detection (honors `NO_COLOR`, non-TTY). Forced off under `--json`/`--plain`. Only success/error lines are colored.

## 19. MCP design (for a future `bs mcp`)

**Location:** `internal/cmd/mcp.go` 20–26, 36–52, 53–106, 142, 202–249, 251–290, 292–305; `docs/mcp.md` 1–70.

Narrow typed tools, each with a fixed input schema and a `BuildArgs` that constructs argv (no model-supplied argv). Executes the CLI's own binary as a subprocess with a hardcoded safe prefix `--json --wrap-untrusted --no-input --color=never` and a safety suffix appended last. Tools carry `Risk` read/write; write hidden unless `--allow-write` and matching `--allow-tool`. Structured result `{tool, service, risk, exit_code, stdout, stderr}`; `--timeout-seconds` 60, `--max-output-bytes` 102400; `--list-tools` for auditing.

## 20. Version

**Location:** `internal/cmd/version.go` 13–70; `Makefile` 13–16, 38–40.

Three-tier: ldflags (`git describe --tags --always --dirty`) → build info → embedded `VERSION` file. `version --json` emits `{version, commit, date}` separately; the same string feeds `schema.build`. Node equivalent: `package.json` version + a generated build-info module.
