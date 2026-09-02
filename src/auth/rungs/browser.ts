/**
 * The browser seam for the ladder's rungs (PRD 5 browser row, PRD 7 rung 1).
 *
 * `playwright-core` is imported lazily inside `withBrowser`, so `--help`, `version`, `schema`,
 * `auth status` and every data command that never climbs past rung 0 pay nothing for it. The
 * login mechanics are written against `PageLike`/`BrowserContextLike`, the narrow slice of
 * playwright's Page/BrowserContext they need, so tests drive them with a scripted fake; the
 * browser-side JavaScript is a handful of expression strings (`*_JS`) for the same reason.
 *
 * Ported from Brightspace-Bar `session-capture/src/login-flow.mjs` and `rungs/browser.mjs`
 * (evidence: brightspace-bar-sweep A-30, Extra 6 quirk 1). The silent path permits itself two
 * clicks, neither involving a secret: the Brightspace campus selector and Microsoft's "Stay
 * signed in? → Yes". Secrets discipline (PRD 8.2): cookies and the XSRF token leave only through
 * the returned Session; log lines carry counts and lengths.
 */
import { mkdirSync } from 'node:fs';
import { buildSession, type Session, type SessionCookie } from '../session.js';

export interface LocatorLike {
  first(): LocatorLike;
  isVisible(): Promise<boolean>;
  click(): Promise<void>;
  /** Types a value into a field (the full rung's email and password); the value is never logged. */
  fill(value: string): Promise<void>;
  /** The element's text (the full rung's number-match digits); null when absent. */
  textContent(): Promise<string | null>;
}

/** What playwright's `BrowserContext.cookies()` yields, minus `sameSite`. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Seconds since the epoch; -1 for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface BrowserContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  cookies(urls?: string): Promise<BrowserCookie[]>;
  close(): Promise<void>;
}

export interface PageLike {
  url(): string;
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      timeout?: number;
    },
  ): Promise<unknown>;
  /** Evaluates a JavaScript expression (one of the `*_JS` constants) in the page. */
  evaluate(expression: string): Promise<unknown>;
  locator(selector: string): LocatorLike;
  getByText(text: string, options?: { exact?: boolean }): LocatorLike;
  waitForTimeout(ms: number): Promise<void>;
  context(): BrowserContextLike;
}

export interface LaunchOptions {
  headless: boolean;
  /** `chromium` (default, new headless) or `chrome` for an installed Google Chrome. */
  channel?: string;
}

/** The slice of `playwright-core` the rungs use; the real module satisfies it structurally. */
export interface PlaywrightModule {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options: LaunchOptions,
    ): Promise<BrowserContextLike>;
  };
}

export type PlaywrightImporter = () => Promise<PlaywrightModule>;

/** The one place `playwright-core` is named; called only from inside `withBrowser`. */
export const importPlaywright: PlaywrightImporter = () => import('playwright-core');

// Browser-side expressions. Strings rather than functions so a fake page can match them.
export const D2L_LP_JS = "typeof window.D2L !== 'undefined' && !!window.D2L.LP";
export const XSRF_JS =
  "(() => { try { const t = window.D2L?.LP?.Web?.Authentication?.Xsrf?.GetXsrfToken?.(); return typeof t === 'string' && t !== '' ? t : null; } catch { return null; } })()";
export const XSRF_META_JS =
  "document.querySelector('meta[name=\"d2l-xsrf-token\"]')?.getAttribute('content') ?? null";

export const SESSION_COOKIE = 'd2lSessionVal';
/** Entra's email prompt, in the variants seen across tenants: silent SSO can never pass it. */
export const EMAIL_FIELD_SELECTOR = 'input[type=email], input[name=loginfmt], #i0116';
export const KMSI_CHECKBOX_SELECTOR = '#KmsiCheckboxField';
export const KMSI_TEXT = 'Stay signed in?';
/** Microsoft's primary button on EVERY sign-in page ("Next", "Sign in", "Yes"): never click it unproven. */
export const ENTRA_PRIMARY_BUTTON = '#idSIButton9';

export const XSRF_TRIES = 10;
export const XSRF_WAIT_MS = 1_000;
export const SILENT_TIMEOUT_MS = 30_000;
export const SILENT_POLL_MS = 1_000;
export const GOTO_TIMEOUT_MS = 60_000;

const PROFILE_DIR_MODE = 0o700;

type Log = (line: string) => void;

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

async function isVisible(locator: LocatorLike): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
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

async function evaluateString(page: PageLike, expression: string): Promise<string | null> {
  try {
    const value = await page.evaluate(expression);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

export interface WithBrowserOptions {
  profileDir: string;
  headless: boolean;
  channel?: string;
  log: Log;
  /** Test seam; defaults to the real `import('playwright-core')`. */
  importer?: PlaywrightImporter;
}

/**
 * One persistent-profile browser, always closed. The profile directory IS the credential store
 * (the ~90-day Entra sign-in lives in it), so it is created on first use, mode 0700.
 */
export async function withBrowser<T>(
  options: WithBrowserOptions,
  fn: (page: PageLike, context: BrowserContextLike) => Promise<T>,
): Promise<T> {
  const { chromium } = await (options.importer ?? importPlaywright)();
  mkdirSync(options.profileDir, { recursive: true, mode: PROFILE_DIR_MODE });
  const launch: LaunchOptions = { headless: options.headless };
  if (options.channel !== undefined && options.channel !== '') launch.channel = options.channel;
  options.log(
    `browser: launching ${launch.channel ?? 'chromium'} ${options.headless ? 'headless' : 'headed'} on ${options.profileDir}`,
  );
  const context = await chromium.launchPersistentContext(options.profileDir, launch);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return await fn(page, context);
  } finally {
    try {
      await context.close();
    } catch (err) {
      options.log(`browser: close failed (${describe(err)})`);
    }
  }
}

function tenantHost(baseUrl: string): string {
  return new URL(baseUrl).hostname.toLowerCase();
}

/** The cookies that belong to the tenant host (host-only or a parent domain), as session cookies. */
export function cookiesForHost(
  cookies: readonly BrowserCookie[],
  baseUrl: string,
): SessionCookie[] {
  const host = tenantHost(baseUrl);
  const kept: SessionCookie[] = [];
  for (const c of cookies) {
    const domain = (c.domain ?? '').replace(/^\./, '').toLowerCase();
    if (domain === '' || (domain !== host && !host.endsWith(`.${domain}`))) continue;
    const cookie: SessionCookie = { name: c.name, value: c.value, domain };
    if (c.path !== undefined) cookie.path = c.path;
    if (c.expires !== undefined) cookie.expires = c.expires;
    if (c.httpOnly !== undefined) cookie.httpOnly = c.httpOnly;
    if (c.secure !== undefined) cookie.secure = c.secure;
    kept.push(cookie);
  }
  return kept;
}

/**
 * POSITIVE auth check, never "the URL does not look like a login page": the tenant's
 * `d2lSessionVal` cookie AND a reachable D2L JS context, because the login stub sets cookies too.
 */
export async function isAuthenticated(page: PageLike, baseUrl: string): Promise<boolean> {
  try {
    const cookies = cookiesForHost(await page.context().cookies(baseUrl), baseUrl);
    if (!cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '')) return false;
    return Boolean(await page.evaluate(D2L_LP_JS));
  } catch {
    return false;
  }
}

/** XSRF via D2L's own JS, then the meta tag, up to 10 tries a second apart. Null when absent. */
export async function extractXsrf(
  page: PageLike,
  options: { tries?: number } = {},
): Promise<string | null> {
  const tries = options.tries ?? XSRF_TRIES;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const token =
      (await evaluateString(page, XSRF_JS)) ?? (await evaluateString(page, XSRF_META_JS));
    if (token !== null) return token;
    if (attempt < tries - 1) await page.waitForTimeout(XSRF_WAIT_MS);
  }
  return null;
}

export interface SilentSurfaceOptions {
  /** The campus selector's text on `/d2l/login` (PRD 8.3 `campusText`); matched case-insensitively. */
  campusText: string;
  log?: Log;
}

/**
 * Click through the no-secret surfaces between a live Entra cookie and an authenticated page.
 * Returns true when something was clicked (re-poll rather than conclude).
 */
export async function clickThroughSilentSurfaces(
  page: PageLike,
  options: SilentSurfaceOptions,
): Promise<boolean> {
  const log = options.log ?? (() => {});
  const campusText = options.campusText.trim();
  // Brightspace's campus selector precedes the Microsoft redirect.
  if (campusText !== '' && page.url().includes('/d2l/login')) {
    const campus = page.getByText(campusText, { exact: false }).first();
    if (await isVisible(campus)) {
      await click(campus);
      log('silent: clicked the campus selector');
      return true;
    }
  }
  // "Stay signed in? → Yes" keeps the profile's sign-in persistent. The page must PROVE it is the
  // KMSI page first: #idSIButton9 is "Next" on the email page and "Sign in" on the password page,
  // and clicking it there submits an empty form once a second for the whole budget (Extra 6, 1).
  // Two markers because tenant policy can hide the checkbox: the checkbox, else the title.
  const onKmsiPage =
    (await isVisible(page.locator(KMSI_CHECKBOX_SELECTOR).first())) ||
    (await isVisible(page.getByText(KMSI_TEXT, { exact: false }).first()));
  if (onKmsiPage) {
    const yes = page.locator(ENTRA_PRIMARY_BUTTON).first();
    if (await isVisible(yes)) {
      await click(yes);
      log('silent: clicked Yes on "Stay signed in?"');
      return true;
    }
  }
  return false;
}

export interface HarvestOptions {
  baseUrl: string;
  log?: Log;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
}

/** What an authenticated page is worth: the tenant cookies, the XSRF token, where it landed. */
export async function harvestSession(
  page: PageLike,
  options: HarvestOptions,
): Promise<Session | null> {
  const log = options.log ?? (() => {});
  const cookies = cookiesForHost(await page.context().cookies(options.baseUrl), options.baseUrl);
  const csrfToken = await extractXsrf(page);
  if (csrfToken === null) {
    log('silent: authenticated, but no XSRF token was found on the page');
    return null;
  }
  log(
    `silent: harvested ${cookies.length} cookies for ${tenantHost(options.baseUrl)} and an XSRF token (${csrfToken.length} chars)`,
  );
  return buildSession({
    baseUrl: options.baseUrl,
    cookies,
    csrfToken,
    landedUrl: page.url(),
    capturedAt: (options.now ?? Date.now)(),
  });
}

export interface SilentLoginOptions extends HarvestOptions {
  campusText: string;
  /** Total budget for the SSO chain; default 30 s. */
  timeoutMs?: number;
}

/**
 * The silent path: navigate to `/d2l/home` and give the SSO chain a bounded window to complete
 * with no human. A visible email field is Microsoft asking WHO you are, a page no amount of
 * waiting gets past: fail at once so the caller can move on. Returns the harvested Session or null.
 */
export async function trySilentLogin(
  page: PageLike,
  options: SilentLoginOptions,
): Promise<Session | null> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SILENT_TIMEOUT_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  try {
    await page.goto(`${baseUrl}/d2l/home`, {
      waitUntil: 'domcontentloaded',
      timeout: GOTO_TIMEOUT_MS,
    });
  } catch (err) {
    log(`silent: initial navigation failed (${describe(err)}); continuing`);
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await isAuthenticated(page, baseUrl)) {
      log('silent: authenticated');
      return harvestSession(page, { baseUrl, log, now });
    }
    if (await isVisible(page.locator(EMAIL_FIELD_SELECTOR).first())) {
      log(
        'silent: an email prompt is on screen; silent SSO cannot pass it, a credential login is needed',
      );
      return null;
    }
    if (now() >= deadline) {
      log(`silent: not authenticated after ${timeoutMs} ms`);
      return null;
    }
    await clickThroughSilentSurfaces(page, { campusText: options.campusText, log });
    await page.waitForTimeout(SILENT_POLL_MS);
  }
}
