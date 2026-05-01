export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export type ReviewScope = "pr-diff" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
}

export type PrCommentSide = "base" | "head";

export interface PrReviewCommentAuthor {
  login: string;
  avatarUrl: string | null;
}

export interface PrReviewComment {
  id: number;
  threadId: number;
  body: string;
  author: PrReviewCommentAuthor;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  diffHunk: string;
}

export interface PrReviewThread {
  id: number;
  path: string;
  side: PrCommentSide;
  line: number | null;
  startLine: number | null;
  startSide: PrCommentSide | null;
  outdated: boolean;
  fileLevel: boolean;
  comments: PrReviewComment[];
}

export interface ReviewFile {
  id: string;
  path: string;
  inPrDiff: boolean;
  hasHeadFile: boolean;
  prDiff: ReviewFileComparison | null;
  threads: PrReviewThread[];
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewRequestFilePayload {
  type: "request-file";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
}

export interface ReviewPostCommentPayload {
  type: "post-comment";
  clientId: string;
  fileId: string;
  side: PrCommentSide;
  line: number;
  startLine?: number | null;
  body: string;
}

export interface ReviewPostReplyPayload {
  type: "post-reply";
  clientId: string;
  fileId: string;
  threadId: number;
  body: string;
}

export interface ReviewEditCommentPayload {
  type: "edit-comment";
  clientId: string;
  fileId: string;
  threadId: number;
  commentId: number;
  body: string;
}

export interface ReviewDeleteCommentPayload {
  type: "delete-comment";
  clientId: string;
  fileId: string;
  threadId: number;
  commentId: number;
}

export type ReviewWindowMessage =
  | ReviewSubmitPayload
  | ReviewCancelPayload
  | ReviewRequestFilePayload
  | ReviewPostCommentPayload
  | ReviewPostReplyPayload
  | ReviewEditCommentPayload
  | ReviewDeleteCommentPayload;

export interface ReviewFileDataMessage {
  type: "file-data";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  originalContent: string;
  modifiedContent: string;
}

export interface ReviewFileErrorMessage {
  type: "file-error";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  message: string;
}

export interface ReviewThreadUpdatedMessage {
  type: "thread-updated";
  clientId: string;
  fileId: string;
  thread: PrReviewThread;
}

export interface ReviewPostErrorMessage {
  type: "post-error";
  clientId: string;
  message: string;
}

export interface ReviewCommentDeletedMessage {
  type: "comment-deleted";
  clientId: string;
  fileId: string;
  threadId: number;
  commentId: number;
}

export type ReviewHostMessage =
  | ReviewFileDataMessage
  | ReviewFileErrorMessage
  | ReviewThreadUpdatedMessage
  | ReviewPostErrorMessage
  | ReviewCommentDeletedMessage;

export interface PullRequestInfo {
  url: string;
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  mergeBase: string;
  baseOwner: string;
  baseRepo: string;
  isCrossRepository: boolean;
}

export interface ReviewWindowData {
  pr: PullRequestInfo;
  workDir: string;
  files: ReviewFile[];
  orphanThreads: PrReviewThread[];
  viewerLogin: string | null;
}

export interface PullRequestSummary {
  url: string;
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  state: string;
}
