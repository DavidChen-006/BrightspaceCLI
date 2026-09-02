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
