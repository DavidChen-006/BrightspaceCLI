import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  activityTypeName,
  contentModuleStructureUrl,
  contentTocUrl,
  contentTopicFileUrl,
  contentTopicUrl,
  filenameFromContentDisposition,
  flattenToc,
  moduleChildOf,
  safeFileName,
  tocTree,
  topicDetailOf,
  topicTypeName,
} from '../../src/d2l/content.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };
const OU = 412690;

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const TOC = fixture('content-toc-doc-shaped.json');
const EMPTY = fixture('content-toc-empty.json');
const TOPIC = fixture<Record<string, unknown>>('content-topic-4000001-doc-shaped.json');
const LINK = fixture<Record<string, unknown>>('content-topic-4000002-link-doc-shaped.json');
const STRUCTURE = fixture<Record<string, unknown>[]>(
  'content-module-3000001-structure-doc-shaped.json',
);

test('content routes: toc carries ignoreDateRestrictions, structure ends with "/", items do not', () => {
  assert.equal(
    contentTocUrl(CFG, OU),
    `${BASE}/d2l/api/le/1.96/${OU}/content/toc?ignoreDateRestrictions=true`,
  );
  assert.equal(
    contentTopicUrl(CFG, OU, 4000001),
    `${BASE}/d2l/api/le/1.96/${OU}/content/topics/4000001`,
  );
  assert.equal(
    contentTopicFileUrl(CFG, OU, 4000001),
    `${BASE}/d2l/api/le/1.96/${OU}/content/topics/4000001/file`,
  );
  assert.equal(
    contentModuleStructureUrl(CFG, OU, 3000001),
    `${BASE}/d2l/api/le/1.96/${OU}/content/modules/3000001/structure/`,
  );
  assert.equal(
    contentTocUrl({ ...CFG, leVersion: '1.80' }, 7),
    `${BASE}/d2l/api/le/1.80/7/content/toc?ignoreDateRestrictions=true`,
  );
});

test('activity and topic type enums map to names; unknown numbers keep their id', () => {
  assert.equal(activityTypeName(1), 'File');
  assert.equal(activityTypeName(2), 'Link');
  assert.equal(activityTypeName(4), 'Quiz');
  assert.equal(activityTypeName(7), 'LTI');
  assert.equal(activityTypeName(22), 'Scorm');
  assert.equal(activityTypeName(-1), 'Unknown');
  assert.equal(activityTypeName(999), 'Unknown');
  assert.equal(activityTypeName('1'), 'Unknown');
  assert.equal(topicTypeName(1), 'File');
  assert.equal(topicTypeName(3), 'Link');
  assert.equal(topicTypeName(6), 'Scorm');
  assert.equal(topicTypeName(null), 'Unknown');
});

test('flattenToc: one row per topic in document order with the module path and depth', () => {
  const rows = flattenToc(TOC, OU, BASE);
  assert.deepEqual(
    rows.map((r) => r.id),
    [4000003, 4000001, 4000002, 4000004],
  );
  assert.deepEqual(rows[1], {
    id: 4000001,
    courseId: OU,
    kind: 'content',
    moduleId: 3000002,
    depth: 2,
    path: 'Week 1: Foundations / Lectures',
    title: 'Lecture 1 slides',
    activityType: 'File',
    activityTypeId: 1,
    toolId: null,
    toolItemId: null,
    url: `${BASE}/content/enforced/412690-CS180/lecture01.pdf`,
    dueDate: null,
    startDate: null,
    endDate: null,
    isHidden: false,
    isLocked: false,
    isExempt: false,
    isBroken: false,
    gradeItemId: null,
  });
  const quiz = rows[0];
  assert.equal(quiz?.moduleId, 3000001);
  assert.equal(quiz?.depth, 1);
  assert.equal(quiz?.path, 'Week 1: Foundations');
  assert.equal(quiz?.activityType, 'Quiz');
  assert.equal(quiz?.toolId, 6);
  assert.equal(quiz?.toolItemId, 790340);
  assert.equal(quiz?.gradeItemId, 55001);
  assert.equal(quiz?.startDate, '2026-08-24T04:00:00Z', 'whole-second variant');
  assert.equal(quiz?.endDate, '2026-12-20T04:59:00Z', 'millisecond variant');
  assert.equal(quiz?.url, `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=790340&ou=${OU}`);
  const link = rows[2];
  assert.equal(link?.url, 'https://mediaspace.example.edu/media/lecture01', 'absolute Url kept');
  assert.equal(link?.isHidden, true);
  assert.equal(link?.isExempt, true);
  assert.equal(link?.endDate, null, 'unreadable date is null, never fatal');
  const lti = rows[3];
  assert.equal(lti?.activityType, 'LTI');
  assert.equal(lti?.toolId, 390000);
  assert.equal(lti?.isBroken, true);
  assert.equal(lti?.path, 'Gradescope');
});

test('tocTree: nested modules keep parentId/depth and carry their topics and child modules', () => {
  const tree = tocTree(TOC, OU, BASE);
  assert.equal(tree.length, 2);
  const week1 = tree[0];
  assert.equal(week1?.id, 3000001);
  assert.equal(week1?.kind, 'module');
  assert.equal(week1?.parentId, null);
  assert.equal(week1?.depth, 0);
  assert.equal(week1?.title, 'Week 1: Foundations');
  assert.equal(week1?.startDate, '2026-08-24T04:00:00Z');
  assert.equal(week1?.endDate, null);
  assert.equal(week1?.isHidden, false);
  assert.equal(week1?.isLocked, false);
  assert.equal(week1?.lastModified, '2026-08-20T15:04:05Z');
  assert.deepEqual(
    week1?.topics.map((t) => t.id),
    [4000003],
  );
  const lectures = week1?.modules[0];
  assert.equal(lectures?.id, 3000002);
  assert.equal(lectures?.parentId, 3000001);
  assert.equal(lectures?.depth, 1);
  assert.deepEqual(
    lectures?.topics.map((t) => t.id),
    [4000001, 4000002],
  );
  assert.deepEqual(lectures?.modules, []);
  const gradescope = tree[1];
  assert.equal(gradescope?.startDate, null, 'unreadable module date is null');
  assert.equal(gradescope?.isLocked, true);
  assert.equal(gradescope?.courseId, OU);
});

test('flattenToc/tocTree: an empty TOC and undecodable shapes yield nothing', () => {
  assert.deepEqual(flattenToc(EMPTY, OU, BASE), []);
  assert.deepEqual(tocTree(EMPTY, OU, BASE), []);
  assert.deepEqual(flattenToc(null, OU, BASE), []);
  assert.deepEqual(flattenToc([], OU, BASE), []);
  assert.deepEqual(flattenToc({ Modules: [{ Title: 'no id' }] }, OU, BASE), []);
  // Topics without a numeric TopicId are skipped; the module still shows in the tree.
  const rows = flattenToc({ Modules: [{ ModuleId: 1, Topics: [{ Title: 'x' }] }] }, OU, BASE);
  assert.deepEqual(rows, []);
  assert.equal(tocTree({ Modules: [{ ModuleId: 1 }] }, OU, BASE).length, 1);
});

test('topicDetailOf: reads every documented value; description text and html; url absolutised', () => {
  assert.deepEqual(topicDetailOf(TOPIC, OU, BASE), {
    id: 4000001,
    courseId: OU,
    kind: 'content',
    moduleId: 3000002,
    path: null,
    title: 'Lecture 1 slides',
    activityType: 'File',
    activityTypeId: 1,
    topicType: 'File',
    topicTypeId: 1,
    toolId: null,
    toolItemId: null,
    url: `${BASE}/content/enforced/412690-CS180/lecture01.pdf`,
    dueDate: '2026-09-15T23:59:00Z',
    startDate: '2026-08-24T04:00:00Z',
    endDate: null,
    isHidden: false,
    isLocked: false,
    isExempt: false,
    isBroken: false,
    gradeItemId: null,
    associatedGradeItemIds: [],
    openAsExternalResource: false,
    description: 'Slides for lecture 1. Read before Friday.',
    descriptionHtml: '<p>Slides for lecture 1. <strong>Read before Friday.</strong></p>',
    activityId: null,
    duration: 30,
    lastModified: '2026-08-20T15:04:05Z',
  });
  const link = topicDetailOf(LINK, OU, BASE);
  assert.equal(link?.topicType, 'Link');
  assert.equal(link?.openAsExternalResource, true);
  assert.equal(link?.description, null);
  assert.equal(link?.url, 'https://mediaspace.example.edu/media/lecture01');
  assert.equal(link?.dueDate, null);
  assert.equal(topicDetailOf({ Title: 'no id' }, OU, BASE), null);
  assert.equal(topicDetailOf({ Id: '4000001' }, OU, BASE), null);
  assert.equal(topicDetailOf(null, OU, BASE), null);
  const sparse = topicDetailOf({ Id: 5 }, OU, BASE);
  assert.equal(sparse?.title, '');
  assert.equal(sparse?.url, null);
  assert.equal(sparse?.activityType, 'Unknown');
  assert.equal(sparse?.moduleId, null);
});

test('moduleChildOf: Type 0 is a module summary, Type 1 a topic detail', () => {
  const [mod, topic] = STRUCTURE.map((o) => moduleChildOf(o, OU, BASE));
  assert.deepEqual(mod, {
    id: 3000002,
    courseId: OU,
    kind: 'module',
    parentId: 3000001,
    title: 'Lectures',
    description: 'Weekly lecture material.',
    descriptionHtml: '<p>Weekly lecture material.</p>',
    dueDate: '2026-09-05T03:59:00Z',
    startDate: null,
    endDate: null,
    isHidden: false,
    isLocked: false,
    lastModified: '2026-08-20T15:04:05Z',
  });
  assert.equal(topic?.kind, 'content');
  if (topic?.kind !== 'content') assert.fail('expected a topic');
  assert.equal(topic.id, 4000003);
  assert.equal(topic.moduleId, 3000001);
  assert.equal(topic.dueDate, '2026-08-30T03:59:00Z');
  assert.deepEqual(topic.associatedGradeItemIds, [55001]);
  assert.equal(moduleChildOf({ Type: 2, Id: 1 }, OU, BASE), null);
  assert.equal(moduleChildOf({ Type: 0 }, OU, BASE), null);
  assert.equal(moduleChildOf('x', OU, BASE), null);
});

test('filenameFromContentDisposition: RFC 5987 filename* wins, then quoted, then bare', () => {
  assert.equal(
    filenameFromContentDisposition(
      'attachment; filename="lecture01.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf',
    ),
    'résumé.pdf',
  );
  assert.equal(
    filenameFromContentDisposition('attachment; filename="lecture 01.pdf"'),
    'lecture 01.pdf',
  );
  assert.equal(filenameFromContentDisposition('inline; filename=notes.txt'), 'notes.txt');
  assert.equal(filenameFromContentDisposition("attachment; filename*=utf-8''%ZZbad"), null);
  assert.equal(filenameFromContentDisposition('attachment'), null);
  assert.equal(filenameFromContentDisposition(undefined), null);
});

test('safeFileName: basename only, no control or reserved characters, fallback when empty', () => {
  assert.equal(safeFileName('../../etc/passwd', 'topic-1'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\x\\slides.pdf', 'topic-1'), 'slides.pdf');
  assert.equal(safeFileName('  .hidden  ', 'topic-1'), 'hidden');
  assert.equal(safeFileName('a<b>c:d"e|f?g*h\u0000.pdf', 'topic-1'), 'abcdefgh.pdf');
  assert.equal(safeFileName('', 'topic-1'), 'topic-1');
  assert.equal(safeFileName('...', 'topic-1'), 'topic-1');
  assert.equal(safeFileName('Lecture 1: slides / notes', 'topic-1'), 'notes');
  const long = safeFileName(`${'x'.repeat(300)}.pdf`, 'topic-1');
  assert.ok(long.length <= 200, `${long.length} chars`);
  assert.ok(long.endsWith('.pdf'));
});
