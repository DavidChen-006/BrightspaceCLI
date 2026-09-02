/**
 * A scripted stand-in for the browser seam in `src/auth/rungs/browser.ts`.
 *
 * A FakeBrowser is a small state machine over "surfaces" (the campus selector, an SSO hop, the
 * KMSI page, the authenticated home page, ...). Clicks and waits move between them, so a test
 * can script the whole silent-SSO chain, an email prompt, or a page that never changes. The
 * fake clock (`now`) advances on `waitForTimeout` so timeouts elapse instantly.
 */
import type {
  BrowserContextLike,
  BrowserCookie,
  LocatorLike,
  PageLike,
  PlaywrightImporter,
} from '../../src/auth/rungs/browser.js';
import { D2L_LP_JS, XSRF_JS, XSRF_META_JS } from '../../src/auth/rungs/browser.js';

export interface Surface {
  name: string;
  url: string;
  /** CSS selectors and `text:<visible text>` entries that report visible on this surface. */
  visible?: string[];
  /** What `context.cookies()` answers while on this surface. */
  cookies?: BrowserCookie[];
  /** What `window.D2L.LP` evaluates to. */
  d2lLp?: boolean;
  /** `GetXsrfToken()`; an array is consumed one element per call (the last repeats). */
  xsrfJs?: string | null | (string | null)[];
  /** The `<meta name="d2l-xsrf-token">` content. */
  xsrfMeta?: string | null;
  /** Make every `evaluate` throw (a detached frame mid-navigation). */
  evaluateThrows?: boolean;
  /** Click target (a selector, or `text:<text>` for getByText) → next surface. */
  onClick?: Record<string, string>;
  /** After this many `waitForTimeout` calls here, move on (an SSO redirect landing). */
  afterWaits?: { count: number; next: string };
}

interface Target {
  kind: 'css' | 'text';
  query: string;
  exact: boolean;
}

function matches(entry: string, target: Target): boolean {
  // A selector list (`a, b, #c`) matches any of its parts, as it does in playwright.
  if (target.kind === 'css') return target.query.split(',').some((q) => q.trim() === entry);
  if (!entry.startsWith('text:')) return false;
  const text = entry.slice('text:'.length);
  return target.exact
    ? text === target.query
    : text.toLowerCase().includes(target.query.toLowerCase());
}

export interface FakeImporterOptions {
  /** `import('playwright-core')` rejects with this. */
  importError?: Error;
  /** `launchPersistentContext` rejects with this. */
  launchError?: Error;
}

export class FakeBrowser {
  /** Every page/context call in order: `goto <url>`, `click <key>`, `wait <ms>`, `evaluate <label>`. */
  readonly calls: string[] = [];
  readonly launches: { dir: string; options: Record<string, unknown> }[] = [];
  closed = 0;
  now: number;
  readonly page: PageLike;
  readonly context: BrowserContextLike;
  private current: Surface;
  private waitsHere = 0;
  private xsrfJsCalls = 0;

  constructor(
    private readonly surfaces: Surface[],
    options: { now?: number } = {},
  ) {
    const first = surfaces[0];
    if (first === undefined) throw new Error('FakeBrowser needs at least one surface');
    this.current = first;
    this.now = options.now ?? Date.parse('2026-09-02T10:00:00Z');
    this.context = {
      pages: () => [this.page],
      newPage: async () => this.page,
      cookies: async () => [...(this.current.cookies ?? [])],
      close: async () => {
        this.closed += 1;
      },
    };
    this.page = {
      url: () => this.current.url,
      goto: async (url) => {
        this.calls.push(`goto ${url}`);
        return null;
      },
      evaluate: async (script) => this.evaluate(script),
      locator: (selector) => this.locator({ kind: 'css', query: selector, exact: true }),
      getByText: (text, options) =>
        this.locator({ kind: 'text', query: text, exact: options?.exact ?? false }),
      waitForTimeout: async (ms) => {
        this.calls.push(`wait ${ms}`);
        this.now += ms;
        this.waitsHere += 1;
        const after = this.current.afterWaits;
        if (after && this.waitsHere >= after.count) this.moveTo(after.next);
      },
      context: () => this.context,
    };
  }

  get surface(): string {
    return this.current.name;
  }

  get waits(): number {
    return this.calls.filter((c) => c.startsWith('wait ')).length;
  }

  get clicks(): string[] {
    return this.calls.filter((c) => c.startsWith('click ')).map((c) => c.slice('click '.length));
  }

  moveTo(name: string): void {
    const next = this.surfaces.find((s) => s.name === name);
    if (next === undefined) throw new Error(`FakeBrowser: no surface named ${name}`);
    this.current = next;
    this.waitsHere = 0;
    this.xsrfJsCalls = 0;
  }

  /** A `playwright-core` module whose chromium launches this fake. */
  importer(options: FakeImporterOptions = {}): PlaywrightImporter {
    return async () => {
      if (options.importError) throw options.importError;
      return {
        chromium: {
          launchPersistentContext: async (dir, launch) => {
            if (options.launchError) throw options.launchError;
            this.launches.push({ dir, options: { ...launch } });
            return this.context;
          },
        },
      };
    };
  }

  private evaluate(script: string): unknown {
    if (this.current.evaluateThrows) throw new Error('Execution context was destroyed');
    if (script === D2L_LP_JS) {
      this.calls.push('evaluate d2l-lp');
      return this.current.d2lLp ?? false;
    }
    if (script === XSRF_JS) {
      this.calls.push('evaluate xsrf-js');
      const v = this.current.xsrfJs;
      if (Array.isArray(v)) {
        const i = Math.min(this.xsrfJsCalls, v.length - 1);
        this.xsrfJsCalls += 1;
        return v[i] ?? null;
      }
      return v ?? null;
    }
    if (script === XSRF_META_JS) {
      this.calls.push('evaluate xsrf-meta');
      return this.current.xsrfMeta ?? null;
    }
    throw new Error(`FakeBrowser: unscripted evaluate: ${script}`);
  }

  private locator(target: Target): LocatorLike {
    const key = target.kind === 'css' ? target.query : `text:${target.query}`;
    const loc: LocatorLike = {
      first: () => loc,
      isVisible: async () => (this.current.visible ?? []).some((e) => matches(e, target)),
      click: async () => {
        this.calls.push(`click ${key}`);
        const onClick = this.current.onClick ?? {};
        const hit = Object.keys(onClick).find((k) => matches(k, target));
        const next = hit === undefined ? undefined : onClick[hit];
        if (next !== undefined) this.moveTo(next);
      },
    };
    return loc;
  }
}

export const BASE_URL = 'https://purdue.brightspace.com';
export const CAMPUS_TEXT = 'Purdue West Lafayette';

/** Tenant cookies plus the Entra and Shibboleth ones a real context carries after SSO. */
export const ALL_COOKIES: BrowserCookie[] = [
  {
    name: 'd2lSecureSessionVal',
    value: 'SECURE-COOKIE-SECRET-0b7d4e11',
    domain: 'purdue.brightspace.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
  },
  {
    name: 'd2lSessionVal',
    value: 'COOKIE-SECRET-6f1c2a9e',
    domain: 'purdue.brightspace.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
  },
  { name: 'ESTSAUTHPERSISTENT', value: 'ENTRA-SECRET-77aa', domain: 'login.microsoftonline.com' },
  { name: 'shib_idp_session', value: 'SHIB-SECRET-88bb', domain: '.purdue.edu' },
];

export const XSRF_VIA_JS = 'XSRF-JS-SECRET-3c9a8f2d';
export const XSRF_VIA_META = 'XSRF-META-SECRET-9d1e2f3a';

/** The authenticated `/d2l/home` page. */
export function homeSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    name: 'home',
    url: `${BASE_URL}/d2l/home`,
    cookies: ALL_COOKIES,
    d2lLp: true,
    xsrfJs: XSRF_VIA_JS,
    xsrfMeta: XSRF_VIA_META,
    ...overrides,
  };
}

/** The Brightspace campus selector at `/d2l/login`, clicking through to `next`. */
export function loginSurface(next: string): Surface {
  return {
    name: 'login',
    url: `${BASE_URL}/d2l/login?sessionExpired=1&target=%2fd2l%2fhome`,
    visible: ['text:PURDUE WEST LAFAYETTE (main campus)', 'text:Purdue Fort Wayne'],
    onClick: { 'text:purdue west lafayette': next },
  };
}

/** An SSO hop that shows nothing clickable and lands on `next` after one poll. */
export function ssoSurface(next: string): Surface {
  return {
    name: 'sso',
    url: 'https://sso.purdue.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1',
    afterWaits: { count: 1, next },
  };
}

/** Entra's "Stay signed in?" page; Yes lands on `next`. */
export function kmsiSurface(
  next: string,
  marker: '#KmsiCheckboxField' | 'text:Stay signed in?',
): Surface {
  return {
    name: 'kmsi',
    url: 'https://login.microsoftonline.com/common/login',
    visible: [marker, '#idSIButton9'],
    onClick: { '#idSIButton9': next },
  };
}

/** Entra's email prompt: the page silent SSO can never pass. */
export function emailSurface(): Surface {
  return {
    name: 'email',
    url: 'https://login.microsoftonline.com/common/oauth2/authorize?client_id=x',
    visible: ['#i0116', 'input[type=email]', '#idSIButton9'],
  };
}

/** The complete silent chain: campus selector → SSO → KMSI → authenticated home. */
export function silentChain(): Surface[] {
  return [
    loginSurface('sso'),
    ssoSurface('kmsi'),
    kmsiSurface('home', '#KmsiCheckboxField'),
    homeSurface(),
  ];
}
