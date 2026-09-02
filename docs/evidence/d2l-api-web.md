# Evidence: Brightspace Valence API docs (web research) — 2026-09-02

Produced by a web-research subagent from https://docs.valence.desire2learn.com/
(`/res/*.html`, `/basic/*.html`), quoting the docs' JSON blocks. LP 1.62 and
LE 1.96 are inside the supported window for every route below (LP routes
"1.49+", LE routes "1.82+", unless noted).

## Headline corrections to the draft PRD

1. My submissions route is `…/submissions/mysubmissions/` (not `submissions/mine/`).
2. `content/toc` Topic blocks have **no `DueDate` and no `Description`**; due dates come from `content/topics/(id)` or `content/myItems/due/`.
3. NewsItem attachments use `FileSize` (dropbox/discussion attachments use `Size`). `news/` takes only `since`.
4. There is no `completions/mycompletion`; learner aggregates are the `content/myItems/…` routes.
5. Cross-course calendar route is `GET /d2l/api/le/(v)/calendar/events/myEvents/?orgUnitIdsCSV=&startDateTime=&endDateTime=` → ObjectListPage; `(ou)/calendar/events/` returns a bare array with no date params.
6. `GET /d2l/api/le/(v)/content/myItems/due/?orgUnitIdsCSV=…` returns everything still due across ≤100 courses (content-tool items only) — a cheap first pass for `bs upcoming`.

## A-08 — `GET /d2l/api/lp/(v)/users/whoami` (`/res/user.html#User.WhoAmIUser`)

```
{ "Identifier": <string:D2LID>, "FirstName": <string>, "LastName": <string>,
  "UniqueName": <string>, "ProfileIdentifier": <string>, "Pronouns": <string> }
```
Scopes `users:profile:read` / `users:own_profile:read`; 403 no permission; 404 no user context. `Identifier` is a **string**.

## A-09 — `GET /d2l/api/lp/(v)/enrollments/myenrollments/` (`/res/enroll.html`)

Query: `orgUnitTypeId` (CSV), `bookmark` (string), `sortBy` (keys `EndDate, PinDate, OrgUnitTypeId, OrgUnitName, StartDate`, `-` prefix for desc, repeatable), `isActive` (bool), `startDateTime`/`endDateTime` (UTCDateTime window: matches org units whose start < endDateTime and end > startDateTime; missing dates count as infinite), `canAccess` (bool). No `excludeEnded`; "exclude ended" = `startDateTime=<now>`.

PagedResultSet (`/basic/apicall.html#Api.PagedResultSet`): `{"PagingInfo":{"Bookmark":<string>,"HasMoreItems":<bool>},"Items":[…]}`. Bookmark = the last item's OrgUnit Id; pass it back as `?bookmark=` for the next segment; same `sortBy` must be repeated. Empty set → `Items: []`, `HasMoreItems: false`.

MyOrgUnitInfo: `{OrgUnit{Id:number, Type{Id,Code,Name}, Name, Code|null, HomeUrl|null, ImageUrl|null}, Access{IsActive, StartDate|null, EndDate|null, CanAccess, ClasslistRoleName|null, LISRoles[], LastAccessed|null}, PinDate|null}`.

`orgUnitTypeId` values are tenant data; `GET /d2l/api/lp/(v)/outypes/` lists them. 3 = Course Offering on this tenant (also verifiable via `OrgUnit.Type.Code == "Course Offering"`). Scope `enrollment:own_enrollment:read`.

## A-10 — Course offering (`/res/course.html`)

- `GET /d2l/api/lp/(v)/courses/(ou)` → CourseOffering: `{Identifier:<string>, Name, Code, IsActive, Path, StartDate|null, EndDate|null, LocaleId|null, ForceLocale, CourseTemplate{Identifier,Name,Code}|null, Semester{…}|null, Department{…}|null, Description{Text,Html}, CanSelfRegister, ShowAddressBook}`. Scope `orgunits:course:read`; 403/404. `…/courses/(ou)/image` → file stream.
- `GET /d2l/api/lp/(v)/enrollments/myenrollments/(ou)` → one MyOrgUnitInfo; 404 when not enrolled. Better learner primitive for `bs courses get` (gives role, HomeUrl, CanAccess); combine with `courses/(ou)` for Description/Semester/Department.

## A-11 — `GET /d2l/api/le/(v)/(ou)/dropbox/folders/(folderId)` (`/res/dropbox.html#Dropbox.DropboxFolder`)

```
{ "Id", "CategoryId"|null, "Name", "CustomInstructions": {RichText},
  "Attachments": [{"FileId","FileName","Size"}], "TotalFiles","UnreadFiles","FlaggedFiles",
  "TotalUsers","TotalUsersWithSubmissions","TotalUsersWithFeedback",
  "Availability": null|{"StartDate","EndDate","StartDateAvailabilityType","EndDateAvailabilityType"},
  "GroupTypeId"|null, "DueDate"|null, "DisplayInCalendar", "Assessment": {"ScoreDenominator"|null,"Rubrics":[]},
  "NotificationEmail"|null, "IsHidden", "LinkAttachments": [{"LinkId","LinkName","Href"}],
  "ActivityId"|null, "IsAnonymous", "DropboxType", "SubmissionType", "CompletionType",
  "SubmissionRule" (≥1.98), "GradeItemId"|null, "AllowOnlyUsersWithSpecialAccess"|null }
```
List route `…/dropbox/folders/` → JSON array; optional `onlyCurrentStudentsAndGroups`. Enums: DROPBOXTYPE_T Group=1 Individual=2; SUBMISSIONTYPE_T File=0 Text=1 OnPaper=2 Observed=3 FileOrText=4; COMPLETIONTYPE OnSubmission=0 DueDate=1 ManuallyByLearner=2 OnEvaluation=3; AVAILABILITY_T AccessRestricted=0 SubmissionRestricted=1 Hidden=2 (wire form may be int or name; accept both). `AllowableFileType` is NOT in the documented block (tenant sends it anyway). Scope `dropbox:folders:read`.

## A-12 — My submissions

- `GET /d2l/api/le/(v)/(ou)/dropbox/folders/(folderId)/submissions/mysubmissions/` (LE 1.77+) → JSON array of EntityDropbox: `{Entity{EntityId, EntityType:"User"|"Group", DisplayName|Name}, Status: ENTITYDROPBOXSTATUS_T (Unsubmitted=0, Submitted=1, Draft=2, Published=3), Feedback{Score|null, Feedback{RichText}, RubricAssessments[], IsGraded, Files[{FileId,FileName,Size}], Links[]}, Submissions[{Id, SubmittedBy{Id:string, DisplayName}, SubmissionDate|null, Comment{RichText}, Files[{FileId,FileName,Size,isRead,isFlagged}]}], CompletionDate|null}`. 403/404.
- `GET …/submissions/(submissionId)/files/(fileId)` → file stream.
- `GET …/dropbox/folders/(folderId)/attachments/(fileId)` → file stream (instructor attachment; not for link attachments).

## A-13 — Quizzes (`/res/quiz.html#Quiz.QuizReadData`)

- `GET /d2l/api/le/(v)/(ou)/quizzes/(quizId)` → QuizReadData (fields as the 37-key list; `Instructions`/`Description`/`Header`/`Footer` are `{Text:{Text,Html}, IsDisplayed}`; `AttemptsAllowed{IsUnlimited, NumberOfAttemptsAllowed|null}`; `LateSubmissionInfo{LateSubmissionOption, LateLimitMinutes|null}`; `SubmissionTimeLimit{IsEnforced, ShowClock, TimeLimitValue}`; plus `AnnotationToolsEnabled`). Scope `quizzing:quizzes:read`.
- List `…/quizzes/` → ObjectListPage `{Objects, Next}` (follow `Next` APIURL); returns only quizzes the caller may see.
- `…/quizzes/(quizId)/attempts/?userId=` → ObjectListPage of QuizAttemptData `{AttemptId, QuizId, UserId, AttemptNumber, Score|null, Started, Completed|null, AttemptFeedback, IsPublished, AttemptDueDate|null, …}`; scope `quizzing:attempts:read`; learner access **unknown** (expect 403).

## A-14 — Grades (`/res/grade.html`)

- `GET /d2l/api/le/(v)/(ou)/grades/values/myGradeValues/` → **bare array** of GradeValue; **404 when the user has no grades in the org unit** (map to empty). Scope `grades:own_grades:read`.
- GradeValue: `{DisplayedGrade:<string>, GradeObjectIdentifier:<string>, GradeObjectName, GradeObjectType:<number GRADEOBJ_T>, GradeObjectTypeName|null, Comments{RichText}, PrivateComments{RichText}, LastModified|null, LastModifiedBy:<string>|null, ReleasedDate|null}` + computable (all but Text): `{PointsNumerator|null, PointsDenominator|null, WeightedDenominator|null, WeightedNumerator|null}`.
- `GET …/grades/` → bare array of GradeObject; discriminator is `GradeType` string ("Numeric","PassFail","SelectBox","Text", plus calculated/category rows): `{MaxPoints, CanExceedMaxPoints, IsBonus, ExcludeFromFinalGradeCalculation, GradeSchemeId|null, Id, Name, ShortName, GradeType, CategoryId|null, Description{RichText}, GradeSchemeUrl, Weight, AssociatedTool{ToolId,ToolItemId}|null, IsHidden}`. Scope `grades:gradeobjects:read`.
- GRADEOBJ_T: Numeric=1, PassFail=2, SelectBox=3, Text=4, Calculated=5, Formula=6, FinalCalculated=7, FinalAdjusted=8 (Category=9 not in the table; tenant sends 9 on category rows per Brightspace-Bar).

## A-15 — `GET /d2l/api/le/(v)/(ou)/grades/final/values/myGradeValue` → GradeValue (type 7/8); **404 when no/unreleased final grade** (treat as "none").

## A-16 — News (`/res/news.html#News.NewsItem`)

`GET /d2l/api/le/(v)/(ou)/news/?since=` → bare array: `{Id, IsHidden, Attachments[{FileId, FileName, FileSize}], Title, Body{Text,Html|null}, CreatedBy|null, CreatedDate|null, LastModifiedBy|null, LastModifiedDate|null, StartDate|null, EndDate|null, IsGlobal, IsPublished, ShowOnlyInCourseOfferings, IsAuthorInfoShown, IsPinned, PinnedDate|null, IsStartDateShown, SortOrder}`. `GET …/news/(id)/attachments/(fileId)` → file stream. Scope `news:newsitems:read`.

## A-17 — Content TOC (`/res/content.html#ToC.TableOfContents`)

`GET /d2l/api/le/(v)/(ou)/content/toc?ignoreDateRestrictions=true&moduleId=&title=` → `{Modules:[Module]}`; Module `{ModuleId, Title, SortOrder, StartDateTime|null, EndDateTime|null, Modules[], Topics[], IsHidden, IsLocked, PacingStartDate|null, PacingEndDate|null, DefaultPath, LastModifiedDate|null}`; Topic `{TopicId, Identifier:<string>, TypeIdentifier:<string>, Title, Bookmarked, Unread, Url, SortOrder, StartDateTime|null, EndDateTime|null, ActivityId|null, CompletionType, IsExempt, IsHidden, IsLocked, IsBroken, ToolId|null, ToolItemId|null, ActivityType, GradeItemId|null, LastModifiedDate|null}`. **No DueDate/Description on TOC topics.** `Url` is the link for link topics, or the content-space path for file topics.
CONTENTACTIVITYTYPE_T: Unknown=-1, Module=0, File=1, Link=2, Dropbox=3, Quiz=4, DiscussionForum=5, DiscussionTopic=6, LTI=7, Chat=8, Schedule=9, Checklist=10, SelfAssessment=11, Survey=12, OnlineRoom=13, CourseLink=14, Scorm 20–24, Lor=25, LorScorm=26, LTIAdvantage=27, OrgUnit=28, ActivityInstance=29. CONTENT_COMPLETIONTYPE_T Manual=1 Auto=2 None=3. Scope `content:toc:read`.
`GET …/content/root/` → array of ContentObject Modules; `GET …/content/modules/(moduleId)/structure/` → array of ContentObject (Module `{Structure[], ModuleStartDate, ModuleEndDate, ModuleDueDate, IsHidden, IsLocked, Id, Title, ShortTitle, Color|null, Type:0, Description|null, ParentModuleId|null, Duration|null, LastModifiedDate|null}`). Scope `content:modules:readonly`.

## A-18 — `GET /d2l/api/le/(v)/(ou)/content/topics/(topicId)` → ContentObject Topic

`{TopicType (File=1, Link=3, SCORM 5–8), Url|null, StartDate|null, EndDate|null, DueDate|null, IsHidden, IsLocked, IsBroken, OpenAsExternalResource|null, Id, Title, ShortTitle, Type:1, Description{RichText}|null, ParentModuleId, ActivityId|null, Duration|null, IsExempt, ToolId|null, ToolItemId|null, ActivityType, GradeItemId|null, LastModifiedDate|null, AssociatedGradeItemIds[]}`. 400 if the id is a module. Scope `content:topics:readonly`. Completions: `…/content/topics/(topicId)/completions/users/(userId)` → `{UserId, OrgUnitId, TopicId, CompletionType, CompletionDate|null}` (learner self-access unstated).

## A-19 — `GET /d2l/api/le/(v)/(ou)/content/topics/(topicId)/file?stream=` → file stream

`Content-Disposition` is `attachment` (default) or `inline` (`stream=true`). **400 "Content topic is not a file"** for link/LTI/quiz topics (use the topic `Url`). Scope `content:file:read`. Parse the filename from Content-Disposition, fall back to the topic Title.

## A-20 — Discussions (`/res/discuss.html`)

- `GET …/discussions/forums/` → array of Forum `{ForumId, StartDate|null, EndDate|null, PostStartDate|null, PostEndDate|null, Name, Description{RichText}, ShowDescriptionInTopics|null, AllowAnonymous, IsLocked, IsHidden, RequiresApproval, DisplayInCalendar, DisplayPostDatesInCalendar, StartDateAvailabilityType|null, EndDateAvailabilityType|null}`.
- `GET …/forums/(forumId)/topics/` → array of Topic `{ForumId, TopicId, Name, Description{RichText}, StartDate|null, EndDate|null, UnlockStartDate|null, UnlockEndDate|null, IsLocked, AllowAnonymousPosts, RequiresApproval, UnApprovedPostCount, PinnedPostCount, ScoringType:<string>, IsAutoScore, ScoreOutOf|null, IncludeNonScoredValues, ScoredCount, RatingsSum, RatingsCount, IsHidden, MustPostToParticipate, RatingType, ActivityId|null, GroupTypeId|null, StartDateAvailabilityType|null, EndDateAvailabilityType|null, DueDate|null (≥1.90)}`.
- `GET …/forums/(f)/topics/(t)/posts/?pageSize=&pageNumber=&threadsOnly=&threadId=&sort=` → array of Post; `pageSize` max/default 1000, `pageNumber` from 1, **no HasMore** (stop when a page is short); default sort `-creationdate`. Post `{ForumId, PostId, TopicId, PostingUserId|null, PostingUserDisplayName, ThreadId, ParentPostId|null, Message{RichText}, Subject, DatePosted, IsAnonymous, RequiresApproval, IsDeleted, LastEditedDate|null, LastEditedBy|null, CanRate, ReplyPostIds[], WordCount, AttachmentCount, IsRead, Attachments[{FileId,FileName,Size}] (≥1.95), ThreadIsPinned (≥1.95)}`.
- `GET …/topics/(t)/posts/(postId)` → Post. Scopes `discussions:{forums,topics,posts}:readonly`.

## A-21 — Calendar (`/res/calendar.html#Calendar.EventDataInfo`)

- `GET /d2l/api/le/(v)/(ou)/calendar/events/?associatedEventsOnly=` → bare array; no date window.
- `GET /d2l/api/le/(v)/calendar/events/myEvents/?orgUnitIdsCSV=&startDateTime=&endDateTime=&association=&eventType=` → ObjectListPage (desc by StartDateTime). Per-OU variant `…/(ou)/calendar/events/myEvents/`. Scope `calendar:my_events:read`.
- EventDataInfo `{CalendarEventId, OrgUnitId, Title, Description:<string>, StartDateTime|null, EndDateTime|null, IsAllDayEvent, StartDay|null, EndDay|null, GroupId|null, IsRecurring, RecurrenceInfo, LocationId|null, LocationName, OrgUnitName, OrgUnitCode, IsAssociatedWithEntity, AssociatedEntity{AssociatedEntityType, AssociatedEntityId, Link}, HasVisibilityRestrictions, VisibilityRestrictions, CalendarEventViewUrl, EventType (≥1.94), Presenters[]}`. EVENTTYPE_T: Reminder=1, AvailabilityStarts=2, AvailabilityEnds=3, UnlockStarts=4, UnlockEnds=5, DueDate=6. ASSOCIATION_T Any=1 AssociatedOnly=2 UnassociatedOnly=3.

## A-25 — `GET /d2l/api/versions/` (anonymous, all versions)

→ array of `{ProductCode, LatestVersion, SupportedVersions[]}`. Also `GET /d2l/api/(productCode)/versions/` and `POST /d2l/api/versions/check`. No Authorization header needed — a good reachability probe for `auth doctor`.

## Extra A — Users: `users/(userId)` and `users/?userName=` are privacy-gated (learners likely 403). `profile/user/(userId)` works for own profile. Posts carry `PostingUserDisplayName`; do not depend on user lookups in v1.

## Extra B — Errors: `Errors.ProblemDetails` `{type, status, title, detail, instance}` (RFC 7807) "may" be used; some routes return plain text (`Timestamp out of range`, `Invalid Token`) or empty bodies. 403 = missing permission (same permission as the web UI); 404 may also mean a bad route or wrong trailing slash (collections end with `/`, single items do not). 429 = wait for reset; 500 empty body; 504.

## Extra C — Rate limiting (`/basic/apicall.html#rate-limiting`)

Token-bucket credits; 429 when exhausted; headers `X-Rate-Limit-Remaining`, `X-Request-Cost`, `X-Rate-Limit-Reset` and `Retry-After` (same value, seconds). Bucket sizes undocumented on the site. Honor `Retry-After`; log `X-Request-Cost` under `--verbose`.

## Extra D — Dates: `UTCDateTime` = `yyyy-MM-ddTHH:mm:ss.fffZ` (milliseconds required on input; `Date.toISOString()` complies). `LocalDateTime` = same without `Z`. `ISODate` = date only.

## Extra E — `GET /d2l/api/le/(v)/content/myItems/due/?orgUnitIdsCSV=&startDateTime=&endDateTime=&completion=` → ObjectListPage of ScheduledItem `{UserId:<string>, OrgUnitId:<string>, ItemId, ItemName, ItemType (0 Module, 1 Topic), ItemUrl|null, StartDate|null, EndDate|null, DueDate|null, CompletionType, DateCompleted|null, ActivityType, IsExempt}` (≤100 org units; content-tool items only; exempted items excluded). Per-OU variants and `itemCount` routes exist.

## Summary

| ID | Route | Confidence |
|---|---|---|
| A-08 | `lp/(v)/users/whoami` | documented |
| A-09 | `myenrollments/?bookmark=&sortBy=&isActive=&canAccess=&startDateTime=&endDateTime=` | documented |
| A-10 | `lp/(v)/courses/(ou)`, `myenrollments/(ou)` | documented |
| A-11 | `le/(v)/(ou)/dropbox/folders/(id)` | documented |
| A-12 | `…/submissions/mysubmissions/`, `…/submissions/(sid)/files/(fid)`, `…/attachments/(fid)` | documented |
| A-13 | `le/(v)/(ou)/quizzes/(id)`; `attempts/` learner access unknown | documented / unknown |
| A-14 | `grades/values/myGradeValues/` (404 = none), `grades/` | documented |
| A-15 | `grades/final/values/myGradeValue` (404 = none) | documented |
| A-16 | `news/?since=`, `news/(id)/attachments/(fid)` | documented |
| A-17 | `content/toc?ignoreDateRestrictions=`, `content/root/`, `content/modules/(id)/structure/` | documented |
| A-18 | `content/topics/(id)` | documented |
| A-19 | `content/topics/(id)/file?stream=` (400 for non-file) | documented |
| A-20 | `discussions/forums/`, `…/topics/`, `…/posts/?pageSize=&pageNumber=`, `…/posts/(id)` | documented |
| A-21 | `(ou)/calendar/events/`, `calendar/events/myEvents/?orgUnitIdsCSV=…` | documented |
| A-25 | `/d2l/api/versions/` (anonymous) | documented |
| Extra E | `content/myItems/due/?orgUnitIdsCSV=` | documented |
