import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assignmentDetailOf,
  assignmentOf,
  attachmentUrl,
  contentDispositionFilename,
  foldersUrl,
  folderUrl,
  mySubmissionsUrl,
  safeFileName,
  submissionFileUrl,
  submissionOf,
} from '../../src/d2l/assignments.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };
const OU = 440703;

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const REAL: unknown[] = fixture('dropbox-folders-440703.json');
const DUE: unknown[] = fixture('dropbox-folders-with-due-date.json');
const LINKED: unknown[] = fixture('dropbox-folders-with-link-attachment.json');
const FOLDER = fixture<Record<string, unknown>>('dropbox-folder-doc-shaped.json');
const MINE: unknown[] = fixture('dropbox-mysubmissions-doc-shaped.json');

test('dropbox routes: collections end with "/", single items do not; LE version from config', () => {
  assert.equal(foldersUrl(CFG, OU), `${BASE}/d2l/api/le/1.96/440703/dropbox/folders/`);
  assert.equal(folderUrl(CFG, OU, 445296), `${BASE}/d2l/api/le/1.96/440703/dropbox/folders/445296`);
  assert.equal(
    mySubmissionsUrl(CFG, OU, 445296),
    `${BASE}/d2l/api/le/1.96/440703/dropbox/folders/445296/submissions/mysubmissions/`,
  );
  assert.equal(
    attachmentUrl(CFG, OU, 445296, 90001),
    `${BASE}/d2l/api/le/1.96/440703/dropbox/folders/445296/attachments/90001`,
  );
  assert.equal(
    submissionFileUrl(CFG, OU, 445296, 31001, 41001),
    `${BASE}/d2l/api/le/1.96/440703/dropbox/folders/445296/submissions/31001/files/41001`,
  );
  assert.equal(
    foldersUrl({ ...CFG, leVersion: '1.98' }, 7),
    `${BASE}/d2l/api/le/1.98/7/dropbox/folders/`,
  );
});

test('assignmentOf: the real folder maps onto the PRD Item shape; only url is computed', () => {
  assert.deepEqual(assignmentOf(REAL[0], OU, BASE), {
    id: 445296,
    courseId: 440703,
    kind: 'assignment',
    title: 'Upload your CITI Certificate to Complete Module 2',
    dueDate: null,
    startDate: null,
    endDate: null,
    url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=445296&grpid=0&ou=440703`,
    gradeItemId: null,
  });
  assert.deepEqual(
    REAL.map((f) => assignmentOf(f, OU, BASE)?.id),
    [445296, 445297, 529524],
  );
});

test('assignmentOf: dates normalise to whole seconds; an unreadable date survives as null', () => {
  const [hw3, group, broken] = DUE.map((f) => assignmentOf(f, 1, BASE));
  assert.equal(hw3?.dueDate, '2026-03-01T04:59:00Z');
  assert.equal(hw3?.gradeItemId, 8801);
  assert.equal(group?.dueDate, '2026-09-15T23:59:00Z');
  assert.equal(group?.gradeItemId, null);
  assert.equal(broken?.id, 700003, 'the item is still decodable');
  assert.equal(broken?.dueDate, null);
});

test('assignmentOf: id and name are fatal; anything else unreadable is null', () => {
  assert.equal(assignmentOf({ Name: 'no id' }, OU, BASE), null);
  assert.equal(assignmentOf({ Id: 5 }, OU, BASE), null);
  assert.equal(assignmentOf({ Id: '5', Name: 'string id' }, OU, BASE), null);
  assert.equal(assignmentOf(null, OU, BASE), null);
  assert.equal(assignmentOf([], OU, BASE), null);
  const sparse = assignmentOf(
    { Id: 9, Name: 'Sparse', Availability: { StartDate: 'x' } },
    OU,
    BASE,
  );
  assert.deepEqual(sparse, {
    id: 9,
    courseId: OU,
    kind: 'assignment',
    title: 'Sparse',
    dueDate: null,
    startDate: null,
    endDate: null,
    url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=9&grpid=0&ou=440703`,
    gradeItemId: null,
  });
});

test('assignmentOf never derives url from LinkAttachments (Brightspace-Bar trap)', () => {
  const item = assignmentOf(LINKED[0], OU, BASE);
  assert.ok(item);
  assert.equal(
    item.url,
    `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=445296&grpid=0&ou=440703`,
  );
  assert.equal(item.url.includes('citiprogram'), false);
  const detail = assignmentDetailOf(LINKED[0], OU, BASE);
  assert.ok(detail);
  assert.deepEqual(detail.linkAttachments, [
    {
      linkId: 99001,
      name: 'CITI Program training portal',
      href: 'https://about.citiprogram.org/not-the-assignment-page',
    },
    {
      linkId: 99002,
      name: "Instructor's rubric (external)",
      href: 'https://example.invalid/external/rubric.pdf',
    },
  ]);
  assert.equal(detail.url, item.url);
});

test('assignmentDetailOf: instructions, attachments, availability (int or name enums), decoded enums', () => {
  const d = assignmentDetailOf(FOLDER, 1498777, BASE);
  assert.ok(d);
  assert.deepEqual(d, {
    id: 700001,
    courseId: 1498777,
    kind: 'assignment',
    title: 'Homework 3',
    dueDate: '2026-03-01T04:59:00Z',
    startDate: '2026-02-15T05:00:00Z',
    endDate: '2026-03-08T04:59:00Z',
    url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=700001&grpid=0&ou=1498777`,
    gradeItemId: 8801,
    instructions: {
      text: 'Submit a PDF of your solutions. Show your work.',
      html: '<p>Submit a <strong>PDF</strong> of your solutions. Show your work.</p>',
    },
    attachments: [
      { fileId: 90001, fileName: 'hw3-problems.pdf', size: 184320 },
      { fileId: 90002, fileName: 'starter code.zip', size: 40960 },
    ],
    linkAttachments: [
      { linkId: 99001, name: 'Course style guide', href: 'https://example.invalid/style-guide' },
    ],
    availability: {
      startDate: '2026-02-15T05:00:00Z',
      endDate: '2026-03-08T04:59:00Z',
      startType: 'accessRestricted',
      endType: 'submissionRestricted',
    },
    isHidden: false,
    dropboxType: 'individual',
    submissionType: 'file',
    completionType: 'onSubmission',
    scoreDenominator: 100,
  });
});

test('assignmentDetailOf: the real folder (Availability null, empty instructions) is null-safe', () => {
  const d = assignmentDetailOf(REAL[0], OU, BASE);
  assert.ok(d);
  assert.equal(d.availability, null);
  assert.deepEqual(d.instructions, { text: '', html: '' });
  assert.deepEqual(d.attachments, []);
  assert.deepEqual(d.linkAttachments, []);
  assert.equal(d.scoreDenominator, null);
  assert.equal(d.dropboxType, 'individual');
  assert.equal(assignmentDetailOf({ Name: 'no id' }, OU, BASE), null);
  const odd = assignmentDetailOf(
    { Id: 1, Name: 'x', DropboxType: 'Group', SubmissionType: 'FileOrText', CompletionType: 7 },
    OU,
    BASE,
  );
  assert.equal(odd?.dropboxType, 'group', 'enum names are accepted as well as ints');
  assert.equal(odd?.submissionType, 'fileOrText');
  assert.equal(odd?.completionType, '7', 'an unknown enum value passes through as text');
});

test('submissionOf: the doc-shaped EntityDropbox maps onto the Submission shape', () => {
  assert.deepEqual(submissionOf(MINE[0], OU, 445296, BASE), {
    entityId: 2094411,
    entityType: 'User',
    name: 'Ada Lovelace',
    folderId: 445296,
    courseId: OU,
    status: 'submitted',
    completionDate: '2026-02-28T22:14:05Z',
    feedback: {
      score: 92.5,
      isGraded: true,
      text: 'Nice work; cite the second source next time.',
      html: '<p>Nice work; cite the <em>second</em> source next time.</p>',
      files: [{ fileId: 55001, fileName: 'hw3-annotated.pdf', size: 10240 }],
    },
    submissions: [
      {
        id: 31001,
        submittedBy: { id: 2094411, displayName: 'Ada Lovelace' },
        date: '2026-02-28T22:14:05Z',
        comment: { text: 'Here is my homework.', html: '<p>Here is my homework.</p>' },
        files: [
          { fileId: 41001, fileName: 'hw3.pdf', size: 204800, isRead: true, isFlagged: false },
          { fileId: 41002, fileName: 'code.zip', size: 51200, isRead: false, isFlagged: false },
        ],
      },
      {
        id: 31000,
        submittedBy: { id: 2094411, displayName: 'Ada Lovelace' },
        date: '2026-02-27T19:03:11Z',
        comment: { text: '', html: '' },
        files: [
          { fileId: 40999, fileName: 'hw3-draft.pdf', size: 190000, isRead: true, isFlagged: true },
        ],
      },
    ],
    url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=445296&grpid=0&ou=440703`,
  });
});

test('submissionOf: status accepts int or name; sparse entities decode with nulls; garbage is null', () => {
  assert.equal(submissionOf({ Entity: {}, Status: 'Draft' }, OU, 1, BASE)?.status, 'draft');
  assert.equal(submissionOf({ Entity: {}, Status: 3 }, OU, 1, BASE)?.status, 'published');
  const group = submissionOf(
    { Entity: { EntityId: '77', EntityType: 'Group', Name: 'Team 4' }, Status: 0, Feedback: null },
    OU,
    1,
    BASE,
  );
  assert.deepEqual(group, {
    entityId: 77,
    entityType: 'Group',
    name: 'Team 4',
    folderId: 1,
    courseId: OU,
    status: 'unsubmitted',
    completionDate: null,
    feedback: null,
    submissions: [],
    url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=1&grpid=0&ou=440703`,
  });
  assert.equal(submissionOf(null, OU, 1, BASE), null);
  assert.equal(submissionOf('x', OU, 1, BASE), null);
});

test('contentDispositionFilename: RFC 6266 filename* wins over filename; missing → null', () => {
  assert.equal(contentDispositionFilename('attachment; filename="hw3.pdf"'), 'hw3.pdf');
  assert.equal(contentDispositionFilename('attachment; filename=hw3.pdf'), 'hw3.pdf');
  assert.equal(
    contentDispositionFilename(
      'attachment; filename="x.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf',
    ),
    'résumé.pdf',
  );
  assert.equal(contentDispositionFilename('inline'), null);
  assert.equal(contentDispositionFilename(undefined), null);
});

test('safeFileName: strips directories, control characters and leading dots; falls back', () => {
  assert.equal(safeFileName('hw3.pdf', 'fallback'), 'hw3.pdf');
  assert.equal(safeFileName('../../etc/passwd', 'fallback'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\me\\notes.txt', 'fallback'), 'notes.txt');
  assert.equal(safeFileName('..', 'fallback'), 'fallback');
  assert.equal(safeFileName('.hidden', 'fallback'), 'hidden');
  assert.equal(safeFileName('a\u0000b\nc.txt', 'fallback'), 'abc.txt');
  assert.equal(safeFileName('   ', 'fallback'), 'fallback');
  assert.equal(safeFileName(null, 'file-90001'), 'file-90001');
  assert.equal(safeFileName(`${'x'.repeat(300)}.pdf`, 'f').length, 255);
});
