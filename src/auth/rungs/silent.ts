/**
 * Rung 1: silent Entra SSO (PRD 7). `kind: 'silent'`: no human, no window, so every data command
 * may climb it and a cron job never pops a browser. The persistent profile holds the Microsoft
 * sign-in (~90 days) and a dead D2L session re-mints itself against it with zero input.
 *
 * A rung never throws (cancellation excepted): a missing `playwright-core` or browser executable
 * becomes a null with a one-line hint, and the ladder carries on to exit 4 `Run: bs auth login`.
 * Ported from Brightspace-Bar `session-capture/src/rungs/silent.mjs`.
 */
import { CancelledError } from '../../core/errors.js';
import { ensureDirs } from '../../core/paths.js';
import type { Rung, RungContext } from '../ladder.js';
import type { Session } from '../session.js';
import { type PlaywrightImporter, trySilentLogin, withBrowser } from './browser.js';

export const HINT_DOCTOR = 'Run: bs auth doctor';

export interface SilentRungDeps {
  /** Test seam; defaults to the real `import('playwright-core')`. */
  importer?: PlaywrightImporter;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

/** A short reason when the failure is "no browser to drive", else null. */
export function browserUnavailableReason(err: unknown): string | null {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return 'playwright-core is not installed';
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist/i.test(message)) {
    return 'no browser executable is installed for playwright-core';
  }
  if (/is not found at|Chromium distribution|Failed to launch/i.test(message)) {
    return `the browser could not be launched (${describe(err)})`;
  }
  return null;
}

/**
 * The silent rung. Tenant knobs (base URL, campus text, browser channel) come from the
 * RungContext at attempt time, so one rung serves every invocation.
 */
export function silentRung(deps: SilentRungDeps = {}): Rung {
  return {
    kind: 'silent',
    async attempt(rc: RungContext): Promise<Session | null> {
      const { paths, config, log, warn } = rc;
      try {
        ensureDirs(paths);
        return await withBrowser(
          {
            profileDir: paths.profileDir,
            headless: true,
            channel: config.browserChannel,
            log,
            importer: deps.importer,
          },
          (page) =>
            trySilentLogin(page, {
              baseUrl: config.baseUrl,
              campusText: config.campusText,
              log,
              now: deps.now,
            }),
        );
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const unavailable = browserUnavailableReason(err);
        if (unavailable !== null) {
          const line = `${unavailable}; the silent login was skipped. ${HINT_DOCTOR}`;
          log(`silent: ${line}`);
          warn?.(line);
          return null;
        }
        log(`silent: failed (${describe(err)})`);
        return null;
      }
    },
  };
}
