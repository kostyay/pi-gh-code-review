import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  ChangeStatus,
  PrCommentSide,
  PrReviewComment,
  PrReviewThread,
  PullRequestInfo,
  PullRequestSummary,
  ReviewFile,
  ReviewFileComparison,
  ReviewFileContents,
  ReviewScope,
  ReviewWindowData,
} from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

interface PreparedPullRequest {
  info: PullRequestInfo;
  workDir: string;
}

interface GhPrViewJson {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  author: { login?: string; name?: string } | null;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  isCrossRepository: boolean;
  baseRepository: { name: string; owner: { login: string } } | null;
  headRepository: { name: string; owner: { login: string } } | null;
}

interface GhPrListEntry {
  number: number;
  title: string;
  url: string;
  state: string;
  author: { login?: string; name?: string } | null;
  baseRefName: string;
  headRefName: string;
}

const PR_VIEW_FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "url",
  "author",
  "baseRefName",
  "headRefName",
  "baseRefOid",
  "headRefOid",
  "isCrossRepository",
  "baseRepository",
  "headRepository",
].join(",");

const PR_LIST_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "author",
  "baseRefName",
  "headRefName",
].join(",");

export function parsePullRequestSpec(input: string): PullRequestRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const urlMatch = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (urlMatch != null) {
    return { owner: urlMatch[1], repo: urlMatch[2], number: Number(urlMatch[3]) };
  }

  const shortMatch = trimmed.match(/^([^/]+)\/([^/#]+)#(\d+)$/);
  if (shortMatch != null) {
    return { owner: shortMatch[1], repo: shortMatch[2], number: Number(shortMatch[3]) };
  }

  return null;
}

async function runCommand(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean } = {},
): Promise<string> {
  const result = await pi.exec(command, args, { cwd: options.cwd });
  if (result.code !== 0) {
    if (options.allowFailure === true) return "";
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const detail = stderr.length > 0 ? stderr : stdout.length > 0 ? stdout : `exit code ${result.code}`;
    throw new Error(`\`${command} ${args.join(" ")}\` failed: ${detail}`);
  }
  return result.stdout;
}

async function ensureGhAvailable(pi: ExtensionAPI): Promise<void> {
  const result = await pi.exec("gh", ["--version"], {});
  if (result.code !== 0) {
    throw new Error("`gh` CLI is required. Install from https://cli.github.com and authenticate with `gh auth login`.");
  }
}

async function fetchPullRequestInfo(pi: ExtensionAPI, ref: PullRequestRef): Promise<GhPrViewJson> {
  const args = [
    "pr",
    "view",
    String(ref.number),
    "--repo",
    `${ref.owner}/${ref.repo}`,
    "--json",
    PR_VIEW_FIELDS,
  ];
  const stdout = await runCommand(pi, "gh", args);
  return JSON.parse(stdout) as GhPrViewJson;
}

function workDirFor(ref: PullRequestRef): string {
  const safeOwner = ref.owner.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeRepo = ref.repo.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(tmpdir(), "pi-gh-code-review", `${safeOwner}-${safeRepo}-${ref.number}`);
}

async function ensureClone(pi: ExtensionAPI, ref: PullRequestRef, workDir: string): Promise<void> {
  if (existsSync(join(workDir, ".git"))) return;
  await mkdir(join(tmpdir(), "pi-gh-code-review"), { recursive: true });
  await runCommand(pi, "gh", ["repo", "clone", `${ref.owner}/${ref.repo}`, workDir, "--", "--no-tags"]);
}

async function checkoutPullRequest(pi: ExtensionAPI, ref: PullRequestRef, workDir: string): Promise<void> {
  await runCommand(pi, "git", ["fetch", "--prune", "origin"], { cwd: workDir, allowFailure: true });
  await runCommand(pi, "gh", [
    "pr",
    "checkout",
    String(ref.number),
    "--repo",
    `${ref.owner}/${ref.repo}`,
    "--force",
  ], { cwd: workDir });
}

async function resolveMergeBase(pi: ExtensionAPI, workDir: string, baseRefOid: string, headRefOid: string): Promise<string> {
  const stdout = await runCommand(pi, "git", ["merge-base", baseRefOid, headRefOid], { cwd: workDir });
  return stdout.trim();
}

function parseLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseNameStatus(output: string): ChangedPath[] {
  const changes: ChangedPath[] = [];
  for (const line of parseLines(output)) {
    const parts = line.split("\t");
    const code = (parts[0] ?? "")[0];
    const first = parts[1] ?? null;
    if (code === "R") {
      const second = parts[2] ?? null;
      if (first != null && second != null) changes.push({ status: "renamed", oldPath: first, newPath: second });
    } else if (code === "M" && first != null) {
      changes.push({ status: "modified", oldPath: first, newPath: first });
    } else if (code === "A" && first != null) {
      changes.push({ status: "added", oldPath: null, newPath: first });
    } else if (code === "D" && first != null) {
      changes.push({ status: "deleted", oldPath: first, newPath: null });
    }
  }
  return changes;
}

function isReviewableFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  const fileName = lower.split("/").pop() ?? lower;
  if (fileName.length === 0) return false;
  const extension = extname(fileName);
  const binary = new Set([
    ".7z", ".a", ".avi", ".avif", ".bin", ".bmp", ".class", ".dll", ".dylib",
    ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lockb",
    ".map", ".mov", ".mp3", ".mp4", ".o", ".otf", ".pdf", ".png", ".pyc",
    ".so", ".svgz", ".tar", ".ttf", ".wasm", ".webm", ".webp", ".woff",
    ".woff2", ".zip",
  ]);
  if (binary.has(extension)) return false;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;
  return true;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change: ChangedPath): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
  };
}

function buildReviewFileId(path: string, hasHeadFile: boolean, prDiff: ReviewFileComparison | null): string {
  return [path, hasHeadFile ? "head" : "gone", prDiff?.displayPath ?? ""].join("::");
}

function authorName(author: GhPrViewJson["author"]): string {
  if (author == null) return "unknown";
  return author.login ?? author.name ?? "unknown";
}

async function listChangedFiles(pi: ExtensionAPI, workDir: string, mergeBase: string, headRefOid: string): Promise<ChangedPath[]> {
  const stdout = await runCommand(pi, "git", [
    "diff",
    "--find-renames",
    "-M",
    "--name-status",
    mergeBase,
    headRefOid,
    "--",
  ], { cwd: workDir });
  return parseNameStatus(stdout).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
}

async function listHeadTreeFiles(pi: ExtensionAPI, workDir: string, headRefOid: string): Promise<string[]> {
  const stdout = await runCommand(pi, "git", ["ls-tree", "-r", "--name-only", headRefOid], { cwd: workDir });
  return parseLines(stdout).filter(isReviewableFilePath);
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

export async function preparePullRequest(pi: ExtensionAPI, ref: PullRequestRef): Promise<PreparedPullRequest> {
  await ensureGhAvailable(pi);
  const view = await fetchPullRequestInfo(pi, ref);
  const workDir = workDirFor(ref);
  await ensureClone(pi, ref, workDir);
  await checkoutPullRequest(pi, ref, workDir);
  const mergeBase = await resolveMergeBase(pi, workDir, view.baseRefOid, view.headRefOid);

  const info: PullRequestInfo = {
    url: view.url,
    number: view.number,
    title: view.title,
    body: view.body ?? "",
    author: authorName(view.author),
    state: view.state,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    headRefOid: view.headRefOid,
    baseRefOid: view.baseRefOid,
    mergeBase,
    baseOwner: view.baseRepository?.owner.login ?? ref.owner,
    baseRepo: view.baseRepository?.name ?? ref.repo,
    isCrossRepository: view.isCrossRepository,
  };

  return { info, workDir };
}

function attachThreadsToFiles(files: ReviewFile[], threads: PrReviewThread[]): PrReviewThread[] {
  const orphans: PrReviewThread[] = [];
  const fileThreads = new Map<string, PrReviewThread[]>();

  for (const thread of threads) {
    const match = files.find((file) => {
      if (thread.side === "head") {
        return file.prDiff?.newPath === thread.path || file.path === thread.path;
      }
      return file.prDiff?.oldPath === thread.path || file.path === thread.path;
    });
    if (match == null) {
      orphans.push(thread);
      continue;
    }
    const list = fileThreads.get(match.id) ?? [];
    list.push(thread);
    fileThreads.set(match.id, list);
  }

  for (const file of files) {
    file.threads = fileThreads.get(file.id) ?? [];
  }

  return orphans;
}

export async function getReviewWindowData(pi: ExtensionAPI, prepared: PreparedPullRequest): Promise<ReviewWindowData> {
  const { info, workDir } = prepared;
  const changes = await listChangedFiles(pi, workDir, info.mergeBase, info.headRefOid);
  const headTreeFiles = await listHeadTreeFiles(pi, workDir, info.headRefOid);

  const seeds = new Map<string, { path: string; hasHeadFile: boolean; inPrDiff: boolean; prDiff: ReviewFileComparison | null }>();

  for (const path of headTreeFiles) {
    seeds.set(path, { path, hasHeadFile: true, inPrDiff: false, prDiff: null });
  }

  for (const change of changes) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const existing = seeds.get(key);
    const seed = existing ?? { path: key, hasHeadFile: change.newPath != null, inPrDiff: false, prDiff: null };
    seed.inPrDiff = true;
    seed.prDiff = toComparison(change);
    seed.hasHeadFile = change.newPath != null;
    seeds.set(key, seed);
  }

  const files: ReviewFile[] = [...seeds.values()]
    .map((seed) => ({
      id: buildReviewFileId(seed.path, seed.hasHeadFile, seed.prDiff),
      path: seed.path,
      inPrDiff: seed.inPrDiff,
      hasHeadFile: seed.hasHeadFile,
      prDiff: seed.prDiff,
      threads: [],
    }))
    .sort(compareReviewFiles);

  const threads = await fetchPullRequestReviewThreads(pi, {
    owner: info.baseOwner,
    repo: info.baseRepo,
    number: info.number,
  });
  const orphanThreads = attachThreadsToFiles(files, threads);

  return { pr: info, workDir, files, orphanThreads };
}

async function readBlob(pi: ExtensionAPI, workDir: string, revision: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: workDir });
  if (result.code !== 0) return "";
  return result.stdout;
}

export async function loadReviewFileContents(
  pi: ExtensionAPI,
  data: ReviewWindowData,
  file: ReviewFile,
  scope: ReviewScope,
): Promise<ReviewFileContents> {
  if (scope === "all-files") {
    const content = file.hasHeadFile ? await readBlob(pi, data.workDir, data.pr.headRefOid, file.path) : "";
    return { originalContent: content, modifiedContent: content };
  }

  const comparison = file.prDiff;
  if (comparison == null) return { originalContent: "", modifiedContent: "" };

  const originalContent = comparison.oldPath == null
    ? ""
    : await readBlob(pi, data.workDir, data.pr.mergeBase, comparison.oldPath);
  const modifiedContent = comparison.newPath == null
    ? ""
    : await readBlob(pi, data.workDir, data.pr.headRefOid, comparison.newPath);

  return { originalContent, modifiedContent };
}

interface GhReviewCommentRaw {
  id: number;
  in_reply_to_id?: number;
  body: string;
  user: { login: string; avatar_url: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  diff_hunk: string;
  path: string;
  side: string | null;
  start_side: string | null;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  original_start_line: number | null;
  position: number | null;
  original_position: number | null;
  subject_type?: string;
}

function normalizeSide(side: string | null | undefined): PrCommentSide {
  return side === "LEFT" ? "base" : "head";
}

function normalizeOptionalSide(side: string | null | undefined): PrCommentSide | null {
  return side == null ? null : normalizeSide(side);
}

function toReviewComment(raw: GhReviewCommentRaw, threadId: number): PrReviewComment {
  return {
    id: raw.id,
    threadId,
    body: raw.body ?? "",
    author: {
      login: raw.user?.login ?? "unknown",
      avatarUrl: raw.user?.avatar_url ?? null,
    },
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    htmlUrl: raw.html_url,
    diffHunk: raw.diff_hunk ?? "",
  };
}

function createThreadFromRoot(root: GhReviewCommentRaw, threadId: number): PrReviewThread {
  const line = root.line ?? root.original_line ?? null;
  const startLine = root.start_line ?? root.original_start_line ?? null;
  const fileLevel = root.subject_type === "file";
  return {
    id: threadId,
    path: root.path,
    side: normalizeSide(root.side),
    line,
    startLine: startLine === line ? null : startLine,
    startSide: normalizeOptionalSide(root.start_side),
    outdated: !fileLevel && root.line == null,
    fileLevel,
    comments: [toReviewComment(root, threadId)],
  };
}

function resolveRootId(raw: GhReviewCommentRaw, byId: Map<number, GhReviewCommentRaw>): number {
  let rootId = raw.in_reply_to_id ?? raw.id;
  let next = byId.get(rootId);
  while (next != null && next.in_reply_to_id != null) {
    rootId = next.in_reply_to_id;
    next = byId.get(rootId);
  }
  return rootId;
}

function groupReviewCommentsIntoThreads(raws: GhReviewCommentRaw[]): PrReviewThread[] {
  const byId = new Map<number, GhReviewCommentRaw>();
  for (const raw of raws) byId.set(raw.id, raw);

  const sorted = [...raws].sort((a, b) => {
    const aTime = Date.parse(a.created_at);
    const bTime = Date.parse(b.created_at);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
    return a.id - b.id;
  });

  const threadMap = new Map<number, PrReviewThread>();
  for (const raw of sorted) {
    const rootId = resolveRootId(raw, byId);
    const existing = threadMap.get(rootId);
    if (existing == null) {
      threadMap.set(rootId, createThreadFromRoot(byId.get(rootId) ?? raw, rootId));
    } else {
      existing.comments.push(toReviewComment(raw, rootId));
    }
  }

  return [...threadMap.values()].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

async function fetchPullRequestReviewThreads(pi: ExtensionAPI, ref: PullRequestRef): Promise<PrReviewThread[]> {
  const stdout = await runCommand(pi, "gh", [
    "api",
    "--paginate",
    "--method",
    "GET",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
    "-F",
    "per_page=100",
  ]);
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  try {
    return groupReviewCommentsIntoThreads(JSON.parse(trimmed) as GhReviewCommentRaw[]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse PR review comments JSON: ${message}`);
  }
}

export interface PostLineCommentParams {
  path: string;
  side: PrCommentSide;
  line: number;
  body: string;
  commitSha: string;
}

function sideToGhValue(side: PrCommentSide): string {
  return side === "base" ? "LEFT" : "RIGHT";
}

export async function postLineComment(
  pi: ExtensionAPI,
  ref: PullRequestRef,
  params: PostLineCommentParams,
): Promise<PrReviewThread> {
  const stdout = await runCommand(pi, "gh", [
    "api",
    "-X",
    "POST",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
    "-f", `body=${params.body}`,
    "-f", `commit_id=${params.commitSha}`,
    "-f", `path=${params.path}`,
    "-F", `line=${params.line}`,
    "-f", `side=${sideToGhValue(params.side)}`,
  ]);
  const raw = JSON.parse(stdout) as GhReviewCommentRaw;
  return createThreadFromRoot(raw, raw.id);
}

export async function postCommentReply(
  pi: ExtensionAPI,
  ref: PullRequestRef,
  threadId: number,
  body: string,
): Promise<PrReviewComment> {
  const stdout = await runCommand(pi, "gh", [
    "api",
    "-X",
    "POST",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${threadId}/replies`,
    "-f", `body=${body}`,
  ]);
  const raw = JSON.parse(stdout) as GhReviewCommentRaw;
  return toReviewComment(raw, threadId);
}

export async function listOpenPullRequests(pi: ExtensionAPI, cwd: string): Promise<PullRequestSummary[]> {
  await ensureGhAvailable(pi);
  const stdout = await runCommand(pi, "gh", [
    "pr", "list",
    "--state", "open",
    "--limit", "50",
    "--json", PR_LIST_FIELDS,
  ], { cwd });
  const entries = JSON.parse(stdout) as GhPrListEntry[];
  return entries.map((entry) => ({
    url: entry.url,
    number: entry.number,
    title: entry.title,
    author: authorName(entry.author),
    headRefName: entry.headRefName,
    baseRefName: entry.baseRefName,
    state: entry.state,
  }));
}
