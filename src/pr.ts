import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  checkoutPullRequest as ghCheckoutPullRequest,
  cloneRepository as ghCloneRepository,
  ensureGitHubAuth,
  fetchPullRequestReviewThreads,
  fetchPullRequestView,
  getViewerLogin,
  parseGitRemoteUrl,
  type PullRequestView,
  runCli,
} from "./gh.js";
import type {
  ChangeStatus,
  PrReviewThread,
  PullRequestInfo,
  PullRequestRef,
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

interface PreparedPullRequest {
  info: PullRequestInfo;
  workDir: string;
  reusedLocalCheckout: boolean;
}

const WORK_ROOT_DIR = join(tmpdir(), "pi-gh-code-review");

const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".avif", ".bin", ".bmp", ".class", ".dll", ".dylib",
  ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lockb",
  ".map", ".mov", ".mp3", ".mp4", ".o", ".otf", ".pdf", ".png", ".pyc",
  ".so", ".svgz", ".tar", ".ttf", ".wasm", ".webm", ".webp", ".woff",
  ".woff2", ".zip",
]);

// ---------------------------------------------------------------------------
// PR-spec parsing (no GitHub API).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Local working-directory + git operations.
// ---------------------------------------------------------------------------

function workDirFor(ref: PullRequestRef): string {
  const safeOwner = ref.owner.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeRepo = ref.repo.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(WORK_ROOT_DIR, `${safeOwner}-${safeRepo}-${ref.number}`);
}

async function ensureLocalClone(pi: ExtensionAPI, ref: PullRequestRef, workDir: string): Promise<void> {
  if (existsSync(join(workDir, ".git"))) return;
  await mkdir(WORK_ROOT_DIR, { recursive: true });
  await ghCloneRepository(pi, ref, workDir);
}

async function syncPullRequestWorkdir(pi: ExtensionAPI, ref: PullRequestRef, workDir: string): Promise<void> {
  await runCli(pi, "git", ["fetch", "--prune", "origin"], { cwd: workDir, allowFailure: true });
  await ghCheckoutPullRequest(pi, ref, workDir);
}

async function gitOutput(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  return (await runCli(pi, "git", args, { cwd, allowFailure: true })).trim();
}

type CwdReuseDecision =
  | { kind: "reuse"; workDir: string }
  | { kind: "use-tmpdir" }
  | { kind: "abort"; message: string };

async function evaluateCwdReuse(
  pi: ExtensionAPI,
  cwd: string,
  ref: PullRequestRef,
  view: PullRequestView,
): Promise<CwdReuseDecision> {
  const repoRoot = await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"]);
  if (repoRoot.length === 0) return { kind: "use-tmpdir" };

  const remoteUrl = await gitOutput(pi, repoRoot, ["remote", "get-url", "origin"]);
  const remote = remoteUrl.length > 0 ? parseGitRemoteUrl(remoteUrl) : null;
  if (remote == null) return { kind: "use-tmpdir" };
  if (remote.owner.toLowerCase() !== ref.owner.toLowerCase()) return { kind: "use-tmpdir" };
  if (remote.repo.toLowerCase() !== ref.repo.toLowerCase()) return { kind: "use-tmpdir" };

  const branch = await gitOutput(pi, repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== view.headRefName) return { kind: "use-tmpdir" };

  // Same repo + branch — from here we either reuse or abort.
  const head = await gitOutput(pi, repoRoot, ["rev-parse", "HEAD"]);
  if (head !== view.headRefOid) {
    return {
      kind: "abort",
      message: `Current directory is on branch \`${branch}\` at ${head.slice(0, 7)}, but PR head is ${view.headRefOid.slice(0, 7)}. Pull, push, or reset to match the PR before running, or run from a different directory.`,
    };
  }

  const dirty = await gitOutput(pi, repoRoot, ["status", "--porcelain"]);
  if (dirty.length > 0) {
    return {
      kind: "abort",
      message: "Current directory has uncommitted changes. Commit, stash, or discard them before reviewing the PR, or run from a different directory.",
    };
  }

  return { kind: "reuse", workDir: repoRoot };
}

async function resolveMergeBase(pi: ExtensionAPI, workDir: string, baseRefOid: string, headRefOid: string): Promise<string> {
  const stdout = await runCli(pi, "git", ["merge-base", baseRefOid, headRefOid], { cwd: workDir });
  return stdout.trim();
}

async function listChangedFiles(pi: ExtensionAPI, workDir: string, mergeBase: string, headRefOid: string): Promise<ChangedPath[]> {
  const stdout = await runCli(pi, "git", [
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
  const stdout = await runCli(pi, "git", ["ls-tree", "-r", "--name-only", headRefOid], { cwd: workDir });
  return parseLines(stdout).filter(isReviewableFilePath);
}

async function readBlob(pi: ExtensionAPI, workDir: string, revision: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: workDir });
  if (result.code !== 0) return "";
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Pure helpers (parse git output, classify paths, build review files).
// ---------------------------------------------------------------------------

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
  if (BINARY_EXTENSIONS.has(extname(fileName))) return false;
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

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
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

// ---------------------------------------------------------------------------
// High-level orchestration.
// ---------------------------------------------------------------------------

export async function preparePullRequest(pi: ExtensionAPI, ref: PullRequestRef, cwd: string): Promise<PreparedPullRequest> {
  await ensureGitHubAuth(pi);
  const view = await fetchPullRequestView(pi, ref);

  const decision = await evaluateCwdReuse(pi, cwd, ref, view);
  if (decision.kind === "abort") {
    throw new Error(decision.message);
  }

  let workDir: string;
  let reusedLocalCheckout: boolean;
  if (decision.kind === "reuse") {
    workDir = decision.workDir;
    reusedLocalCheckout = true;
    // Refresh refs so merge-base can find the base commit, but don't touch the working tree.
    await runCli(pi, "git", ["fetch", "--prune", "origin"], { cwd: workDir, allowFailure: true });
  } else {
    workDir = workDirFor(ref);
    reusedLocalCheckout = false;
    await ensureLocalClone(pi, ref, workDir);
    await syncPullRequestWorkdir(pi, ref, workDir);
  }

  const mergeBase = await resolveMergeBase(pi, workDir, view.baseRefOid, view.headRefOid);

  const info: PullRequestInfo = {
    ...view,
    mergeBase,
    baseOwner: ref.owner,
    baseRepo: ref.repo,
  };

  return { info, workDir, reusedLocalCheckout };
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
  const viewerLogin = await getViewerLogin(pi);

  return { pr: info, workDir, files, orphanThreads, viewerLogin };
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
