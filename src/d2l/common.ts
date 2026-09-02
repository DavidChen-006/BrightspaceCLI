/**
 * Shared decoding helpers for the typed D2L route layer (`src/d2l/`). Every parser here is a
 * pure function of a decoded JSON value: it reads, never computes, and treats anything
 * unreadable as "absent" (null) rather than throwing (Brightspace-Bar fetch-engine discipline).
 */
import type { TenantConfig } from '../core/config.js';

/** What an LP route needs to know about the tenant. */
export type LpTenant = Pick<TenantConfig, 'baseUrl' | 'lpVersion'>;

/** What an LE route needs to know about the tenant (the LE twin of `LpTenant`). */
export type LeTenant = Pick<TenantConfig, 'baseUrl' | 'leVersion'>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PRD 6.3: D2LID strings (`Identifier`) become numbers when numeric; other strings pass. */
export function d2lId(value: unknown): number | string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : trimmed;
  }
  return null;
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function optionalBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A D2L BasicOrgUnit `{Identifier, Name, Code}` (semester, department, template). */
export interface OrgUnitRef {
  id: number | string | null;
  name: string | null;
  code: string | null;
}

export function orgUnitRefOf(value: unknown): OrgUnitRef | null {
  if (!isRecord(value)) return null;
  return {
    id: d2lId(value.Identifier),
    name: optionalString(value.Name),
    code: optionalString(value.Code),
  };
}
