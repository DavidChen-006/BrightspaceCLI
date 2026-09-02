#!/usr/bin/env bash
#
# e2e.sh — the end-to-end verification run for `bs` (PRD 12 "Definition of done", bead bs-bo2).
#
# It runs the PRD 12 command list, in order, against the REAL tenant and prints one pass/fail
# table at the end. Every check records its exit code and a one-line summary of what came back;
# the full stdout/stderr of each run is kept in a log directory (scrubbed of credentials before
# anything is displayed) so a red row can be explained without a rerun.
#
#   Usage: scripts/e2e.sh [--tier 1] [--keep] [--ou <id>] [--help]
#
#     --tier 1   also run tier 1: copy BS_ROOT aside, delete the copy's session.json, and prove
#                `bs auth refresh` re-mints from the surviving profile/ (headless Chromium).
#                The real BS_ROOT is never mutated.
#     --keep     keep the logs under $BS_ROOT/cache/e2e/<timestamp>/ instead of a temp directory.
#     --ou <id>  use this course instead of the first active+accessible enrollment.
#
#   Required environment:
#     BS_LIVE=1  the guard. Without it this script refuses (exit 2) and does nothing.
#     BS_ROOT    the state directory to run against; it must already hold a session.json.
#
#   Optional: BS_BASE_URL (default https://purdue.brightspace.com), BS_LP_VERSION (default 1.62).
#
#   Exit codes: 0 every required check passed · 1 a required check failed · 2 usage/refused.
#
# TIER 2 IS MANUAL AND STAYS MANUAL. From a clean root, `bs auth login` relays one Authenticator
# number that a human types on their phone; nothing here automates that. Run it by hand once:
#
#     export BS_ROOT="$(mktemp -d)/bs"
#     node dist/bin/bs.js auth login --json     # type the relayed number into Authenticator
#     BS_LIVE=1 scripts/e2e.sh                  # then this script against that root
#
# Credentials never appear in this repo and never appear in this script's output: every captured
# stderr goes through scripts/lib/redact.mjs (unit-tested in test/live-harness/redact.test.ts)
# before it is written to a log or echoed to the terminal.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Argv and the two refusals — checked before anything is built, spawned or created
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
REDACT="$SCRIPT_DIR/lib/redact.mjs"
BS_JS="$REPO_DIR/dist/bin/bs.js"

usage() {
  sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'
}

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '         %s\n' "$line" >&2; done
  exit 2
}

TIER=0
KEEP=0
OU_OVERRIDE="${BS_LIVE_OU:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tier)
      [ "$#" -ge 2 ] || refuse "--tier needs a value (only --tier 1 exists)"
      [ "$2" = "1" ] || refuse "unknown tier: $2" "only --tier 1 exists; tier 2 is manual"
      TIER=1
      shift 2
      ;;
    --tier=1) TIER=1; shift ;;
    --keep) KEEP=1; shift ;;
    --ou)
      [ "$#" -ge 2 ] || refuse "--ou needs a course org unit id"
      OU_OVERRIDE="$2"
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) refuse "unknown argument: $1" "run scripts/e2e.sh --help" ;;
  esac
done

if [ "${BS_LIVE:-}" != "1" ]; then
  refuse "BS_LIVE=1 is required — this script talks to the real tenant." \
    "Nothing was run, built or created." \
    "Re-run as: BS_LIVE=1 BS_ROOT=<state dir> scripts/e2e.sh"
fi

if [ -z "${BS_ROOT:-}" ]; then
  refuse "BS_ROOT is required — this script needs a state directory that holds a session." \
    "Re-run as: BS_LIVE=1 BS_ROOT=\"\$HOME/Library/Application Support/bs\" scripts/e2e.sh"
fi

case "$BS_ROOT" in
  /*) ROOT="$BS_ROOT" ;;
  *) ROOT="$PWD/$BS_ROOT" ;;
esac
export BS_ROOT="$ROOT"
export BS_NO_INPUT=1

[ -f "$ROOT/session.json" ] || refuse "BS_ROOT has no session.json: $ROOT/session.json" \
  "There is nothing to run tier 0 against." \
  "Fix (tier 2, one MFA tap): node dist/bin/bs.js auth login --json"

command -v node >/dev/null 2>&1 || refuse "node is not on PATH"

BASE_URL="${BS_BASE_URL:-https://purdue.brightspace.com}"
LP_VERSION="${BS_LP_VERSION:-1.62}"

# ─────────────────────────────────────────────────────────────────────────────
# Saying things, and never saying a credential
# ─────────────────────────────────────────────────────────────────────────────

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# Scrubs a captured stderr file in place. Fail-closed: if the filter cannot run, the file is
# emptied rather than left as an unscrubbed copy of a session.
redact_file() {
  local file
  file="$1"
  [ -f "$file" ] || return 0
  if node "$REDACT" <"$file" >"$file.redacted" 2>/dev/null; then
    mv "$file.redacted" "$file"
  else
    rm -f "$file.redacted"
    : >"$file"
    printf '(redaction filter failed; this log was emptied rather than risk a leak)\n' >"$file"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Where the logs go
# ─────────────────────────────────────────────────────────────────────────────

STAMP="$(date +%Y%m%dT%H%M%S)"
if [ "$KEEP" -eq 1 ]; then
  LOG_DIR="$ROOT/cache/e2e/$STAMP"
  mkdir -p "$LOG_DIR"
  chmod 700 "$ROOT/cache/e2e" 2>/dev/null || true
  chmod 700 "$LOG_DIR" 2>/dev/null || true
else
  LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bs-e2e-XXXXXX")"
fi
TIER1_COPY=""

cleanup() {
  if [ -n "$TIER1_COPY" ] && [ -d "$TIER1_COPY" ]; then rm -rf "$TIER1_COPY"; fi
  if [ "$KEEP" -ne 1 ] && [ -d "$LOG_DIR" ]; then rm -rf "$LOG_DIR"; fi
  return 0
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# The result table
# ─────────────────────────────────────────────────────────────────────────────

R_NAMES=()
R_STATUS=()
R_EXIT=()
R_SUMMARY=()
FAILED=0

record() { # name status exit summary
  R_NAMES+=("$1")
  R_STATUS+=("$2")
  R_EXIT+=("$3")
  R_SUMMARY+=("$4")
  if [ "$2" = "FAIL" ]; then FAILED=$((FAILED + 1)); fi
  printf '    [%s] %s (exit %s) %s\n' "$2" "$1" "$3" "$4"
  return 0
}

slug_of() { printf '%s' "$1" | tr -cs 'A-Za-z0-9' '-' | tr '[:upper:]' '[:lower:]'; }

# One line describing what a run produced, read from its stdout.
summarize() {
  E2E_FILE="$1" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    let text = "";
    try { text = readFileSync(process.env.E2E_FILE, "utf8"); } catch {}
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let out = (lines.at(-1) ?? "").slice(0, 70);
    try {
      const value = JSON.parse(text);
      if (value && Array.isArray(value.items)) {
        const failures = Array.isArray(value.failures) ? `, ${value.failures.length} failures` : "";
        out = `${value.count} items${failures}`;
      } else if (value && typeof value === "object") {
        out = Object.keys(value).slice(0, 5).join(",");
      }
    } catch {}
    process.stdout.write(out === "" ? "(no output)" : out);
  ' 2>/dev/null || printf '(unreadable)'
}

# run_check <name> <expected exit> -- <argv...>
# Sets LAST_OUT (the captured stdout file) and LAST_RC (the child's exit code) for the caller.
LAST_OUT=""
LAST_RC=0
run_check() {
  local name expected slug out err rc summary
  name="$1"; expected="$2"; shift 2
  if [ "${1:-}" = "--" ]; then shift; fi
  slug="$(slug_of "$name")"
  out="$LOG_DIR/$slug.out"
  err="$LOG_DIR/$slug.err"
  LAST_OUT="$out"
  set +e
  "$@" >"$out" 2>"$err"
  rc=$?
  set -e
  LAST_RC="$rc"
  redact_file "$err"
  summary="$(summarize "$out")"
  if [ "$rc" -eq "$expected" ]; then
    record "$name" PASS "$rc" "$summary"
  else
    record "$name" FAIL "$rc" "expected exit $expected; $summary"
    say "      --- last stderr lines (scrubbed) ---"
    tail -n 5 "$err" 2>/dev/null | sed 's/^/      /' || true
  fi
  return 0
}

bs_run() { node "$BS_JS" "$@"; }

# ─────────────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────────────

say "bs end-to-end verification (PRD 12)"
say "  repo:      $REPO_DIR"
say "  root:      $ROOT"
say "  tenant:    $BASE_URL (lp $LP_VERSION)"
say "  tiers:     0$([ "$TIER" -eq 1 ] && echo " + 1" || echo "") (tier 2 is manual — see --help)"
say "  logs:      $LOG_DIR$([ "$KEEP" -eq 1 ] && echo "" || echo " (temporary; pass --keep to keep them)")"

step "build — npm run build"
if (cd "$REPO_DIR" && npm run build >"$LOG_DIR/build.out" 2>"$LOG_DIR/build.err"); then
  record "npm run build" PASS 0 "dist/bin/bs.js"
else
  redact_file "$LOG_DIR/build.err"
  record "npm run build" FAIL 1 "see $LOG_DIR/build.err"
  say "the build failed; nothing else can run."
  exit 1
fi
[ -f "$BS_JS" ] || refuse "the build produced no $BS_JS"

step "preflight — the anonymous tenant probe (no session involved)"
set +e
VERSIONS_STATUS="$(E2E_URL="$BASE_URL/d2l/api/versions/" node --input-type=module -e '
  const res = await fetch(process.env.E2E_URL, { redirect: "follow" });
  const body = await res.text();
  process.stdout.write(String(res.status));
  process.exit(res.ok && body.includes("ProductCode") ? 0 : 1);
' 2>"$LOG_DIR/versions.err")"
VERSIONS_RC=$?
set -e
redact_file "$LOG_DIR/versions.err"
if [ "$VERSIONS_RC" -eq 0 ]; then
  record "GET /d2l/api/versions/ (anonymous)" PASS 0 "HTTP ${VERSIONS_STATUS:-?}"
else
  record "GET /d2l/api/versions/ (anonymous)" FAIL "$VERSIONS_RC" "HTTP ${VERSIONS_STATUS:-unreachable}"
fi

step "preflight — bs auth doctor --json (the browser row may warn)"
set +e
bs_run auth doctor --json >"$LOG_DIR/doctor.out" 2>"$LOG_DIR/doctor.err"
DOCTOR_RC=$?
set -e
redact_file "$LOG_DIR/doctor.err"
# doctor exits 10 when any check failed. A missing browser only matters to tier 1/2, so a failed
# `browser` or `playwright` row is a warning here; anything else is a real preflight failure.
set +e
DOCTOR_VERDICT="$(E2E_FILE="$LOG_DIR/doctor.out" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  let report;
  try { report = JSON.parse(readFileSync(process.env.E2E_FILE, "utf8")); }
  catch { process.stdout.write("unreadable doctor report"); process.exit(1); }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const soft = new Set(["browser", "playwright"]);
  const bad = checks.filter((c) => c.status === "fail" && !soft.has(c.name));
  const warn = checks.filter((c) => c.status !== "ok").map((c) => `${c.name}:${c.status}`);
  process.stdout.write(warn.length ? warn.join(" ") : "all checks ok");
  process.exit(bad.length ? 1 : 0);
' 2>/dev/null)"
DOCTOR_VERDICT_RC=$?
set -e
if [ "$DOCTOR_VERDICT_RC" -eq 0 ]; then
  record "bs auth doctor --json" PASS "$DOCTOR_RC" "$DOCTOR_VERDICT"
else
  record "bs auth doctor --json" FAIL "$DOCTOR_RC" "$DOCTOR_VERDICT"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Tier 0 — the PRD 12 Definition-of-done list, in order
# ─────────────────────────────────────────────────────────────────────────────

step "tier 0 — the Definition-of-done commands"
note "bs auth login is NOT run: it is tier 2 and needs a human (see --help)."

run_check "bs whoami --json" 0 -- bs_run whoami --json
run_check "bs courses list --json" 0 -- bs_run courses list --json
COURSES_OUT="$LAST_OUT"
COURSES_RC="$LAST_RC"

if [ "$COURSES_RC" -ne 0 ] && [ -z "$OU_OVERRIDE" ]; then
  OU=""
  record "pick a current-term course" SKIP "$COURSES_RC" "courses list did not answer"
elif [ -n "$OU_OVERRIDE" ]; then
  OU="$OU_OVERRIDE"
  note "course: $OU (from --ou / BS_LIVE_OU)"
else
  set +e
  OU="$(E2E_FILE="$COURSES_OUT" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const { items = [] } = JSON.parse(readFileSync(process.env.E2E_FILE, "utf8"));
    const picked = items.find((c) => c.isActive === true && c.canAccess === true);
    if (!picked) process.exit(1);
    process.stdout.write(String(picked.id));
  ' 2>/dev/null)"
  OU_RC=$?
  set -e
  if [ "$OU_RC" -ne 0 ] || [ -z "$OU" ]; then
    record "pick a current-term course" FAIL 1 "no enrollment is both isActive and canAccess"
    OU=""
  else
    record "pick a current-term course" PASS 0 "ou=$OU"
  fi
fi

if [ -n "$OU" ]; then
  run_check "bs upcoming --json" 0 -- bs_run upcoming --json
  run_check "bs assignments list $OU --json" 0 -- bs_run assignments list "$OU" --json
  run_check "bs quizzes list $OU --json" 0 -- bs_run quizzes list "$OU" --json
  run_check "bs grades list $OU --json" 0 -- bs_run grades list "$OU" --json
  run_check "bs announcements list $OU --json" 0 -- bs_run announcements list "$OU" --json
  run_check "bs content toc $OU --json" 0 -- bs_run content toc "$OU" --json
  run_check "bs discussions topics $OU --json" 0 -- bs_run discussions topics "$OU" --json
  run_check "bs calendar events $OU --json" 0 -- bs_run calendar events "$OU" --json
elif [ "$COURSES_RC" -ne 0 ]; then
  record "per-course commands" SKIP "$COURSES_RC" "no course to run them against"
else
  record "per-course commands" FAIL 1 "no course to run them against"
fi

run_check "bs api GET /d2l/api/lp/$LP_VERSION/users/whoami --json" 0 \
  -- bs_run api GET "/d2l/api/lp/$LP_VERSION/users/whoami" --json

# ─────────────────────────────────────────────────────────────────────────────
# Tier 1 — the silent re-mint, on a COPY of the root
# ─────────────────────────────────────────────────────────────────────────────

if [ "$TIER" -eq 1 ]; then
  step "tier 1 — session.json deleted, profile/ kept: bs auth refresh must re-mint silently"
  TIER1_COPY="$(mktemp -d "${TMPDIR:-/tmp}/bs-e2e-tier1-XXXXXX")"
  note "copying $ROOT -> $TIER1_COPY (the real root is never touched)"
  cp -R "$ROOT/." "$TIER1_COPY/"
  rm -f "$TIER1_COPY/session.json"
  if [ -d "$TIER1_COPY/profile" ]; then
    note "session.json deleted from the copy; profile/ intact"
    run_check "bs auth refresh --json (tier 1)" 0 \
      -- env BS_ROOT="$TIER1_COPY" node "$BS_JS" auth refresh --json
    run_check "bs auth status --json after refresh (tier 1)" 0 \
      -- env BS_ROOT="$TIER1_COPY" node "$BS_JS" auth status --json
  else
    record "bs auth refresh --json (tier 1)" FAIL 1 \
      "the copy has no profile/ — tier 1 without the Entra profile IS tier 2"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# The agent contract and the hermetic suites
# ─────────────────────────────────────────────────────────────────────────────

step "agent contract"
run_check "bs schema --json" 0 -- bs_run schema --json

set +e
bs_run skill >"$LOG_DIR/skill-probe.out" 2>"$LOG_DIR/skill-probe.err"
SKILL_RC=$?
set -e
redact_file "$LOG_DIR/skill-probe.err"
if [ "$SKILL_RC" -eq 0 ]; then
  record "bs skill" PASS 0 "$(summarize "$LOG_DIR/skill-probe.out")"
elif grep -qi "unknown command" "$LOG_DIR/skill-probe.err" 2>/dev/null; then
  record "bs skill" SKIP "$SKILL_RC" "not built yet (bead bs-u1f)"
else
  record "bs skill" FAIL "$SKILL_RC" "$(summarize "$LOG_DIR/skill-probe.out")"
fi

step "hermetic suites — npm test, npm run lint"
run_check "npm test" 0 -- env -u BS_LIVE sh -c "cd \"$REPO_DIR\" && npm test"
run_check "npm run lint" 0 -- sh -c "cd \"$REPO_DIR\" && npm run lint"

# ─────────────────────────────────────────────────────────────────────────────
# The table
# ─────────────────────────────────────────────────────────────────────────────

printf '\n'
printf '%-6s %-52s %5s  %s\n' STATUS CHECK EXIT SUMMARY
printf '%-6s %-52s %5s  %s\n' '------' \
  '----------------------------------------------------' '-----' '-------'
i=0
while [ "$i" -lt "${#R_NAMES[@]}" ]; do
  printf '%-6s %-52s %5s  %s\n' "${R_STATUS[$i]}" "${R_NAMES[$i]}" "${R_EXIT[$i]}" "${R_SUMMARY[$i]}"
  i=$((i + 1))
done
printf '\n'

if [ "$KEEP" -eq 1 ]; then
  say "logs kept: $LOG_DIR"
fi

say "next: the assertion-level live suite (deep links, --select/--plain/--fail-empty, tier 1)"
say "  BS_LIVE=1 BS_ROOT=\"$ROOT\" npm run test:live"
say "  BS_LIVE=1 BS_LIVE_TIER=1 BS_ROOT=\"$ROOT\" npm run test:live   # adds tier 1"
say ""
say "tier 2 (manual, one MFA tap, never automated):"
say "  export BS_ROOT=\"\$(mktemp -d)/bs\" && node dist/bin/bs.js auth login --json"

if [ "$FAILED" -gt 0 ]; then
  say ""
  say "E2E: FAILED — $FAILED required check(s) did not pass."
  exit 1
fi

say ""
say "E2E: GREEN — ${#R_NAMES[@]} checks, 0 failures."
exit 0
