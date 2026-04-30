import type { DiffReviewComment, PullRequestInfo, ReviewFile, ReviewScope, ReviewSubmitPayload } from "./types.js";

function formatScopeLabel(scope: ReviewScope): string {
  return scope === "pr-diff" ? "PR diff" : "all files";
}

function getCommentFilePath(file: ReviewFile | undefined, scope: ReviewScope): string {
  if (file == null) return "(unknown file)";
  if (scope === "pr-diff") return file.prDiff?.displayPath ?? file.path;
  return file.path;
}

function formatLocation(comment: DiffReviewComment, file: ReviewFile | undefined): string {
  const filePath = getCommentFilePath(file, comment.scope);
  const scopePrefix = `[${formatScopeLabel(comment.scope)}] `;

  if (comment.side === "file" || comment.startLine == null) {
    return `${scopePrefix}${filePath}`;
  }

  const range = comment.endLine != null && comment.endLine !== comment.startLine
    ? `${comment.startLine}-${comment.endLine}`
    : `${comment.startLine}`;

  if (comment.scope === "all-files") {
    return `${scopePrefix}${filePath}:${range}`;
  }

  const suffix = comment.side === "original" ? " (base)" : " (head)";
  return `${scopePrefix}${filePath}:${range}${suffix}`;
}

export function composeReviewPrompt(pr: PullRequestInfo, files: ReviewFile[], payload: ReviewSubmitPayload): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [];

  lines.push(`Please address the following feedback for PR #${pr.number} — ${pr.title}`);
  lines.push(pr.url);
  lines.push("");

  const overall = payload.overallComment.trim();
  if (overall.length > 0) {
    lines.push(overall);
    lines.push("");
  }

  payload.comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    lines.push(`${index + 1}. ${formatLocation(comment, file)}`);
    lines.push(`   ${comment.body.trim()}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}
