/**
 * Gradebook routes and parsers (d2l-api-web A-14, A-15; Brightspace-Bar sweep A-14).
 *
 * - `listGradeObjects()` → `grades/` (bare array of GradeObject). The docs discriminate on the
 *   `GradeType` string; the tenant also sends the numeric `GradeObjectTypeId` (Brightspace-Bar
 *   `fetch-engine.mjs` parseGradebook). `gradeTypeOf()` reads the number first, the string second.
 * - `listMyGradeValues()` → `grades/values/myGradeValues/` (bare array of GradeValue). A 404
 *   means "no grades yet" and is returned as an empty array, never thrown.
 * - `getMyFinalGrade()` → `grades/final/values/myGradeValue` (one GradeValue of type 7/8). A 404
 *   means "no final grade released" and is returned as null.
 * - `joinGrades()` is the pure left join on `GradeObject.Id == Number(GradeValue.GradeObjectIdentifier)`
 *   onto the PRD 6.3 Grade shape; values without an object still become rows (neither list is a
 *   superset of the other: sweep A-14), and a missing object list costs only the object fields.
 * - Every value is read, only `url` (the gradebook deep link) is computed; dates are whole-second
 *   UTC or null.
 */
import { isoSeconds } from '../core/dates.js';
import { BsError, NotFoundError } from '../core/errors.js';
import { d2lUrl, displayPath, type HttpClient } from '../core/http/index.js';
import { d2lId, isRecord, type LeTenant, optionalBoolean, optionalString } from './common.js';
import { gradebookUrl } from './links.js';

/** The LE tenant view lives in `common.ts`; re-exported so existing imports keep resolving. */
export type { LeTenant } from './common.js';

// ---------------------------------------------------------------------------------------------
// Wire shapes (documented fields only; parsers tolerate anything missing)
// ---------------------------------------------------------------------------------------------

export interface RichText {
  Text: string;
  Html: string;
}

export interface GradeObject {
  MaxPoints: number | null;
  CanExceedMaxPoints: boolean;
  IsBonus: boolean;
  ExcludeFromFinalGradeCalculation: boolean;
  GradeSchemeId: number | null;
  Id: number;
  Name: string;
  ShortName: string;
  /** Docs discriminator: "Numeric", "PassFail", "SelectBox", "Text", plus calculated/category rows. */
  GradeType: string;
  /** Tenant discriminator (GRADEOBJ_T), present on live payloads. */
  GradeObjectTypeId?: number;
  CategoryId: number | null;
  Description: RichText;
  GradeSchemeUrl: string;
  Weight: number | null;
  AssociatedTool: { ToolId: number; ToolItemId: number } | null;
  IsHidden: boolean;
}

export interface GradeValue {
  DisplayedGrade: string;
  /** String D2LID of the grade object. */
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  /** GRADEOBJ_T number. */
  GradeObjectType: number;
  GradeObjectTypeName: string | null;
  Comments: RichText;
  PrivateComments: RichText;
  LastModified: string | null;
  LastModifiedBy: string | null;
  ReleasedDate: string | null;
  /** Computable values only (all types but Text). */
  PointsNumerator?: number | null;
  PointsDenominator?: number | null;
  WeightedDenominator?: number | null;
  WeightedNumerator?: number | null;
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3)
// ---------------------------------------------------------------------------------------------

/** GRADEOBJ_T (d2l-api-web A-14); 9 is the category row the tenant sends (Brightspace-Bar). */
export const GRADE_TYPES: Readonly<Record<number, string>> = Object.freeze({
  1: 'numeric',
  2: 'passFail',
  3: 'selectBox',
  4: 'text',
  5: 'calculated',
  6: 'formula',
  7: 'finalCalculated',
  8: 'finalAdjusted',
  9: 'category',
});

export interface MyGradeValue {
  /** Instructor-facing rendering of the grade ("9 / 10", "Pass", "87.5 %"). */
  displayed: string | null;
  numerator: number | null;
  denominator: number | null;
  weightedNumerator: number | null;
  weightedDenominator: number | null;
  lastModified: string | null;
  /** True when D2L reports a `ReleasedDate`. */
  released: boolean;
  releasedDate: string | null;
  /** Instructor feedback (`Comments.Text`; the Html is in --raw): wrapped under --wrap-untrusted. */
  comments: string | null;
}

export interface Grade {
  id: number;
  name: string;
  shortName: string | null;
  type: string | null;
  maxPoints: number | null;
  weight: number | null;
  isBonus: boolean;
  associatedTool: { toolId: number | null; toolItemId: number | null } | null;
  /** Null when the user has no value for this item (including the "no grades yet" 404). */
  myValue: MyGradeValue | null;
  url: string;
}

/** `bs grades final`: the released final grade, or the `released: false` shape on 404. */
export interface FinalGrade extends MyGradeValue {
  courseId: number;
  id: number | null;
  name: string | null;
  type: string | null;
  url: string;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export function gradeObjectsUrl(cfg: LeTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/grades/`);
}

export function myGradeValuesUrl(cfg: LeTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/grades/values/myGradeValues/`);
}

export function myFinalGradeUrl(cfg: LeTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/grades/final/values/myGradeValue`);
}

function expectArray(url: string, payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  throw new BsError('error', `GET ${displayPath(url)}: expected a bare array`, {
    hint: 'Run: bs grades list <ou> --raw  to inspect the payload, or bs auth doctor',
  });
}

/** The grade objects of an org unit; a 404 here is a real not-found (exit 5). */
export async function listGradeObjects(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
): Promise<unknown[]> {
  const url = gradeObjectsUrl(cfg, ou);
  return expectArray(url, await http.json<unknown>({ method: 'GET', url }));
}

/** The user's grade values; 404 = "no grades yet" → `[]` (d2l-api-web A-14). */
export async function listMyGradeValues(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
): Promise<unknown[]> {
  const url = myGradeValuesUrl(cfg, ou);
  try {
    return expectArray(url, await http.json<unknown>({ method: 'GET', url }));
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    throw err;
  }
}

/** The user's final grade; 404 = none released → `null` (d2l-api-web A-15). */
export async function getMyFinalGrade(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
): Promise<unknown | null> {
  try {
    return await http.json<unknown>({ method: 'GET', url: myFinalGradeUrl(cfg, ou) });
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Empty rich text (`{Text: "", Html: ""}`) reads as "no comment". */
function richText(value: unknown, key: 'Text' | 'Html'): string | null {
  return isRecord(value) ? nonEmpty(value[key]) : null;
}

/**
 * GRADEOBJ_T number → name; a docs-style string ("PassFail") → the same name; anything else
 * documented nowhere passes through as text so nothing is silently lost.
 */
export function gradeTypeOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return GRADE_TYPES[value] ?? String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const wanted = trimmed.toLowerCase();
    for (const name of Object.values(GRADE_TYPES)) {
      if (name.toLowerCase() === wanted) return name;
    }
    return trimmed;
  }
  return null;
}

/** One GradeValue onto the `myValue` shape; null when the item is not an object. */
export function gradeValueOf(raw: unknown): MyGradeValue | null {
  if (!isRecord(raw)) return null;
  const releasedDate = isoSeconds(raw.ReleasedDate);
  const displayed = optionalString(raw.DisplayedGrade);
  return {
    displayed: displayed === '' ? null : displayed,
    numerator: optionalNumber(raw.PointsNumerator),
    denominator: optionalNumber(raw.PointsDenominator),
    weightedNumerator: optionalNumber(raw.WeightedNumerator),
    weightedDenominator: optionalNumber(raw.WeightedDenominator),
    lastModified: isoSeconds(raw.LastModified),
    released: releasedDate !== null,
    releasedDate,
    comments: richText(raw.Comments, 'Text'),
  };
}

/** The numeric grade object id a value points at, or null. */
export function gradeValueObjectId(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const id = d2lId(raw.GradeObjectIdentifier);
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

function nonEmpty(value: unknown): string | null {
  const text = optionalString(value);
  return text === null || text === '' ? null : text;
}

/** A GradeObject with its (possibly absent) value; null when the object has no numeric Id. */
export function gradeOf(
  object: unknown,
  value: unknown,
  baseUrl: string,
  ou: number,
): Grade | null {
  if (!isRecord(object)) return null;
  const id = object.Id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const tool = isRecord(object.AssociatedTool) ? object.AssociatedTool : null;
  return {
    id,
    name: optionalString(object.Name) ?? '',
    shortName: nonEmpty(object.ShortName),
    type: gradeTypeOf(object.GradeObjectTypeId) ?? gradeTypeOf(object.GradeType),
    maxPoints: optionalNumber(object.MaxPoints),
    weight: optionalNumber(object.Weight),
    isBonus: optionalBoolean(object.IsBonus),
    associatedTool:
      tool === null
        ? null
        : { toolId: optionalNumber(tool.ToolId), toolItemId: optionalNumber(tool.ToolItemId) },
    myValue: gradeValueOf(value),
    url: gradebookUrl(baseUrl, ou),
  };
}

/** A value whose object is unknown (hidden object, or the objects route failed): the value's own fields. */
function gradeFromValueOnly(value: unknown, baseUrl: string, ou: number): Grade | null {
  const id = gradeValueObjectId(value);
  if (id === null || !isRecord(value)) return null;
  return {
    id,
    name: optionalString(value.GradeObjectName) ?? '',
    shortName: null,
    type: gradeTypeOf(value.GradeObjectType) ?? gradeTypeOf(value.GradeObjectTypeName),
    maxPoints: null,
    weight: null,
    isBonus: false,
    associatedTool: null,
    myValue: gradeValueOf(value),
    url: gradebookUrl(baseUrl, ou),
  };
}

/**
 * Left join of the grade objects with the user's values (PRD 6.2). Objects keep their order;
 * values without a matching object follow in their own order. `objects === null` means the
 * objects route failed: every decodable value becomes a row. Undecodable items go to `onSkip`.
 */
export function joinGrades(
  objects: readonly unknown[] | null,
  values: readonly unknown[],
  baseUrl: string,
  ou: number,
  onSkip: (item: unknown) => void = () => {},
): Grade[] {
  const byObjectId = new Map<number, unknown>();
  for (const value of values) {
    const id = gradeValueObjectId(value);
    if (id === null) onSkip(value);
    else byObjectId.set(id, value);
  }
  const rows: Grade[] = [];
  const consumed = new Set<number>();
  for (const object of objects ?? []) {
    const id = isRecord(object) && typeof object.Id === 'number' ? object.Id : null;
    const value = id === null ? null : (byObjectId.get(id) ?? null);
    const row = gradeOf(object, value, baseUrl, ou);
    if (row === null) {
      onSkip(object);
      continue;
    }
    consumed.add(row.id);
    rows.push(row);
  }
  for (const [id, value] of byObjectId) {
    if (consumed.has(id)) continue;
    const row = gradeFromValueOnly(value, baseUrl, ou);
    if (row === null) onSkip(value);
    else rows.push(row);
  }
  return rows;
}

/**
 * The final grade shape. `raw === null` (the route's 404) or an unreadable body is "not
 * released"; a 200 is released by route semantics (A-15) whatever `ReleasedDate` says.
 */
export function finalGradeOf(raw: unknown, baseUrl: string, ou: number): FinalGrade {
  const url = gradebookUrl(baseUrl, ou);
  const value = gradeValueOf(raw);
  const released = value !== null && isRecord(raw);
  return {
    courseId: ou,
    released,
    id: released ? gradeValueObjectId(raw) : null,
    name: released ? nonEmpty(raw.GradeObjectName) : null,
    type: released
      ? (gradeTypeOf(raw.GradeObjectType) ?? gradeTypeOf(raw.GradeObjectTypeName))
      : null,
    displayed: value?.displayed ?? null,
    numerator: value?.numerator ?? null,
    denominator: value?.denominator ?? null,
    weightedNumerator: value?.weightedNumerator ?? null,
    weightedDenominator: value?.weightedDenominator ?? null,
    lastModified: value?.lastModified ?? null,
    releasedDate: value?.releasedDate ?? null,
    comments: value?.comments ?? null,
    url,
  };
}
