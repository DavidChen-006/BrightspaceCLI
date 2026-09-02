import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  attemptOf,
  quizAttemptsUrl,
  quizDetailOf,
  quizItemUrl,
  quizOf,
  quizzesUrl,
} from '../../src/d2l/quizzes.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const LIST = fixture<{ Objects: Record<string, unknown>[]; Next: null }>('quizzes-412690.json');
const DATED = fixture<{ Objects: Record<string, unknown>[] }>('quizzes-with-due-date.json');
const DETAIL = fixture<Record<string, unknown>>('quiz-790340-doc-shaped.json');
const ATTEMPTS = fixture<{ Objects: Record<string, unknown>[] }>('quiz-attempts-doc-shaped.json');

test('quiz routes: collection ends with "/", single items do not; LE version from config', () => {
  assert.equal(quizzesUrl(CFG, 412690), `${BASE}/d2l/api/le/1.96/412690/quizzes/`);
  assert.equal(quizItemUrl(CFG, 412690, 619243), `${BASE}/d2l/api/le/1.96/412690/quizzes/619243`);
  assert.equal(
    quizAttemptsUrl(CFG, 412690, 619243, 123456),
    `${BASE}/d2l/api/le/1.96/412690/quizzes/619243/attempts/?userId=123456`,
  );
  assert.equal(quizzesUrl({ ...CFG, leVersion: '1.80' }, 7), `${BASE}/d2l/api/le/1.80/7/quizzes/`);
  assert.equal(
    quizAttemptsUrl(CFG, 7, 8, 'guid-like'),
    `${BASE}/d2l/api/le/1.96/7/quizzes/8/attempts/?userId=guid-like`,
  );
});

test('quizOf: reads every value, computes only url, normalises dates', () => {
  const [pledge, practice, welcome] = LIST.Objects;
  assert.deepEqual(quizOf(pledge, 412690, BASE), {
    id: 619243,
    courseId: 412690,
    kind: 'quiz',
    title: 'Honor Pledge',
    dueDate: null,
    startDate: null,
    endDate: null,
    url: `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=619243&ou=412690`,
    gradeItemId: null,
    isActive: true,
    attemptsAllowed: 1,
    unlimitedAttempts: false,
    timeLimit: null,
    timeLimitEnforced: false,
  });
  const unlimited = quizOf(practice, 412690, BASE);
  assert.equal(unlimited?.attemptsAllowed, null);
  assert.equal(unlimited?.unlimitedAttempts, true);
  const timed = quizOf(welcome, 412690, BASE);
  assert.equal(timed?.attemptsAllowed, 3);
  assert.equal(timed?.timeLimit, 30);
  assert.equal(timed?.timeLimitEnforced, true);

  const [midterm, final, broken] = DATED.Objects.map((q) => quizOf(q, 1, BASE));
  assert.equal(midterm?.dueDate, '2026-03-01T04:59:00Z', 'millisecond variant');
  assert.equal(final?.dueDate, '2026-09-15T23:59:00Z', 'whole-second variant');
  assert.equal(broken?.dueDate, null, 'unreadable date is null, never fatal');
  assert.equal(broken?.id, 900103);
});

test('quizOf: a bare array (the dropbox shape) and anything without a numeric QuizId is undecodable', () => {
  assert.equal(quizOf(fixture('quizzes-bare-array.json'), 412690, BASE), null);
  assert.equal(quizOf(fixture('quizzes-malformed.json'), 412690, BASE), null);
  assert.equal(quizOf({ Name: 'no id' }, 412690, BASE), null);
  assert.equal(quizOf({ QuizId: '619243' }, 412690, BASE), null);
  assert.equal(quizOf(null, 412690, BASE), null);
  const sparse = quizOf({ QuizId: 5 }, 9, BASE);
  assert.deepEqual(sparse, {
    id: 5,
    courseId: 9,
    kind: 'quiz',
    title: '',
    dueDate: null,
    startDate: null,
    endDate: null,
    url: `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=5&ou=9`,
    gradeItemId: null,
    isActive: false,
    attemptsAllowed: null,
    unlimitedAttempts: false,
    timeLimit: null,
    timeLimitEnforced: false,
  });
});

test('quizDetailOf: nested {Text:{Text,Html},IsDisplayed} rich text, late-submission info, activity id', () => {
  const detail = quizDetailOf(DETAIL, 412690, BASE);
  assert.ok(detail);
  assert.equal(detail.id, 790340);
  assert.equal(detail.title, 'Welcome Quiz');
  assert.equal(detail.dueDate, '2026-09-15T23:59:00Z');
  assert.equal(detail.startDate, '2026-08-24T04:00:00Z');
  assert.equal(detail.endDate, '2026-12-20T04:59:00Z');
  assert.equal(detail.gradeItemId, 55123);
  assert.equal(detail.attemptsAllowed, 3);
  assert.equal(detail.timeLimit, 30);
  assert.equal(detail.description, 'A short warm-up.');
  assert.equal(detail.descriptionHtml, '<p>A short warm-up.</p>');
  assert.equal(detail.instructions, 'Answer every question. You have 30 minutes.');
  assert.equal(detail.lateSubmissionOption, 1);
  assert.equal(detail.lateLimitMinutes, 15);
  assert.equal(detail.activityId, DETAIL.ActivityId);
  assert.equal(detail.url, `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=790340&ou=412690`);
});

test('quizDetailOf: flat {Text,Html} rich text (the recorded list shape) and nulls also decode', () => {
  const welcome = LIST.Objects[2];
  const detail = quizDetailOf(welcome, 412690, BASE);
  assert.ok(detail);
  assert.equal(detail.description, 'A short warm-up.');
  assert.equal(detail.descriptionHtml, '<p>A short warm-up.</p>');
  assert.equal(detail.instructions, null);
  assert.equal(detail.lateSubmissionOption, null);
  assert.equal(detail.lateLimitMinutes, null);

  const pledge = quizDetailOf(LIST.Objects[0], 412690, BASE);
  assert.equal(pledge?.description, null);
  assert.equal(pledge?.descriptionHtml, null);
  assert.equal(quizDetailOf(fixture('quizzes-bare-array.json'), 412690, BASE), null);
});

test('attemptOf: reads the QuizAttemptData fields; UserId string becomes a number; feedback text only', () => {
  const [first, second] = ATTEMPTS.Objects;
  assert.deepEqual(attemptOf(first, 412690, BASE), {
    id: 3105001,
    quizId: 790340,
    courseId: 412690,
    userId: 123456,
    attemptNumber: 1,
    score: 7.5,
    started: '2026-08-25T14:02:11Z',
    completed: '2026-08-25T14:21:40Z',
    dueDate: '2026-09-15T23:59:00Z',
    isPublished: true,
    feedback: 'Nice work.',
    url: `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=790340&ou=412690`,
  });
  const open = attemptOf(second, 412690, BASE);
  assert.equal(open?.id, 3105002);
  assert.equal(open?.score, null);
  assert.equal(open?.completed, null);
  assert.equal(open?.feedback, null);
  assert.equal(open?.isPublished, false);
  assert.equal(attemptOf({ QuizId: 1 }, 412690, BASE), null);
  assert.equal(attemptOf([], 412690, BASE), null);
});
