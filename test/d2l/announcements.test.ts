import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSince, safeFileName } from '../../src/cli/commands/announcements.js';
import {
  type Announcement,
  announcementOf,
  announcements,
  attachmentOf,
  attachmentUrl,
  newestFirst,
  newsUrl,
  stripHtml,
} from '../../src/d2l/announcements.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };
const NOW = new Date('2026-09-02T12:00:00.000Z');

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture(name: string): unknown[] {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}
const CIVICS = fixture('news-412690.json');
const HONORS = fixture('news-440703.json');
const MIXED = fixture('news-with-mixed-dates.json');

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test('newsUrl: collection with trailing slash, LE version from config, since only when given', () => {
  assert.equal(newsUrl(CFG, 412690), `${BASE}/d2l/api/le/1.96/412690/news/`);
  assert.equal(
    newsUrl({ ...CFG, leVersion: '1.80' }, 412690),
    `${BASE}/d2l/api/le/1.80/412690/news/`,
  );
  const url = newsUrl(CFG, 412690, { since: new Date('2026-03-11T14:22:31Z') });
  assert.ok(url.startsWith(`${BASE}/d2l/api/le/1.96/412690/news/?`), url);
  assert.equal(query(url).get('since'), '2026-03-11T14:22:31.000Z', 'D2L UTCDateTime with ms');
  assert.equal([...query(url).keys()].length, 1);
});

test('attachmentUrl: the single-item route, no trailing slash', () => {
  assert.equal(
    attachmentUrl(CFG, 412690, 1386315, 39381028),
    `${BASE}/d2l/api/le/1.96/412690/news/1386315/attachments/39381028`,
  );
});

test('announcementOf: the pinned Civics item with a PDF attachment (size from `Size`)', () => {
  const item = CIVICS.find((i) => (i as { Id: number }).Id === 1386315) as {
    Body: { Text: string; Html: string };
  };
  const out = announcementOf(item, 412690, BASE);
  assert.deepEqual(out, {
    id: 1386315,
    courseId: 412690,
    title: 'Brightspace Notifications',
    bodyText: item.Body.Text,
    bodyHtml: item.Body.Html,
    date: '2024-07-29T21:00:00Z',
    pinned: true,
    attachments: [
      {
        fileId: 39381028,
        fileName: 'How to Modify Brightspace Course Notifications.pdf',
        size: 229139,
      },
    ],
    url: `${BASE}/d2l/lms/news/main.d2l?ou=412690`,
  });
  assert.ok(out?.bodyText?.startsWith('To modify any Brightspace course notification settings'));
  assert.ok(out?.bodyHtml?.includes('&#160;'), 'Html kept verbatim, entities and all');
});

test('attachmentOf: FileSize (documented) wins over Size (observed); neither is null; no FileId is null', () => {
  assert.deepEqual(attachmentOf({ FileId: 1, FileName: 'a.pdf', FileSize: 10, Size: 20 }), {
    fileId: 1,
    fileName: 'a.pdf',
    size: 10,
  });
  assert.deepEqual(attachmentOf({ FileId: 2, FileName: 'b.pdf', Size: 20 }), {
    fileId: 2,
    fileName: 'b.pdf',
    size: 20,
  });
  assert.deepEqual(attachmentOf({ FileId: 3, FileName: 'c.pdf' }), {
    fileId: 3,
    fileName: 'c.pdf',
    size: null,
  });
  assert.equal(attachmentOf({ FileName: 'd.pdf' }), null);
  assert.equal(attachmentOf('nope'), null);
});

test('announcementOf: StartDate wins, CreatedDate is the fallback, unreadable and absent alike', () => {
  const byId = new Map(MIXED.map((i) => [(i as { Id: number }).Id, i]));
  const date = (id: number) => announcementOf(byId.get(id), 1, BASE)?.date;
  assert.equal(date(800001), '2026-01-04T08:00:00Z', 'StartDate');
  assert.equal(date(800002), '2026-03-11T14:22:31Z', 'no StartDate → CreatedDate, ms dropped');
  assert.equal(date(800003), '2026-06-30T23:59:00Z', 'whole-second input stays whole-second');
  assert.equal(date(800004), null, 'no date at all');
  assert.equal(date(800006), '2026-05-01T10:00:00Z', 'unreadable StartDate → CreatedDate');
});

test('announcementOf: bodyText falls back to stripped Html; missing Body yields nulls; bad shapes are null', () => {
  const base = { Id: 7, Title: 'T', IsPinned: false, Attachments: [] };
  const fromHtml = announcementOf(
    { ...base, Body: { Html: '<p>Hello&#160;<b>there</b> &amp; &quot;you&quot;</p>' } },
    1,
    BASE,
  );
  assert.equal(fromHtml?.bodyText, 'Hello there & "you"');
  assert.equal(fromHtml?.bodyHtml, '<p>Hello&#160;<b>there</b> &amp; &quot;you&quot;</p>');
  const empty = announcementOf({ ...base, Body: { Text: '', Html: '' } }, 1, BASE);
  assert.equal(empty?.bodyText, '', 'an empty Text is a value, not a fallback trigger');
  const noBody = announcementOf(base, 1, BASE);
  assert.equal(noBody?.bodyText, null);
  assert.equal(noBody?.bodyHtml, null);
  assert.deepEqual(noBody?.attachments, []);
  assert.equal(noBody?.pinned, false);
  assert.equal(announcementOf({ Title: 'no id' }, 1, BASE), null);
  assert.equal(announcementOf({ Id: '12' }, 1, BASE), null);
  assert.equal(announcementOf(null, 1, BASE), null);
});

test('stripHtml: tags out, block boundaries to newlines, entities decoded, whitespace collapsed', () => {
  assert.equal(stripHtml('<p>One</p><p>Two</p>'), 'One\nTwo');
  assert.equal(stripHtml('a<br>b<br/>c'), 'a\nb\nc');
  assert.equal(stripHtml('x &lt; y &gt; z &#39;q&#39; &nbsp; &#x41;'), "x < y > z 'q' A");
  assert.equal(stripHtml('  <div> spaced   out </div> '), 'spaced out');
  assert.equal(stripHtml(''), '');
});

test('announcements: drops only IsPublished === false, sorts newest-first with undated last, reports undecodable items', () => {
  const skipped: unknown[] = [];
  const out = announcements(MIXED, 99, BASE, (item) => skipped.push(item));
  assert.deepEqual(
    out.map((a) => a.id),
    [800003, 800006, 800002, 800001, 800004],
  );
  assert.equal(skipped.length, 0);
  assert.ok(out.every((a) => a.courseId === 99));

  const withBad = announcements([...CIVICS, { Title: 'mid-deletion' }, 'junk'], 412690, BASE, (i) =>
    skipped.push(i),
  );
  assert.equal(withBad.length, 4);
  assert.equal(skipped.length, 2);
  assert.deepEqual(
    withBad.map((a) => a.id),
    [1654367, 1654190, 1386315, 504396],
  );

  const omitted = announcements([{ Id: 1, Title: 'no IsPublished field' }], 1, BASE);
  assert.equal(omitted.length, 1, 'a missing IsPublished is not unpublished');
});

test('announcements: the 12-item Honors capture keeps every item and the two-file attachment list', () => {
  const out = announcements(HONORS, 440703, BASE);
  assert.equal(out.length, 12);
  assert.equal(out[0]?.id, 1975874);
  const purc = out.find((a) => a.id === 1907220) as Announcement;
  assert.deepEqual(
    purc.attachments.map((a) => a.fileId),
    [57595852, 57595853],
  );
  assert.equal(purc.attachments[1]?.size, 6676217);
});

test('newestFirst: fixed-width UTC strings compare as text; null last; equal keeps order', () => {
  const at = (date: string | null): Announcement => ({ date }) as Announcement;
  assert.ok(newestFirst(at('2026-01-01T00:00:00Z'), at('2025-01-01T00:00:00Z')) < 0);
  assert.ok(newestFirst(at('2025-01-01T00:00:00Z'), at('2026-01-01T00:00:00Z')) > 0);
  assert.ok(newestFirst(at(null), at('2000-01-01T00:00:00Z')) > 0);
  assert.ok(newestFirst(at('2000-01-01T00:00:00Z'), at(null)) < 0);
  assert.equal(newestFirst(at(null), at(null)), 0);
  assert.equal(newestFirst(at('2026-01-01T00:00:00Z'), at('2026-01-01T00:00:00Z')), 0);
});

test('parseSince: ISO timestamps, calendar dates (UTC midnight) and relative durations', () => {
  assert.equal(parseSince('2026-03-11T14:22:31Z', NOW).toISOString(), '2026-03-11T14:22:31.000Z');
  assert.equal(
    parseSince('2026-03-11T09:22:31.500-05:00', NOW).toISOString(),
    '2026-03-11T14:22:31.500Z',
  );
  assert.equal(parseSince('2026-03-11', NOW).toISOString(), '2026-03-11T00:00:00.000Z');
  assert.equal(parseSince('7d', NOW).toISOString(), '2026-08-26T12:00:00.000Z');
  assert.equal(parseSince('2w', NOW).toISOString(), '2026-08-19T12:00:00.000Z');
  assert.equal(parseSince('36h', NOW).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(parseSince('90m', NOW).toISOString(), '2026-09-02T10:30:00.000Z');
  for (const bad of [
    'yesterday',
    '',
    '2026-13-01',
    '7',
    'd',
    '-7d',
    '7 d',
    '2026-03-11T25:00:00Z',
  ]) {
    assert.throws(() => parseSince(bad, NOW), /expected/, JSON.stringify(bad));
  }
});

test('safeFileName: basename only, control characters and leading dots stripped, fallback when empty', () => {
  assert.equal(safeFileName('How to Modify.pdf', 'x'), 'How to Modify.pdf');
  assert.equal(safeFileName('../../etc/passwd', 'x'), 'passwd');
  assert.equal(safeFileName('..\\..\\evil.exe', 'x'), 'evil.exe');
  assert.equal(safeFileName('.hidden', 'x'), 'hidden');
  assert.equal(safeFileName('a b\nc.txt', 'x'), 'abc.txt');
  assert.equal(safeFileName('  ', 'attachment-5'), 'attachment-5');
  assert.equal(safeFileName(null, 'attachment-5'), 'attachment-5');
  assert.equal(safeFileName('..', 'attachment-5'), 'attachment-5');
  const long = `${'a'.repeat(300)}.pdf`;
  const trimmed = safeFileName(long, 'x');
  assert.ok(trimmed.length <= 200, String(trimmed.length));
  assert.ok(trimmed.endsWith('.pdf'));
});
