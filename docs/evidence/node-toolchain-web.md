# Evidence: Node/TypeScript toolchain (web research) — 2026-09-02

Produced by a web-research subagent. Versions observed on npm on 2026-09-02:
`commander` 15.0.0 (ESM-only, `engines.node >=22.12.0`), `@biomejs/biome`
2.5.11, `playwright` / `playwright-core` 1.62.1 (`engines.node >=20`),
`typescript` 7.0.2, `tsx` 4.23.13, `env-paths` 4.0.0 (`node >=20`).

## A-01 — Node floor → **22.12**

- Node 20 reached End-of-Life 2026-04-30 (https://github.com/nodejs/Release). 22.x is in maintenance until 2027-04-30; 24.x is Active LTS.
- In v20 docs global `fetch` was still "Stability: 1 - Experimental" (stable in v21.0.0); `node --test <glob>` was added in v21.0.0 (SEMVER-MAJOR). `node:test` stable since v20.0.0; `AbortSignal.timeout` since v17.3.
- commander 15 requires Node ≥ 22.12.0.
- **Decision:** `"engines": {"node": ">=22.12.0"}`; CI matrix 22 + 24. Quote test globs: `node --test "test/**/*.test.js"`.

## A-03 — commander introspection → confirmed

- Public typings (https://github.com/tj/commander.js/blob/master/typings/index.d.ts): `Command.commands`, `Command.options`, `Command.registeredArguments` (since 11.1.0), `name()`, `aliases()`, `description()`, `summary()`, `usage()`, `optsWithGlobals()`; `Option.{flags, description, required, optional, variadic, mandatory, short, long, negate, defaultValue, envVar, hidden, argChoices, attributeName()}`; `Argument.{description, required, variadic, defaultValue, argChoices, name()}`.
- `.env('BS_JSON')` on `Option` (since 8.2.0). `.exitOverride()` + `configureOutput({writeErr, outputError})` route usage errors to stderr; **default usage-error exit code is 1**, so map `CommanderError` codes (`commander.unknownOption`, `commander.missingArgument`, `commander.optionMissingArgument`, `commander.missingMandatoryOptionValue`, `commander.excessArguments`, `commander.unknownCommand`, `commander.invalidArgument`) to exit 2; `commander.helpDisplayed`/`commander.version` → 0. Own usage errors: `program.error(msg, {exitCode: 2})`.
- Do not enable `enablePositionalOptions()` so `bs --json courses list` and `bs courses list --json` both work.

## A-04 — plain tsc build → confirmed

- tsc preserves a leading `#!` (emitter `emitShebangIfNeeded`; TS issue #2749 fixed in 1.6). npm `bin` entries must start with `#!/usr/bin/env node`; npm sets the exec bit (https://docs.npmjs.com/cli/v11/configuring-npm/package-json).
- TypeScript 7.0 (Go-native, stable 2026-07-08) ships `tsc`; pin it, fall back to `typescript@6` if tooling breaks. `tsx` for dev runs (no type check).
- Layout: `"type":"module"`, `"bin":{"bs":"dist/bin/bs.js","brightspace":"dist/bin/bs.js"}`, `"files":["dist","README.md","LICENSE"]`, `module`/`moduleResolution` `NodeNext`, `target` `ES2022`, explicit `.js` extensions in relative imports. No bundler.

## A-05 — Biome → confirmed

- One binary formats + lints TS/JSON via `biome.json` (`npx @biomejs/biome init`); `biome check --write .` locally; `biome ci .` in CI (read-only, non-zero on drift) (https://biomejs.dev/reference/cli/). Pin exactly (`-E`). Ignore `dist` and `reference`.

## A-06 — Playwright → revised

- Docs do not recommend a `postinstall` hook; options are explicit `npx playwright install chromium` or the `@playwright/browser-chromium` package. Cache: `~/Library/Caches/ms-playwright` (macOS), `~/.cache/ms-playwright` (Linux). `install chromium` fetches Chromium + `chromium-headless-shell`; ≈281 MB on disk for Chromium (PRD's 150 MB was low). `PLAYWRIGHT_BROWSERS_PATH` relocates; `=0` makes it hermetic under `node_modules`.
- `browserType.launchPersistentContext(userDataDir, options)` → `BrowserContext`; `userDataDir` "stores browser session data like cookies and local storage" (https://playwright.dev/docs/api/class-browsertype). `channel: 'chrome'` uses installed Google Chrome with no download; `channel: 'chromium'` opts into new headless.
- `playwright-core` is the no-browser flavor; both packages expose a `cli.js` that can run `install`.
- **Decision:** depend on `playwright-core`; no postinstall; `bs auth doctor`/`bs auth login` detect a missing browser and offer `node node_modules/playwright-core/cli.js install chromium` (or set `BS_BROWSER_CHANNEL=chrome`). State the ~300 MB cost.

## A-24 — JWT `exp` without verification

- `Buffer.from(part, 'base64url')` (RFC 4648 §5, tolerates missing padding; Node ≥ 15.7) → `JSON.parse(...).exp` (https://nodejs.org/api/buffer.html). Treat undecodable as expired; consider stale 60 s before `exp`; never print the token.

## A-26 — State directories

- XDG v0.8: `XDG_DATA_HOME` (`~/.local/share`), `XDG_CONFIG_HOME` (`~/.config`), `XDG_STATE_HOME` (`~/.local/state`), `XDG_CACHE_HOME` (`~/.cache`) (https://specifications.freedesktop.org/basedir/latest/). Apple: `~/Library/Application Support/<id>` for app data, `~/Library/Caches/<id>` for regenerable data. Windows: `%LOCALAPPDATA%`.
- `env-paths` 4.0.0 encodes these (`data, config, cache, log, temp`; `envPaths('bs', {suffix: ''})`).
- **Decision:** root (profile + session.json) = `env-paths` `data` dir; `--root`/`BS_ROOT` overrides everything into one directory; dirs 0700, secrets 0600.

## A-28 — Untrusted-content wrapping

- Anthropic guidance: put untrusted content only in tool results, say what it is and where it came from, JSON-encode third-party strings (https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks). OWASP LLM01:2025: "Separate and clearly denote untrusted content". Willison: delimiters are a mitigation, not a defense.
- **Decision:** adopt gogcli's `<<<EXTERNAL_UNTRUSTED_CONTENT id="…">>>` format verbatim with `Source: brightspace`, plus the `externalContent` sentinel; drop the XML variant from the PRD (HTML-bearing bodies can contain tags). Opt-in flag; the generated SKILL.md always passes it.

## npm names

- `brightspace-cli`: free. `bs`: taken as a package (irrelevant). `bs-cli` (2022, browser-sync) declares a `bs` bin — potential global collision. `bsdgames` ships a `bs` binary on Debian/Ubuntu.
- **Decision:** publish as `brightspace-cli`; bins `bs` and `brightspace` (alias) both pointing at `dist/bin/bs.js`.
