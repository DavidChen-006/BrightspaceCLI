/**
 * Rung 2: the full login (PRD 7 rung 2). `kind: 'full'`: it types a password and needs a human
 * on the other end of a number-match prompt, so `climb()` only runs it under `allowFull` and
 * `bs auth login` is the only command that constructs it.
 *
 * Silent first (`trySilentLogin`; credentials are never touched when the profile still carries
 * the Entra sign-in). Then the Entra choreography: email field → Next → password field → Sign
 * in, each field polled every 250 ms for up to 30 s (a slow redirect is not a failure; a field
 * that is never coming must not cost the human the whole MFA wait). Then the number-match loop:
 * every 2 s for up to 5 min, FIRST read `#idRichContext_DisplaySign` (plain DOM text: evidence
 * A-29), announce on change (Entra re-mints on resend) and write `cache/mfa.json`
 * `{number, mintedAt}` so a side channel can show it, THEN click through KMSI and check auth.
 * `cache/mfa.json` is cleared before the attempt and in `finally`; its writes are guarded so a
 * side channel can never fail the login (evidence Extra 4).
 *
 * Ported from Brightspace-Bar `session-capture/src/rungs/browser.mjs` (`fullLoginCapture`).
 * Secrets discipline (PRD 8.2): the password goes into the page and nowhere else; log lines
 * carry labels only.
 */
import { rmSync } from 'node:fs';
import { readJsonFile, SECRET_FILE_MODE, writeJsonAtomic } from '../../core/atomic.js';
import { isoAtMs } from '../../core/dates.js';
import { CancelledError } from '../../core/errors.js';
import { type BsPaths, ensureDirs } from '../../core/paths.js';
import type { Credentials } from '../credentials.js';
import type { Rung, RungContext } from '../ladder.js';
import type { Session } from '../session.js';
import {
  clickThroughSilentSurfaces,
  EMAIL_FIELD_SELECTOR,
  harvestSession,
  isAuthenticated,
  type LocatorLike,
  type PageLike,
  type PlaywrightImporter,
  trySilentLogin,
  withBrowser,
} from './browser.js';
import { browserUnavailableReason, HINT_DOCTOR } from './silent.js';

/** Entra's password prompt, in the variants seen across tenants. */
export const PASSWORD_FIELD_SELECTOR = 'input[type=password], input[name=passwd], #i0118';
/** The primary button: "Next" on the email page, "Sign in" on the password page. */
export const SUBMIT_SELECTOR = '#idSIButton9, input[type=submit], button[type=submit]';
/** The number-match digits: plain DOM text (evidence A-29, experiment-10 prove-number). */
export const DISPLAY_SIGN_SELECTOR = '#idRichContext_DisplaySign';
/** "Your account or password is incorrect." under the password field. */
export const PASSWORD_ERROR_SELECTOR = '#passwordError';
/** "We couldn't find an account with that username." under the email field. */
export const USERNAME_ERROR_SELECTOR = '#usernameError';
/** "Request denied" / "We didn't hear from you" on the number-match page. */
export const MFA_ERROR_SELECTOR = '#idDiv_SAOTCAS_ErrorText, #idDiv_SAOTCAS_Error';

export const FIELD_TIMEOUT_MS = 30_000;
export const FIELD_POLL_MS = 250;
export const MFA_TIMEOUT_MS = 5 * 60_000;
export const MFA_POLL_MS = 2_000;

/** The one line a human needs, exactly as `bs auth login` prints it on stderr. */
export function mfaPrompt(number: string): string {
  return `Type ${number} into Authenticator on your phone`;
}

export const MFA_WAITING_LINE =
  'Waiting for the Microsoft Authenticator number-match prompt (up to 5 min)';

/** `cache/mfa.json`: the number currently on screen and when it appeared. Secret-free. */
export interface MfaRelay {
  number: string;
  mintedAt: string;
}

export type FullFailureKind =
  | 'bad-password'
  | 'unknown-account'
  | 'mfa-timeout'
  | 'mfa-denied'
  | 'no-field'
  | 'no-xsrf'
  | 'browser'
  | 'error';

export interface FullFailure {
  kind: FullFailureKind;
  /** One line, never a secret. */
  reason: string;
}

export interface FullRungInput {
  credentials: Credentials;
  /** A visible window (`bs auth login --headed`); headless by default. */
  headed?: boolean | undefined;
  /** The MFA relay to the human (stderr in `bs auth login`); defaults to `RungContext.warn`. */
  announce?: ((line: string) => void) | undefined;
}

export interface FullRungDeps {
  /** Test seam; defaults to the real `import('playwright-core')`. */
  importer?: PlaywrightImporter;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
}

/** A full rung also remembers WHY its last attempt failed, so `bs auth login` can hint. */
export interface FullRung extends Rung {
  kind: 'full';
  readonly failure: FullFailure | null;
}

export type FullRungFactory = (input: FullRungInput) => FullRung;

type Log = (line: string) => void;

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

/** Guarded: a side channel never fails the login. */
export function writeMfaFile(paths: BsPaths, relay: MfaRelay, log: Log = () => {}): void {
  try {
    ensureDirs(paths);
    writeJsonAtomic(paths.mfaFile, relay, { mode: SECRET_FILE_MODE });
  } catch (err) {
    log(`full: could not write ${paths.mfaFile} (${describe(err)})`);
  }
}

/** Guarded, idempotent. */
export function clearMfaFile(paths: BsPaths, log: Log = () => {}): void {
  try {
    rmSync(paths.mfaFile, { force: true });
  } catch (err) {
    log(`full: could not remove ${paths.mfaFile} (${describe(err)})`);
  }
}

/** The relay on disk, or null when missing, corrupt or not the contract. */
export function readMfaFile(paths: BsPaths): MfaRelay | null {
  const raw = readJsonFile(paths.mfaFile);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { number, mintedAt } = raw as Record<string, unknown>;
  if (typeof number !== 'string' || number === '' || typeof mintedAt !== 'string') return null;
  return { number, mintedAt };
}

async function isVisible(locator: LocatorLike): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

/** The trimmed text of a visible element, or null: hidden, absent, empty, or detached. */
async function visibleText(page: PageLike, selector: string): Promise<string | null> {
  const locator = page.locator(selector).first();
  if (!(await isVisible(locator))) return null;
  try {
    const text = (await locator.textContent())?.trim() ?? '';
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

interface FieldBudget {
  now: () => number;
  log: Log;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Polls `selector` on the field cadence and acts on it the moment it is visible. Between polls,
 * `bail` gets a chance to end the wait early (an error surface that means the field is never
 * coming). Returns 'done', 'timeout', or whatever `bail` returned.
 */
async function whenVisible<B extends string>(
  page: PageLike,
  selector: string,
  label: string,
  budget: FieldBudget,
  act: (locator: LocatorLike) => Promise<void>,
  bail: () => Promise<B | null> = async () => null,
): Promise<'done' | 'timeout' | B> {
  const timeoutMs = budget.timeoutMs ?? FIELD_TIMEOUT_MS;
  const pollMs = budget.pollMs ?? FIELD_POLL_MS;
  const deadline = budget.now() + timeoutMs;
  for (;;) {
    const target = page.locator(selector).first();
    if (await isVisible(target)) {
      await act(target);
      budget.log(`full: ${label}`);
      return 'done';
    }
    const bailed = await bail();
    if (bailed !== null) return bailed;
    if (budget.now() >= deadline) {
      budget.log(`full: no visible element for ${label} after ${timeoutMs} ms`);
      return 'timeout';
    }
    await page.waitForTimeout(pollMs);
  }
}

/** A click that navigates can detach its element after the press landed; that is not news. */
async function click(locator: LocatorLike): Promise<void> {
  try {
    await locator.click();
  } catch {
    /* the press happened */
  }
}

interface DriveOptions {
  baseUrl: string;
  campusText: string;
  credentials: Credentials;
  paths: BsPaths;
  now: () => number;
  log: Log;
  announce: Log;
}

type DriveResult = { session: Session } | { failure: FullFailure };

function failure(kind: FullFailureKind, reason: string): DriveResult {
  return { failure: { kind, reason } };
}

/**
 * The four-step choreography: each step happens because the previous one did and because its
 * field reported itself there, so a page that went somewhere unexpected ends with a failure
 * instead of a password typed into whatever was on screen.
 */
async function autofill(page: PageLike, o: DriveOptions): Promise<DriveResult | null> {
  const budget = { now: o.now, log: o.log };
  const { email, password } = o.credentials;
  const emailStep = await whenVisible(page, EMAIL_FIELD_SELECTOR, 'typed the email', budget, (f) =>
    f.fill(email),
  );
  if (emailStep !== 'done') {
    return failure('no-field', 'the Microsoft email field never appeared (30 s)');
  }
  await whenVisible(page, SUBMIT_SELECTOR, 'clicked Next', budget, click);
  const passwordStep = await whenVisible(
    page,
    PASSWORD_FIELD_SELECTOR,
    'typed the password (value not logged)',
    budget,
    (f) => f.fill(password),
    async () => ((await visibleText(page, USERNAME_ERROR_SELECTOR)) === null ? null : 'unknown'),
  );
  if (passwordStep === 'unknown') {
    return failure('unknown-account', `Microsoft does not know the account ${email}`);
  }
  if (passwordStep !== 'done') {
    return failure('no-field', 'the Microsoft password field never appeared (30 s)');
  }
  await whenVisible(page, SUBMIT_SELECTOR, 'clicked Sign in', budget, click);
  return null;
}

/** The number on screen, or null when Entra is not showing one (empty text is a scrape failure). */
async function readDisplaySign(page: PageLike): Promise<string | null> {
  return visibleText(page, DISPLAY_SIGN_SELECTOR);
}

/** An Entra error surface that means no approval is coming, as a failure; else null. */
async function errorSurface(page: PageLike): Promise<DriveResult | null> {
  const wrongPassword = await visibleText(page, PASSWORD_ERROR_SELECTOR);
  if (wrongPassword !== null) return failure('bad-password', 'Microsoft rejected the password');
  const denied = await visibleText(page, MFA_ERROR_SELECTOR);
  if (denied !== null) {
    return failure('mfa-denied', `the number-match request was denied or expired (${denied})`);
  }
  return null;
}

async function waitForApproval(page: PageLike, o: DriveOptions): Promise<DriveResult> {
  o.announce(MFA_WAITING_LINE);
  const deadline = o.now() + MFA_TIMEOUT_MS;
  let announced: string | null = null;
  for (;;) {
    // The digits BEFORE the auth check: they are on screen while the page is still
    // unauthenticated, and the check costs a round trip the human should not wait behind.
    const number = await readDisplaySign(page);
    if (number !== null && number !== announced) {
      announced = number;
      writeMfaFile(o.paths, { number, mintedAt: isoAtMs(o.now()) }, o.log);
      o.announce(mfaPrompt(number));
    }
    if (await isAuthenticated(page, o.baseUrl)) {
      o.log('full: authenticated');
      const session = await harvestSession(page, { baseUrl: o.baseUrl, log: o.log, now: o.now });
      return session === null
        ? failure('no-xsrf', 'authenticated, but no XSRF token was found on the page')
        : { session };
    }
    const problem = await errorSurface(page);
    if (problem !== null) return problem;
    if (o.now() >= deadline) {
      return failure('mfa-timeout', 'no approval arrived within 5 min (300 s)');
    }
    // "Stay signed in? → Yes" is what keeps future runs silent.
    await clickThroughSilentSurfaces(page, { campusText: o.campusText, log: o.log });
    await page.waitForTimeout(MFA_POLL_MS);
  }
}

async function drive(page: PageLike, o: DriveOptions): Promise<DriveResult> {
  const silent = await trySilentLogin(page, {
    baseUrl: o.baseUrl,
    campusText: o.campusText,
    log: o.log,
    now: o.now,
  });
  if (silent !== null) {
    o.log('full: the silent path covered it; credentials never touched');
    return { session: silent };
  }
  const notSubmitted = await autofill(page, o);
  if (notSubmitted !== null) return notSubmitted;
  return waitForApproval(page, o);
}

/**
 * The full rung. Tenant knobs come from the RungContext at attempt time; the credentials and
 * the window choice come from `bs auth login`. Never throws (cancellation excepted): every
 * failure is a null, one `warn` line and a recorded `failure`.
 */
export function fullRung(input: FullRungInput, deps: FullRungDeps = {}): FullRung {
  let last: FullFailure | null = null;
  const now = deps.now ?? Date.now;
  return {
    kind: 'full',
    get failure() {
      return last;
    },
    async attempt(rc: RungContext): Promise<Session | null> {
      const { paths, config, log } = rc;
      const warn = rc.warn ?? (() => {});
      const announce = input.announce ?? warn;
      last = null;
      clearMfaFile(paths, log);
      try {
        ensureDirs(paths);
        const result = await withBrowser(
          {
            profileDir: paths.profileDir,
            headless: !input.headed,
            channel: config.browserChannel,
            log,
            importer: deps.importer,
          },
          (page) =>
            drive(page, {
              baseUrl: config.baseUrl,
              campusText: config.campusText,
              credentials: input.credentials,
              paths,
              now,
              log,
              announce,
            }),
        );
        if ('session' in result) return result.session;
        last = result.failure;
        log(`full: ${result.failure.reason}`);
        warn(result.failure.reason);
        return null;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const unavailable = browserUnavailableReason(err);
        if (unavailable !== null) {
          last = { kind: 'browser', reason: `${unavailable}. ${HINT_DOCTOR}` };
        } else {
          last = { kind: 'error', reason: `the full login failed (${describe(err)})` };
        }
        log(`full: ${last.reason}`);
        warn(last.reason);
        return null;
      } finally {
        clearMfaFile(paths, log);
      }
    },
  };
}
