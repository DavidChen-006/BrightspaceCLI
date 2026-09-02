/**
 * Deep-link templates (PRD 6.3, Brightspace-Bar Extra 1). `base` has no trailing slash.
 * These are the only URLs `bs` derives; everything else is read from the payload.
 */

export function courseHomeUrl(base: string, ou: number): string {
  return `${base}/d2l/home/${ou}`;
}

export function assignmentUrl(base: string, ou: number, folderId: number): string {
  return `${base}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folderId}&grpid=0&ou=${ou}`;
}

export function quizUrl(base: string, ou: number, quizId: number): string {
  return `${base}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${quizId}&ou=${ou}`;
}

export function gradebookUrl(base: string, ou: number): string {
  return `${base}/d2l/lms/grades/my_grades/main.d2l?ou=${ou}`;
}

export function announcementsUrl(base: string, ou: number): string {
  return `${base}/d2l/lms/news/main.d2l?ou=${ou}`;
}

/** D2L discussion tool routes (standard `/d2l/le/{ou}/discussions/...` paths; not yet probed live). */
export function discussionsUrl(base: string, ou: number): string {
  return `${base}/d2l/le/${ou}/discussions/List`;
}

export function discussionTopicUrl(base: string, ou: number, topicId: number): string {
  return `${base}/d2l/le/${ou}/discussions/topics/${topicId}/View`;
}

export function discussionThreadUrl(base: string, ou: number, threadId: number): string {
  return `${base}/d2l/le/${ou}/discussions/threads/${threadId}/View`;
}

/** The course calendar; an event's own `CalendarEventViewUrl` is preferred when D2L sends one. */
export function calendarUrl(base: string, ou: number): string {
  return `${base}/d2l/le/calendar/${ou}`;
}
