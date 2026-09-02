/**
 * Enrollments and course offerings (d2l-api-web A-09, A-10; Brightspace-Bar sweep A-09).
 *
 * - `enrollmentsUrl()` builds the myenrollments query; `listEnrollments()` walks it via
 *   `pagedResultSet` (bookmark paging; every other parameter, `sortBy` included, is repeated
 *   on each segment by construction because the helper re-derives each URL from the first).
 * - `getEnrollment()` / `getCourse()` are the two single-item routes `bs courses get` merges.
 * - `courseOf()` / `courseDetailOf()` are pure parsers onto the PRD 6.3 Course shape: every
 *   value is read, only `url` is computed (`HomeUrl` is null on 25/27 real items), and dates
 *   are normalised to whole-second UTC or null.
 */
import type { TenantConfig } from '../core/config.js';
import { isoSeconds, toD2lDateTime } from '../core/dates.js';
import {
  d2lUrl,
  type HttpClient,
  type PageOptions,
  pagedResultSet,
  type Query,
} from '../core/http/index.js';
import {
  isRecord,
  type LpTenant,
  type OrgUnitRef,
  optionalBoolean,
  optionalString,
  orgUnitRefOf,
} from './common.js';
import { courseHomeUrl } from './links.js';

export type CourseTenant = LpTenant & Pick<TenantConfig, 'courseTypeId'>;

// ---------------------------------------------------------------------------------------------
// Wire shapes (documented fields only; parsers tolerate anything missing)
// ---------------------------------------------------------------------------------------------

export interface MyOrgUnitInfo {
  OrgUnit: {
    Id: number;
    Type: { Id: number; Code: string; Name: string };
    Name: string;
    Code: string | null;
    HomeUrl: string | null;
    ImageUrl: string | null;
  };
  Access: {
    IsActive: boolean;
    StartDate: string | null;
    EndDate: string | null;
    CanAccess: boolean;
    ClasslistRoleName: string | null;
    LISRoles: string[];
    LastAccessed: string | null;
  };
  PinDate: string | null;
}

export interface CourseOffering {
  Identifier: string;
  Name: string;
  Code: string;
  IsActive: boolean;
  Path: string;
  StartDate: string | null;
  EndDate: string | null;
  CourseTemplate: { Identifier: string; Name: string; Code: string } | null;
  Semester: { Identifier: string; Name: string; Code: string } | null;
  Department: { Identifier: string; Name: string; Code: string } | null;
  Description: { Text: string; Html: string };
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3)
// ---------------------------------------------------------------------------------------------

export interface Course {
  id: number;
  name: string;
  code: string | null;
  role: string | null;
  isActive: boolean;
  canAccess: boolean;
  startDate: string | null;
  endDate: string | null;
  /** As sent by D2L (null on most items); `url` is the derived deep link. */
  homeUrl: string | null;
  url: string;
}

/** `bs courses get`: the Course plus what only `courses/(ou)` knows. */
export interface CourseDetail extends Course {
  path: string | null;
  /** Instructor-authored free text: wrapped under --wrap-untrusted. */
  description: string | null;
  descriptionHtml: string | null;
  semester: OrgUnitRef | null;
  department: OrgUnitRef | null;
}

export const COURSE_COLUMNS: readonly (keyof Course)[] = [
  'id',
  'name',
  'code',
  'role',
  'isActive',
  'canAccess',
  'startDate',
  'endDate',
  'homeUrl',
  'url',
];

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export type EnrollmentSort = 'name' | 'start' | 'end';
export const ENROLLMENT_SORTS: readonly EnrollmentSort[] = ['name', 'start', 'end'];
const SORT_BY: Readonly<Record<EnrollmentSort, string>> = {
  name: 'OrgUnitName',
  start: 'StartDate',
  end: 'EndDate',
};

export interface ListEnrollmentsOptions {
  /** Drop the `orgUnitTypeId` filter (every org unit type, e.g. future-term sections). */
  all?: boolean;
  /** Drop `isActive=true`. */
  inactive?: boolean;
  /** Drop the `startDateTime=now` window that hides ended courses. */
  ended?: boolean;
  sort?: EnrollmentSort;
  /** The instant "now" for the ended-course window; defaults to the wall clock. */
  now?: Date;
}

export function enrollmentsUrl(cfg: CourseTenant, options: ListEnrollmentsOptions = {}): string {
  const query: Query = {
    orgUnitTypeId: options.all ? undefined : cfg.courseTypeId,
    isActive: options.inactive ? undefined : true,
    startDateTime: options.ended ? undefined : toD2lDateTime(options.now ?? new Date()),
    sortBy: options.sort === undefined ? undefined : SORT_BY[options.sort],
  };
  return d2lUrl(cfg.baseUrl, `/d2l/api/lp/${cfg.lpVersion}/enrollments/myenrollments/`, query);
}

export function enrollmentUrl(cfg: LpTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/lp/${cfg.lpVersion}/enrollments/myenrollments/${ou}`);
}

export function courseUrl(cfg: LpTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/lp/${cfg.lpVersion}/courses/${ou}`);
}

/** Raw MyOrgUnitInfo items across every bookmark segment; stop iterating to stop fetching. */
export function listEnrollments(
  http: HttpClient,
  cfg: CourseTenant,
  options: ListEnrollmentsOptions = {},
  page: PageOptions = {},
): AsyncGenerator<MyOrgUnitInfo, void, undefined> {
  return pagedResultSet<MyOrgUnitInfo>(
    enrollmentsUrl(cfg, options),
    (url) => http.json<unknown>({ method: 'GET', url }),
    page,
  );
}

export function getEnrollment(http: HttpClient, cfg: LpTenant, ou: number): Promise<MyOrgUnitInfo> {
  return http.json<MyOrgUnitInfo>({ method: 'GET', url: enrollmentUrl(cfg, ou) });
}

export function getCourse(http: HttpClient, cfg: LpTenant, ou: number): Promise<CourseOffering> {
  return http.json<CourseOffering>({ method: 'GET', url: courseUrl(cfg, ou) });
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

/** One enrollment onto the Course shape; null when the item carries no numeric OrgUnit.Id. */
export function courseOf(item: unknown, baseUrl: string): Course | null {
  if (!isRecord(item) || !isRecord(item.OrgUnit)) return null;
  const orgUnit = item.OrgUnit;
  const access = isRecord(item.Access) ? item.Access : {};
  const id = orgUnit.Id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  return {
    id,
    name: optionalString(orgUnit.Name) ?? '',
    code: optionalString(orgUnit.Code),
    role: optionalString(access.ClasslistRoleName),
    isActive: optionalBoolean(access.IsActive),
    canAccess: optionalBoolean(access.CanAccess),
    startDate: isoSeconds(access.StartDate),
    endDate: isoSeconds(access.EndDate),
    homeUrl: optionalString(orgUnit.HomeUrl),
    url: courseHomeUrl(baseUrl, id),
  };
}

/** The enrollment is the primitive; a missing offering (second call failed) costs only its fields. */
export function courseDetailOf(
  enrollment: unknown,
  offering: unknown,
  baseUrl: string,
): CourseDetail | null {
  const course = courseOf(enrollment, baseUrl);
  if (course === null) return null;
  const o = isRecord(offering) ? offering : {};
  const description = isRecord(o.Description) ? o.Description : {};
  return {
    ...course,
    path: optionalString(o.Path),
    description: optionalString(description.Text),
    descriptionHtml: optionalString(description.Html),
    semester: orgUnitRefOf(o.Semester),
    department: orgUnitRefOf(o.Department),
  };
}

/** Decodes a stream of enrollments, reporting undecodable items instead of dropping them silently. */
export async function* courses(
  items: AsyncIterable<unknown>,
  baseUrl: string,
  onSkip: (item: unknown) => void = () => {},
): AsyncGenerator<Course, void, undefined> {
  for await (const item of items) {
    const course = courseOf(item, baseUrl);
    if (course === null) onSkip(item);
    else yield course;
  }
}
