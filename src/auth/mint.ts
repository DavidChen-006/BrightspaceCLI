/**
 * Rung 0's JWT mint (PRD 7): `POST {base}/d2l/lp/auth/oauth2/token` with the session cookie
 * and the XSRF token — the one mutation bs is allowed to send.
 *
 * Classification is marker first, then status (Brightspace-Bar Extra 2): a dead cookie answers
 * HTTP 200 with an HTML stub containing `sessionExpired=1`; a 403 means the cookie died later
 * (or `x-csrf-token` is missing); everything else that is not a token is transport, never a
 * reason to climb. Ported from `session-capture/src/fetch-engine.mjs` (`decodeMint`).
 *
 * D7: the cookie, the token and the JWT go into headers and the result; log lines carry
 * lengths and outcomes only.
 */
import { isoAtMs } from '../core/dates.js';
import { CancelledError } from '../core/errors.js';
import { classify, d2lUrl, type HttpClient, type HttpResponse } from '../core/http/index.js';
import { jwtExpiry, type Session } from './session.js';

export const MINT_PATH = '/d2l/lp/auth/oauth2/token';
export const MINT_BODY = 'scope=*:*:*';

export type MintResult =
  | { kind: 'ok'; jwt: string; expiresAt: string }
  | { kind: 'expired'; reason: string }
  | { kind: 'transport'; reason: string };

export interface MintOptions {
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
  /** Verbose diagnostics; never receives a secret. */
  log?: (line: string) => void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mints a bearer token from the session cookie. Never throws except on cancellation. */
export async function mintJwt(
  http: HttpClient,
  session: Session,
  options: MintOptions = {},
): Promise<MintResult> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let response: HttpResponse;
  try {
    response = await http.request({
      method: 'POST',
      url: d2lUrl(session.baseUrl, MINT_PATH),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrfToken,
      },
      body: MINT_BODY,
      allowMutation: true,
    });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    const reason = describe(err);
    log(`mint: transport failure (${reason})`);
    return { kind: 'transport', reason };
  }

  const c = classify(response, { mint: true, expectJson: true });
  if (c.kind === 'SessionExpired') {
    log(`mint: session expired (HTTP ${c.status})`);
    return { kind: 'expired', reason: c.message };
  }
  if (c.kind !== 'ok') {
    log(`mint: ${c.kind} (HTTP ${c.status})`);
    return { kind: 'transport', reason: c.message };
  }
  const payload = JSON.parse(response.body) as unknown;
  const record =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const jwt = record.access_token;
  if (typeof jwt !== 'string' || jwt === '') {
    log('mint: HTTP 2xx without an access_token');
    return { kind: 'transport', reason: `${c.route}: the token mint returned no access_token` };
  }
  const expiresIn = record.expires_in;
  const expiresAt = isoAtMs(
    jwtExpiry(jwt, {
      now: now(),
      fallbackSeconds: typeof expiresIn === 'number' ? expiresIn : undefined,
    }),
  );
  log(`mint: ok (jwt ${jwt.length} chars, expires ${expiresAt})`);
  return { kind: 'ok', jwt, expiresAt };
}
