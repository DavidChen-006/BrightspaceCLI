/**
 * Calendar (d2l-api-web A-21; Brightspace-Bar sweep A-21).
 *
 * - `calendar/events/myEvents/?orgUnitIdsCSV=&startDateTime=&endDateTime=[&eventType=]` is an
 *   ObjectListPage (server order: descending StartDateTime); `listMyEvents()` walks `Next`.
 *   Dates go out as UTCDateTime with milliseconds (`toD2lDateTime`, Extra D). The tenant
 *   answers HTTP 200 with no events because instructors never opt in (`DisplayInCalendar`
 *   false everywhere), so an empty page is the normal outcome, never an error.
 * - `eventOf()` is the pure parser onto the PRD 6.3 Event shape: every value read, only the
 *   fallback `url` computed (`CalendarEventViewUrl` wins when D2L sends one), dates
 *   whole-second UTC or null, `type` the EVENTTYPE_T name.
 */
import { isoSeconds, toD2lDateTime } from '../core/dates.js';
import { d2lUrl, type HttpClient, objectListPage, type PageOptions } from '../core/http/index.js';
import { d2lId, isRecord, optionalBoolean, optionalString } from './common.js';
import { calendarUrl } from './links.js';
import type { LeTenant } from './quizzes.js';

/** `orgUnitIdsCSV` accepts at most 100 org units per request (d2l-api-web Extra E). */
export const MAX_ORG_UNITS_PER_REQUEST = 100;

/** EVENTTYPE_T (A-21). */
export const EVENT_TYPES = {
  reminder: 1,
  'availability-starts': 2,
  'availability-ends': 3,
  'unlock-starts': 4,
  'unlock-ends': 5,
  due: 6,
} as const;

export type EventTypeName = keyof typeof EVENT_TYPES;
export const EVENT_TYPE_NAMES: readonly EventTypeName[] = Object.keys(
  EVENT_TYPES,
) as EventTypeName[];

export function eventTypeName(value: unknown): EventTypeName | null {
  if (typeof value !== 'number') return null;
  for (const name of EVENT_TYPE_NAMES) if (EVENT_TYPES[name] === value) return name;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Wire shape (documented fields only; the parser tolerates anything missing)
// ---------------------------------------------------------------------------------------------

export interface EventDataInfo {
  CalendarEventId: number;
  OrgUnitId: number | string;
  Title: string;
  Description: string;
  StartDateTime: string | null;
  EndDateTime: string | null;
  IsAllDayEvent: boolean;
  OrgUnitName: string;
  OrgUnitCode: string | null;
  IsAssociatedWithEntity: boolean;
  AssociatedEntity: {
    AssociatedEntityType: string;
    AssociatedEntityId: number | string;
    Link: string | null;
  } | null;
  CalendarEventViewUrl: string | null;
  EventType?: number;
}

// ---------------------------------------------------------------------------------------------
// Curated shape (PRD 6.3 Event)
// ---------------------------------------------------------------------------------------------

export interface AssociatedEntity {
  type: string | null;
  id: number | string | null;
  link: string | null;
}

export interface CalendarEvent {
  id: number;
  courseId: number | string | null;
  courseCode: string | null;
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  title: string;
  description: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  /** EVENTTYPE_T name (`due`, `reminder`, ...); null when absent or unknown. */
  type: EventTypeName | null;
  associated: AssociatedEntity | null;
  /** `CalendarEventViewUrl`, else the course calendar; null without an org unit. */
  url: string | null;
}

// ---------------------------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------------------------

export interface MyEventsQuery {
  orgUnitIds: readonly number[];
  from: Date;
  to: Date;
  eventType?: EventTypeName;
}

export function myEventsUrl(cfg: LeTenant, query: MyEventsQuery): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/calendar/events/myEvents/`, {
    orgUnitIdsCSV: query.orgUnitIds.join(','),
    startDateTime: toD2lDateTime(query.from),
    endDateTime: toD2lDateTime(query.to),
    eventType: query.eventType === undefined ? undefined : EVENT_TYPES[query.eventType],
  });
}

/** Raw EventDataInfo objects across every `Next` page; stop iterating to stop fetching. */
export function listMyEvents(
  http: HttpClient,
  cfg: LeTenant,
  query: MyEventsQuery,
  page: PageOptions = {},
): AsyncGenerator<unknown, void, undefined> {
  return objectListPage<unknown>(
    myEventsUrl(cfg, query),
    (url) => http.json<unknown>({ method: 'GET', url }),
    page,
  );
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

function associatedOf(value: unknown): AssociatedEntity | null {
  if (!isRecord(value)) return null;
  return {
    type: optionalString(value.AssociatedEntityType),
    id: d2lId(value.AssociatedEntityId),
    link: optionalString(value.Link),
  };
}

/** One EventDataInfo onto the Event shape; null when it carries no numeric CalendarEventId. */
export function eventOf(item: unknown, baseUrl: string): CalendarEvent | null {
  if (!isRecord(item)) return null;
  const id = item.CalendarEventId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const courseId = d2lId(item.OrgUnitId);
  const viewUrl = optionalString(item.CalendarEventViewUrl);
  let url: string | null = viewUrl !== null && viewUrl !== '' ? viewUrl : null;
  if (url === null && typeof courseId === 'number') url = calendarUrl(baseUrl, courseId);
  return {
    id,
    courseId,
    courseCode: optionalString(item.OrgUnitCode),
    title: optionalString(item.Title) ?? '',
    description: optionalString(item.Description),
    start: isoSeconds(item.StartDateTime),
    end: isoSeconds(item.EndDateTime),
    allDay: optionalBoolean(item.IsAllDayEvent),
    type: eventTypeName(item.EventType),
    associated: associatedOf(item.AssociatedEntity),
    url,
  };
}

/** Decodes a stream of EventDataInfo, reporting undecodable objects instead of dropping them silently. */
export async function* events(
  items: AsyncIterable<unknown>,
  baseUrl: string,
  onSkip: (item: unknown) => void = () => {},
): AsyncGenerator<CalendarEvent, void, undefined> {
  for await (const item of items) {
    const event = eventOf(item, baseUrl);
    if (event === null) onSkip(item);
    else yield event;
  }
}
