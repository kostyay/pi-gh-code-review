import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  PrCommentSide,
  PrReviewComment,
  PrReviewThread,
  PullRequestRef,
  PullRequestSummary,
} from "./types.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

// Rate-limit handling. GitHub returns x-ratelimit-* on every response and uses
// 403/429 with `retry-after` for primary and secondary (abuse) limits.
// Reference: https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const MIN_WRITE_INTERVAL_MS = 1_000;
const MAX_RATE_LIMIT_RETRIES = 3;

// ---------------------------------------------------------------------------
// Generic command runner (used for both gh-token fallback and git invocations).
// ---------------------------------------------------------------------------

export interface RunCliOptions {
  cwd?: string;
  /** When true, return empty string on non-zero exit instead of throwing. */
  allowFailure?: boolean;
}

export async function runCli(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  options: RunCliOptions = {},
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

// ---------------------------------------------------------------------------
// Auth — token retrieved via `gh auth token` (cached for the session).
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;

async function getGitHubToken(pi: ExtensionAPI): Promise<string> {
  if (cachedToken != null) return cachedToken;
  const result = await pi.exec("gh", ["auth", "token"], {});
  if (result.code !== 0) {
    throw new Error(
      "Could not get GitHub token from `gh auth token`. Install the gh CLI from https://cli.github.com and run `gh auth login`.",
    );
  }
  const token = result.stdout.trim();
  if (token.length === 0) {
    throw new Error("`gh auth token` returned an empty token. Run `gh auth login` to authenticate.");
  }
  cachedToken = token;
  return cachedToken;
}

export async function ensureGitHubAuth(pi: ExtensionAPI): Promise<void> {
  await getGitHubToken(pi);
}

// ---------------------------------------------------------------------------
// REST API helpers (fetch).
// ---------------------------------------------------------------------------

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

interface ApiRequestInit {
  method?: HttpMethod;
  body?: unknown;
}

async function buildAuthHeaders(pi: ExtensionAPI): Promise<Record<string, string>> {
  const token = await getGitHubToken(pi);
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "pi-gh-code-review",
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return `${response.status} ${response.statusText}`;
  }
  try {
    const parsed = JSON.parse(text) as { message?: string; errors?: unknown };
    if (parsed.message != null) {
      const extra = parsed.errors != null ? ` — ${JSON.stringify(parsed.errors)}` : "";
      return `${response.status} ${parsed.message}${extra}`;
    }
  } catch {
    // not JSON
  }
  return text.length > 0 ? `${response.status} ${text}` : `${response.status} ${response.statusText}`;
}

// --- Rate-limit aware fetch ------------------------------------------------

let rateLimitRemaining: number | null = null;
let rateLimitResetEpochSec: number | null = null;
let lastWriteAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWriteMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function readNumericHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function updateRateLimitFromHeaders(headers: Headers): void {
  const remaining = readNumericHeader(headers, "x-ratelimit-remaining");
  const reset = readNumericHeader(headers, "x-ratelimit-reset");
  if (remaining != null) rateLimitRemaining = remaining;
  if (reset != null) rateLimitResetEpochSec = reset;
}

function parseRetryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (value == null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function waitForPrimaryRateLimit(): Promise<void> {
  if (rateLimitRemaining == null || rateLimitRemaining > 0) return;
  if (rateLimitResetEpochSec == null) return;
  const resetMs = rateLimitResetEpochSec * 1000;
  const waitMs = resetMs - Date.now();
  if (waitMs <= 0) {
    rateLimitRemaining = null;
    return;
  }
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
    const eta = new Date(resetMs).toISOString();
    throw new Error(`GitHub primary rate limit exhausted. Resets at ${eta}. Try again later.`);
  }
  await sleep(waitMs + 250);
  rateLimitRemaining = null;
}

async function waitForWriteSpacing(method: string): Promise<void> {
  if (!isWriteMethod(method)) return;
  const elapsed = Date.now() - lastWriteAt;
  if (elapsed < MIN_WRITE_INTERVAL_MS) await sleep(MIN_WRITE_INTERVAL_MS - elapsed);
}

function shouldRetryRateLimit(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.headers.get("retry-after") != null) return true;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

async function githubFetch(
  url: string,
  method: HttpMethod,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await waitForPrimaryRateLimit();
    await waitForWriteSpacing(method);

    const response = await fetch(url, { method, headers, body });
    updateRateLimitFromHeaders(response.headers);
    if (isWriteMethod(method)) lastWriteAt = Date.now();

    if (!shouldRetryRateLimit(response)) return response;
    if (attempt >= MAX_RATE_LIMIT_RETRIES) return response;

    const retryAfterMs = parseRetryAfterMs(response.headers) ?? 0;
    const backoffMs = 1000 * 2 ** attempt;
    const waitMs = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(retryAfterMs, backoffMs));
    await sleep(waitMs + 250);
  }
}

async function githubApi<T>(pi: ExtensionAPI, path: string, init: ApiRequestInit = {}): Promise<T> {
  const headers = await buildAuthHeaders(pi);
  const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;
  const method = init.method ?? "GET";
  if (init.body != null) headers["Content-Type"] = "application/json";
  const body = init.body != null ? JSON.stringify(init.body) : undefined;

  const response = await githubFetch(url, method, headers, body);

  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} failed: ${await readErrorDetail(response)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function parseLinkNext(link: string | null): string | null {
  if (link == null) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match != null ? match[1] : null;
}

async function githubApiPaginate<T>(pi: ExtensionAPI, path: string): Promise<T[]> {
  const headers = await buildAuthHeaders(pi);
  const initialUrl = path.startsWith("http")
    ? path
    : `${GITHUB_API_BASE}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const collected: T[] = [];
  let url: string | null = initialUrl;
  while (url != null) {
    const response = await githubFetch(url, "GET", headers, undefined);
    if (!response.ok) {
      throw new Error(`GitHub API GET ${path} failed: ${await readErrorDetail(response)}`);
    }
    collected.push(...((await response.json()) as T[]));
    url = parseLinkNext(response.headers.get("link"));
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Repo URL parsing + cwd → repo detection.
// ---------------------------------------------------------------------------

export function parseGitRemoteUrl(url: string): { owner: string; repo: string } | null {
  const match = url.trim().match(/(?:[:/])([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (match == null) return null;
  return { owner: match[1], repo: match[2] };
}

export async function detectGitHubRepoFromCwd(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{ owner: string; repo: string } | null> {
  const result = await pi.exec("git", ["remote", "get-url", "origin"], { cwd });
  if (result.code !== 0) return null;
  return parseGitRemoteUrl(result.stdout);
}

// ---------------------------------------------------------------------------
// Raw GitHub API shapes (private).
// ---------------------------------------------------------------------------

interface RawPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string } | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; repo: { owner: { login: string }; name: string } | null };
}

interface RawReviewComment {
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
  subject_type?: string;
}

// ---------------------------------------------------------------------------
// Public output shapes.
// ---------------------------------------------------------------------------

export interface PullRequestView {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  author: string;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  isCrossRepository: boolean;
}

export interface PostLineCommentInput {
  path: string;
  side: PrCommentSide;
  line: number;
  startLine?: number | null;
  body: string;
  commitSha: string;
}

// ---------------------------------------------------------------------------
// Internal helpers (raw → domain).
// ---------------------------------------------------------------------------

function authorDisplay(login: string | undefined | null): string {
  return login != null && login.length > 0 ? login : "unknown";
}

function viewFromRaw(raw: RawPullRequest, ref: PullRequestRef): PullRequestView {
  const headOwner = raw.head.repo?.owner.login ?? ref.owner;
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state.toUpperCase(),
    url: raw.html_url,
    author: authorDisplay(raw.user?.login),
    baseRefName: raw.base.ref,
    headRefName: raw.head.ref,
    baseRefOid: raw.base.sha,
    headRefOid: raw.head.sha,
    isCrossRepository: headOwner.toLowerCase() !== ref.owner.toLowerCase(),
  };
}

function summaryFromRaw(raw: RawPullRequest): PullRequestSummary {
  return {
    url: raw.html_url,
    number: raw.number,
    title: raw.title,
    author: authorDisplay(raw.user?.login),
    headRefName: raw.head.ref,
    baseRefName: raw.base.ref,
    state: raw.state.toUpperCase(),
  };
}

function normalizeSide(side: string | null | undefined): PrCommentSide {
  return side === "LEFT" ? "base" : "head";
}

function normalizeOptionalSide(side: string | null | undefined): PrCommentSide | null {
  return side == null ? null : normalizeSide(side);
}

function sideToGitHubValue(side: PrCommentSide): string {
  return side === "base" ? "LEFT" : "RIGHT";
}

function toReviewComment(raw: RawReviewComment, threadId: number): PrReviewComment {
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

function createThreadFromRoot(root: RawReviewComment, threadId: number): PrReviewThread {
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

function resolveRootId(raw: RawReviewComment, byId: Map<number, RawReviewComment>): number {
  let rootId = raw.in_reply_to_id ?? raw.id;
  let next = byId.get(rootId);
  while (next != null && next.in_reply_to_id != null) {
    rootId = next.in_reply_to_id;
    next = byId.get(rootId);
  }
  return rootId;
}

function groupReviewCommentsIntoThreads(raws: RawReviewComment[]): PrReviewThread[] {
  const byId = new Map<number, RawReviewComment>();
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

// ---------------------------------------------------------------------------
// Public GitHub operations.
// ---------------------------------------------------------------------------

export async function fetchPullRequestView(pi: ExtensionAPI, ref: PullRequestRef): Promise<PullRequestView> {
  const raw = await githubApi<RawPullRequest>(pi, `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  return viewFromRaw(raw, ref);
}

export async function listOpenPullRequests(
  pi: ExtensionAPI,
  cwd: string,
  limit = 10,
): Promise<PullRequestSummary[]> {
  await ensureGitHubAuth(pi);
  const repo = await detectGitHubRepoFromCwd(pi, cwd);
  if (repo == null) {
    throw new Error("Not in a GitHub repository (could not read origin remote).");
  }
  const raws = await githubApi<RawPullRequest[]>(
    pi,
    `/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=${limit}`,
  );
  return raws.map(summaryFromRaw);
}

export async function getCurrentBranchPullRequestUrl(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const repo = await detectGitHubRepoFromCwd(pi, cwd);
  if (repo == null) return null;
  const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (branchResult.code !== 0) return null;
  const branch = branchResult.stdout.trim();
  if (branch.length === 0 || branch === "HEAD") return null;

  try {
    const raws = await githubApi<RawPullRequest[]>(
      pi,
      `/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${repo.owner}:${encodeURIComponent(branch)}&per_page=1`,
    );
    return raws.length > 0 ? raws[0].html_url : null;
  } catch {
    return null;
  }
}

export async function cloneRepository(pi: ExtensionAPI, ref: PullRequestRef, dest: string): Promise<void> {
  const token = await getGitHubToken(pi);
  await runCli(pi, "git", [
    "-c", `http.extraheader=Authorization: Bearer ${token}`,
    "clone", "--no-tags",
    `https://github.com/${ref.owner}/${ref.repo}.git`,
    dest,
  ]);
  // Persist the auth header in the cloned repo so subsequent fetches authenticate.
  await runCli(pi, "git", ["config", "http.extraheader", `Authorization: Bearer ${token}`], { cwd: dest });
}

export async function checkoutPullRequest(pi: ExtensionAPI, ref: PullRequestRef, cwd: string): Promise<void> {
  const localBranch = `pi-pr-${ref.number}`;
  await runCli(pi, "git", [
    "fetch", "--force", "--prune", "origin",
    `+refs/pull/${ref.number}/head:refs/heads/${localBranch}`,
  ], { cwd });
  await runCli(pi, "git", ["checkout", "--force", localBranch], { cwd });
}

export async function fetchPullRequestReviewThreads(
  pi: ExtensionAPI,
  ref: PullRequestRef,
): Promise<PrReviewThread[]> {
  const raws = await githubApiPaginate<RawReviewComment>(
    pi,
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
  );
  return groupReviewCommentsIntoThreads(raws);
}

export async function postLineComment(
  pi: ExtensionAPI,
  ref: PullRequestRef,
  input: PostLineCommentInput,
): Promise<PrReviewThread> {
  const sideValue = sideToGitHubValue(input.side);
  const body: Record<string, unknown> = {
    body: input.body,
    commit_id: input.commitSha,
    path: input.path,
    line: input.line,
    side: sideValue,
  };
  if (input.startLine != null && input.startLine !== input.line) {
    body.start_line = input.startLine;
    body.start_side = sideValue;
  }
  const raw = await githubApi<RawReviewComment>(
    pi,
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
    { method: "POST", body },
  );
  return createThreadFromRoot(raw, raw.id);
}

export async function postCommentReply(
  pi: ExtensionAPI,
  ref: PullRequestRef,
  rootCommentId: number,
  body: string,
): Promise<PrReviewComment> {
  const raw = await githubApi<RawReviewComment>(
    pi,
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${rootCommentId}/replies`,
    { method: "POST", body: { body } },
  );
  return toReviewComment(raw, rootCommentId);
}

export async function editReviewComment(
  pi: ExtensionAPI,
  ref: PullRequestRef,
  threadId: number,
  commentId: number,
  body: string,
): Promise<PrReviewComment> {
  const raw = await githubApi<RawReviewComment>(
    pi,
    `/repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`,
    { method: "PATCH", body: { body } },
  );
  return toReviewComment(raw, threadId);
}

export async function deleteReviewComment(
  pi: ExtensionAPI,
  ref: PullRequestRef,
  commentId: number,
): Promise<void> {
  await githubApi<void>(
    pi,
    `/repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`,
    { method: "DELETE" },
  );
}

export async function getViewerLogin(pi: ExtensionAPI): Promise<string | null> {
  try {
    const raw = await githubApi<{ login: string | null }>(pi, "/user");
    return raw.login != null && raw.login.length > 0 ? raw.login : null;
  } catch {
    return null;
  }
}
