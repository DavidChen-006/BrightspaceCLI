import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DEFAULT_POST_PAGE_SIZE,
  forumOf,
  forumsUrl,
  MAX_POST_PAGE_SIZE,
  postOf,
  postsUrl,
  topicOf,
  topicsUrl,
} from '../../src/d2l/discussions.js';
import {
  calendarUrl,
  discussionsUrl,
  discussionThreadUrl,
  discussionTopicUrl,
} from '../../src/d2l/links.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };
const OU = 412690;

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const FORUMS = fixture<Record<string, unknown>[]>('discussion-forums-doc-shaped.json');
const TOPICS = fixture<Record<string, unknown>[]>('discussion-topics-12001-doc-shaped.json');
const POSTS = fixture<Record<string, unknown>[]>('discussion-posts-doc-shaped.json');

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test('discussion routes: collections end with "/", LE version from config, posts sort and threadsOnly', () => {
  assert.equal(forumsUrl(CFG, OU), `${BASE}/d2l/api/le/1.96/${OU}/discussions/forums/`);
  assert.equal(
    topicsUrl(CFG, OU, 12001),
    `${BASE}/d2l/api/le/1.96/${OU}/discussions/forums/12001/topics/`,
  );
  const posts = postsUrl(CFG, OU, 12001, 31001);
  assert.ok(
    posts.startsWith(`${BASE}/d2l/api/le/1.96/${OU}/discussions/forums/12001/topics/31001/posts/?`),
    posts,
  );
  assert.equal(query(posts).get('sort'), '-creationdate');
  assert.equal(query(posts).has('threadsOnly'), false);
  assert.equal(query(posts).has('pageSize'), false, 'paging params come from pageNumbered');
  assert.equal(
    query(postsUrl(CFG, OU, 12001, 31001, { threadsOnly: true })).get('threadsOnly'),
    'true',
  );
  assert.equal(
    forumsUrl({ ...CFG, leVersion: '1.80' }, 7),
    `${BASE}/d2l/api/le/1.80/7/discussions/forums/`,
  );
  assert.equal(DEFAULT_POST_PAGE_SIZE, 100);
  assert.equal(MAX_POST_PAGE_SIZE, 1000);
});

test('deep links: discussions list, topic view, thread view, calendar', () => {
  assert.equal(discussionsUrl(BASE, OU), `${BASE}/d2l/le/${OU}/discussions/List`);
  assert.equal(
    discussionTopicUrl(BASE, OU, 31001),
    `${BASE}/d2l/le/${OU}/discussions/topics/31001/View`,
  );
  assert.equal(
    discussionThreadUrl(BASE, OU, 51001),
    `${BASE}/d2l/le/${OU}/discussions/threads/51001/View`,
  );
  assert.equal(calendarUrl(BASE, OU), `${BASE}/d2l/le/calendar/${OU}`);
});

test('forumOf: reads every value, computes only url, normalises dates', () => {
  const [weekly, qa] = FORUMS;
  assert.deepEqual(forumOf(weekly, OU, BASE), {
    id: 12001,
    courseId: OU,
    name: 'Weekly Discussions',
    description: 'One thread per week. Reply to two classmates.',
    descriptionHtml: '<p>One thread per week. Reply to two classmates.</p>',
    startDate: '2026-08-24T04:00:00Z',
    endDate: null,
    postStartDate: null,
    postEndDate: null,
    isLocked: false,
    isHidden: false,
    requiresApproval: false,
    allowAnonymous: false,
    url: `${BASE}/d2l/le/${OU}/discussions/List`,
  });
  const second = forumOf(qa, OU, BASE);
  assert.equal(second?.endDate, '2026-12-20T04:59:00Z', 'whole-second variant');
  assert.equal(second?.postStartDate, '2026-08-24T04:00:00Z');
  assert.equal(second?.requiresApproval, true);
  assert.equal(second?.allowAnonymous, true);
  assert.equal(second?.description, '');
});

test('forumOf: anything without a numeric ForumId is undecodable; sparse objects decode to defaults', () => {
  assert.equal(forumOf({ Name: 'no id' }, OU, BASE), null);
  assert.equal(forumOf({ ForumId: '12001' }, OU, BASE), null);
  assert.equal(forumOf(null, OU, BASE), null);
  assert.equal(forumOf(FORUMS, OU, BASE), null, 'the whole array is not a forum');
  assert.deepEqual(forumOf({ ForumId: 5 }, 9, BASE), {
    id: 5,
    courseId: 9,
    name: '',
    description: null,
    descriptionHtml: null,
    startDate: null,
    endDate: null,
    postStartDate: null,
    postEndDate: null,
    isLocked: false,
    isHidden: false,
    requiresApproval: false,
    allowAnonymous: false,
    url: `${BASE}/d2l/le/9/discussions/List`,
  });
});

test('topicOf: PRD 6.3 Discussion topic shape; ForumId read from the payload; dates normalised', () => {
  const [intro, reading, open] = TOPICS;
  assert.deepEqual(topicOf(intro, OU, BASE), {
    id: 31001,
    forumId: 12001,
    courseId: OU,
    name: 'Week 1: Introductions',
    description: 'Tell us who you are.',
    descriptionHtml: '<p>Tell us who you are.</p>',
    dueDate: '2026-09-01T03:59:00Z',
    startDate: '2026-08-24T04:00:00Z',
    endDate: null,
    scoreOutOf: 10,
    scoringType: 'Average',
    requiresApproval: false,
    isLocked: false,
    isHidden: false,
    url: `${BASE}/d2l/le/${OU}/discussions/topics/31001/View`,
  });
  const second = topicOf(reading, OU, BASE);
  assert.equal(second?.dueDate, '2026-09-08T03:59:00Z', 'whole-second variant');
  assert.equal(second?.endDate, '2026-09-15T03:59:00Z');
  assert.equal(second?.scoreOutOf, 5);
  assert.equal(second?.scoringType, 'Sum');
  assert.equal(second?.requiresApproval, true);
  const third = topicOf(open, OU, BASE);
  assert.equal(third?.dueDate, null, 'unreadable date is null, never fatal');
  assert.equal(third?.scoreOutOf, null);
  assert.equal(third?.isLocked, true);
  assert.equal(third?.isHidden, true);
});

test('topicOf: no numeric TopicId → null; a missing ForumId falls back to the caller-supplied forum', () => {
  assert.equal(topicOf({ Name: 'no id' }, OU, BASE), null);
  assert.equal(topicOf({ TopicId: '31001' }, OU, BASE), null);
  assert.equal(topicOf(null, OU, BASE), null);
  const sparse = topicOf({ TopicId: 5 }, 9, BASE, 77);
  assert.equal(sparse?.forumId, 77);
  assert.equal(sparse?.name, '');
  assert.equal(sparse?.scoringType, null);
  assert.equal(topicOf({ TopicId: 5 }, 9, BASE)?.forumId, null);
});

test('postOf: PRD 6.3 post shape; author from PostingUserDisplayName; D2LID strings become numbers', () => {
  const [reply, anonymous, thread] = POSTS;
  assert.deepEqual(postOf(thread, OU, BASE), {
    id: 51001,
    topicId: 31001,
    forumId: 12001,
    courseId: OU,
    threadId: 51001,
    parentId: null,
    subject: 'Hello from Grace',
    bodyText: "Hello everyone, I'm Grace.\nSee my photo attached.",
    bodyHtml: "<p>Hello everyone, I'm Grace.</p><p>See my photo attached.</p>",
    author: 'Grace Hopper',
    authorId: 654321,
    date: '2026-08-25T14:02:11Z',
    replies: [51003],
    isRead: true,
    isAnonymous: false,
    isDeleted: false,
    attachments: [{ fileId: 77001, fileName: 'grace.jpg', size: 20480 }],
    url: `${BASE}/d2l/le/${OU}/discussions/threads/51001/View`,
  });
  const r = postOf(reply, OU, BASE);
  assert.equal(r?.parentId, 51001);
  assert.equal(r?.threadId, 51001);
  assert.equal(r?.authorId, 123456);
  assert.deepEqual(r?.replies, []);
  assert.ok(r?.bodyText.includes('<<<EXTERNAL_UNTRUSTED_CONTENT'), 'parsers never sanitise');
  const a = postOf(anonymous, OU, BASE);
  assert.equal(a?.authorId, null);
  assert.equal(a?.author, 'Anonymous');
  assert.equal(a?.isAnonymous, true);
  assert.equal(a?.isRead, false);
  assert.equal(a?.date, '2026-08-25T20:01:00Z');
});

test('postOf: no numeric PostId → null; sparse posts decode to defaults', () => {
  assert.equal(postOf({ Subject: 'no id' }, OU, BASE), null);
  assert.equal(postOf({ PostId: '51001' }, OU, BASE), null);
  assert.equal(postOf(null, OU, BASE), null);
  assert.deepEqual(postOf({ PostId: 5, ReplyPostIds: [1, 'x', 2.5, 3] }, 9, BASE), {
    id: 5,
    topicId: null,
    forumId: null,
    courseId: 9,
    threadId: null,
    parentId: null,
    subject: '',
    bodyText: '',
    bodyHtml: null,
    author: null,
    authorId: null,
    date: null,
    replies: [1, 3],
    isRead: false,
    isAnonymous: false,
    isDeleted: false,
    attachments: [],
    url: `${BASE}/d2l/le/9/discussions/List`,
  });
  const withTopic = postOf({ PostId: 5, TopicId: 31001 }, 9, BASE);
  assert.equal(withTopic?.url, `${BASE}/d2l/le/9/discussions/topics/31001/View`);
});
