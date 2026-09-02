/**
 * `GET /d2l/api/lp/(v)/users/whoami` (d2l-api-web A-08).
 */
import { d2lUrl, type HttpClient } from '../core/http/index.js';
import { d2lId, isRecord, type LpTenant, optionalString } from './common.js';

/** The wire shape; `Identifier` is a string D2LID. */
export interface WhoAmIUser {
  Identifier: string;
  FirstName: string;
  LastName: string;
  UniqueName: string;
  ProfileIdentifier: string;
  Pronouns: string;
}

/** The curated shape (PRD 6.2). */
export interface User {
  id: number | string | null;
  firstName: string | null;
  lastName: string | null;
  uniqueName: string | null;
  pronouns: string | null;
}

export function whoamiUrl(cfg: LpTenant): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/lp/${cfg.lpVersion}/users/whoami`);
}

export function whoami(http: HttpClient, cfg: LpTenant): Promise<WhoAmIUser> {
  return http.json<WhoAmIUser>({ method: 'GET', url: whoamiUrl(cfg) });
}

export function userOf(raw: unknown): User {
  const r = isRecord(raw) ? raw : {};
  return {
    id: d2lId(r.Identifier),
    firstName: optionalString(r.FirstName),
    lastName: optionalString(r.LastName),
    uniqueName: optionalString(r.UniqueName),
    pronouns: optionalString(r.Pronouns),
  };
}
