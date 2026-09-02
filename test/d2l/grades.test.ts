import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  finalGradeOf,
  gradeObjectsUrl,
  gradeOf,
  gradeTypeOf,
  gradeValueOf,
  joinGrades,
  myFinalGradeUrl,
  myGradeValuesUrl,
} from '../../src/d2l/grades.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };
const OU = 1498777;

const FIXTURES = new URL('../fixtures/', import.meta.url);
const OBJECTS: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL('grade-objects-doc-shaped.json', FIXTURES), 'utf8'),
);
const VALUES: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL('my-grade-values-doc-shaped.json', FIXTURES), 'utf8'),
);
const FINAL: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('final-grade-value-doc-shaped.json', FIXTURES), 'utf8'),
);
const GRADEBOOK = `${BASE}/d2l/lms/grades/my_grades/main.d2l?ou=${OU}`;

test('grade routes: collections end with "/", the single item does not; LE version from config', () => {
  assert.equal(gradeObjectsUrl(CFG, OU), `${BASE}/d2l/api/le/1.96/${OU}/grades/`);
  assert.equal(
    myGradeValuesUrl(CFG, OU),
    `${BASE}/d2l/api/le/1.96/${OU}/grades/values/myGradeValues/`,
  );
  assert.equal(
    myFinalGradeUrl({ ...CFG, leVersion: '1.80' }, OU),
    `${BASE}/d2l/api/le/1.80/${OU}/grades/final/values/myGradeValue`,
  );
});

test('gradeTypeOf: GRADEOBJ_T 1..9 map to names; docs strings normalise; unknown values pass or null', () => {
  assert.equal(gradeTypeOf(1), 'numeric');
  assert.equal(gradeTypeOf(2), 'passFail');
  assert.equal(gradeTypeOf(3), 'selectBox');
  assert.equal(gradeTypeOf(4), 'text');
  assert.equal(gradeTypeOf(5), 'calculated');
  assert.equal(gradeTypeOf(6), 'formula');
  assert.equal(gradeTypeOf(7), 'finalCalculated');
  assert.equal(gradeTypeOf(8), 'finalAdjusted');
  assert.equal(gradeTypeOf(9), 'category');
  assert.equal(gradeTypeOf('Numeric'), 'numeric');
  assert.equal(gradeTypeOf('PassFail'), 'passFail');
  assert.equal(gradeTypeOf('SelectBox'), 'selectBox');
  assert.equal(gradeTypeOf('FinalAdjusted'), 'finalAdjusted');
  assert.equal(gradeTypeOf('Scheme'), 'Scheme', 'an undocumented string passes through');
  assert.equal(gradeTypeOf(42), '42', 'an undocumented number is kept as its text');
  assert.equal(gradeTypeOf(null), null);
  assert.equal(gradeTypeOf(undefined), null);
});

test('gradeValueOf: reads every documented field; dates whole-second; released from ReleasedDate; empty comments null', () => {
  assert.deepEqual(gradeValueOf(VALUES[0]), {
    displayed: '9 / 10',
    numerator: 9,
    denominator: 10,
    weightedNumerator: 4.5,
    weightedDenominator: 5,
    lastModified: '2026-02-10T15:04:05Z',
    released: true,
    releasedDate: '2026-02-11T00:00:00Z',
    comments: 'Nice work; see the rubric for the missing point.',
  });
  const passFail = gradeValueOf(VALUES[1]);
  assert.equal(passFail?.released, false, 'ReleasedDate null');
  assert.equal(passFail?.releasedDate, null);
  assert.equal(passFail?.lastModified, '2026-03-01T04:59:00Z', 'second-precision input survives');
  assert.equal(passFail?.comments, null);
  const text = gradeValueOf(VALUES[2]);
  assert.equal(text?.displayed, 'Good progress');
  assert.equal(text?.numerator, null, 'Text values carry no computable fields');
  assert.equal(text?.denominator, null);
  assert.equal(text?.weightedNumerator, null);
  assert.equal(text?.weightedDenominator, null);
  assert.equal(gradeValueOf(null), null);
  assert.equal(gradeValueOf('nope'), null);
  assert.equal(gradeValueOf([]), null);
});

test('gradeOf: the object with its joined value; type from GradeObjectTypeId, else GradeType; url is the gradebook', () => {
  assert.deepEqual(gradeOf(OBJECTS[0], VALUES[0], BASE, OU), {
    id: 1001,
    name: 'Homework 1',
    shortName: 'HW1',
    type: 'numeric',
    maxPoints: 10,
    weight: 5,
    isBonus: false,
    associatedTool: { toolId: 6, toolItemId: 440703 },
    myValue: gradeValueOf(VALUES[0]),
    url: GRADEBOOK,
  });
  const midterm = gradeOf(OBJECTS[1], null, BASE, OU);
  assert.equal(midterm?.myValue, null);
  assert.deepEqual(midterm?.associatedTool, { toolId: 19, toolItemId: 55501 });
  const bonus = gradeOf(OBJECTS[3], null, BASE, OU);
  assert.equal(bonus?.isBonus, true);
  assert.equal(bonus?.associatedTool, null);
  const category = gradeOf(OBJECTS[5], null, BASE, OU);
  assert.equal(category?.type, 'category', 'type 9 tolerated');
  assert.equal(category?.maxPoints, null);
  assert.equal(category?.shortName, null, 'empty ShortName reads as none');
  const docsOnly = gradeOf(
    { Id: 7, Name: 'Docs shaped', GradeType: 'SelectBox', MaxPoints: 3, Weight: 1 },
    null,
    BASE,
    OU,
  );
  assert.equal(docsOnly?.type, 'selectBox', 'GradeType string when no GradeObjectTypeId');
  assert.equal(gradeOf({ Name: 'no id' }, null, BASE, OU), null);
  assert.equal(gradeOf(null, null, BASE, OU), null);
});

test('joinGrades: left join on Id == Number(GradeObjectIdentifier); unmatched objects get null; orphan values become rows', () => {
  const skipped: unknown[] = [];
  const rows = joinGrades(OBJECTS, VALUES, BASE, OU, (item) => skipped.push(item));
  assert.deepEqual(
    rows.map((r) => [r.id, r.myValue?.displayed ?? null]),
    [
      [1001, '9 / 10'],
      [1002, null],
      [1003, 'Pass'],
      [1004, null],
      [1006, 'Good progress'],
      [1010, null],
      [1005, null],
      [9999, '42 / 50'],
    ],
  );
  const orphan = rows[7];
  assert.deepEqual(orphan, {
    id: 9999,
    name: 'Hidden lab (value without an object)',
    shortName: null,
    type: 'numeric',
    maxPoints: null,
    weight: null,
    isBonus: false,
    associatedTool: null,
    myValue: gradeValueOf(VALUES[3]),
    url: GRADEBOOK,
  });
  assert.deepEqual(skipped, []);
});

test('joinGrades: values 404 (empty) gives every object a null value; objects missing gives rows from values only', () => {
  const noValues = joinGrades(OBJECTS, [], BASE, OU);
  assert.equal(noValues.length, OBJECTS.length);
  assert.ok(noValues.every((r) => r.myValue === null));

  const valuesOnly = joinGrades(null, VALUES, BASE, OU);
  assert.deepEqual(
    valuesOnly.map((r) => r.id),
    [1001, 1003, 1006, 9999],
  );
  assert.equal(valuesOnly[0]?.name, 'Homework 1', 'name comes from GradeObjectName');
  assert.equal(valuesOnly[0]?.maxPoints, null, 'costs the object-only fields');
  assert.equal(valuesOnly[1]?.type, 'passFail', 'type from GradeObjectType');
});

test('joinGrades: undecodable objects and values are reported, never thrown', () => {
  const skipped: unknown[] = [];
  const rows = joinGrades(
    [OBJECTS[0], { Name: 'no id' }, 'junk'],
    [VALUES[0], { DisplayedGrade: 'no identifier' }, 5],
    BASE,
    OU,
    (item) => skipped.push(item),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 1001);
  assert.equal(skipped.length, 4);
});

test('finalGradeOf: the released final grade, or the released:false shape when the route said 404', () => {
  assert.deepEqual(finalGradeOf(FINAL, BASE, OU), {
    courseId: OU,
    released: true,
    id: 1005,
    name: 'Final Calculated Grade',
    type: 'finalCalculated',
    displayed: '87.5 %',
    numerator: 87.5,
    denominator: 100,
    weightedNumerator: 87.5,
    weightedDenominator: 100,
    lastModified: '2026-05-20T18:30:00Z',
    releasedDate: '2026-05-20T18:30:00Z',
    comments: 'Strong finish.',
    url: GRADEBOOK,
  });
  assert.deepEqual(finalGradeOf(null, BASE, OU), {
    courseId: OU,
    released: false,
    id: null,
    name: null,
    type: null,
    displayed: null,
    numerator: null,
    denominator: null,
    weightedNumerator: null,
    weightedDenominator: null,
    lastModified: null,
    releasedDate: null,
    comments: null,
    url: GRADEBOOK,
  });
  const adjusted = finalGradeOf(
    { ...FINAL, GradeObjectType: 8, GradeObjectIdentifier: '77' },
    BASE,
    OU,
  );
  assert.equal(adjusted.type, 'finalAdjusted');
  assert.equal(adjusted.id, 77);
  assert.equal(finalGradeOf('junk', BASE, OU).released, false, 'an unreadable body is no grade');
});
