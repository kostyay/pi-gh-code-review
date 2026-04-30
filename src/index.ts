import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { fuzzyFilter, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import {
  getCurrentBranchPullRequestUrl,
  listOpenPullRequests,
  postCommentReply,
  postLineComment,
} from "./gh.js";
import {
  getReviewWindowData,
  loadReviewFileContents,
  parsePullRequestSpec,
  preparePullRequest,
} from "./pr.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
  PrReviewThread,
  PullRequestRef,
  PullRequestSummary,
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewPostCommentPayload,
  ReviewPostReplyPayload,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

type WaitingEditorResult = "escape" | "window-settled";

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

interface PrPickEntry {
  pr: PullRequestSummary;
  haystack: string;
}

function isPrintableInput(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

async function pickPullRequestInteractively(
  ctx: ExtensionCommandContext,
  summaries: PullRequestSummary[],
): Promise<PullRequestSummary | null> {
  const entries: PrPickEntry[] = summaries.map((pr) => ({
    pr,
    haystack: `#${pr.number} ${pr.title} ${pr.author} ${pr.headRefName} ${pr.baseRefName}`,
  }));

  return ctx.ui.custom<PullRequestSummary | null>((_tui, theme, _kb, done) => {
    let query = "";
    let filtered = entries;
    let selectedIdx = 0;

    const refilter = (): void => {
      filtered = query.length === 0 ? entries : fuzzyFilter(entries, query, (entry) => entry.haystack);
      selectedIdx = filtered.length === 0 ? 0 : Math.min(selectedIdx, filtered.length - 1);
    };

    const move = (delta: number): void => {
      if (filtered.length === 0) return;
      selectedIdx = (selectedIdx + delta + filtered.length) % filtered.length;
    };

    return {
      render(width: number): string[] {
        const lines: string[] = [
          theme.fg("accent", theme.bold(`Select pull request (${summaries.length} open)`)),
          theme.fg("muted", "Type to filter • ↑↓ navigate • Enter select • Esc cancel"),
          `${theme.fg("accent", "›")} ${query.length === 0 ? theme.fg("muted", "type to filter…") : query}`,
          "",
        ];

        if (filtered.length === 0) {
          lines.push(theme.fg("muted", "  No matches."));
          return lines;
        }

        const innerWidth = Math.max(20, width - 4);
        filtered.forEach((entry, i) => {
          const selected = i === selectedIdx;
          const marker = selected ? theme.fg("accent", "▌ ") : "  ";
          const label = `#${entry.pr.number}  ${entry.pr.title}`;
          const truncatedLabel = truncateToWidth(label, innerWidth, "…", true);
          lines.push(`${marker}${selected ? theme.bold(truncatedLabel) : truncatedLabel}`);
          const meta = `    @${entry.pr.author}  ${entry.pr.headRefName} → ${entry.pr.baseRefName}`;
          lines.push(theme.fg("muted", truncateToWidth(meta, Math.max(20, width - 2), "…", true)));
        });
        return lines;
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) { done(null); return; }
        if (matchesKey(data, Key.enter)) {
          done(filtered.length > 0 ? filtered[selectedIdx].pr : null);
          return;
        }
        if (matchesKey(data, Key.up)) { move(-1); return; }
        if (matchesKey(data, Key.down)) { move(1); return; }
        if (matchesKey(data, Key.backspace)) {
          if (query.length > 0) {
            query = query.slice(0, -1);
            refilter();
          }
          return;
        }
        if (isPrintableInput(data)) {
          query += data;
          refilter();
        }
      },
      invalidate(): void {},
    };
  });
}

async function resolvePullRequestSpec(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<PullRequestRef | null> {
  const trimmed = args.trim();
  if (trimmed.length > 0) {
    const parsed = parsePullRequestSpec(trimmed);
    if (parsed == null) {
      ctx.ui.notify("Could not parse PR. Provide a GitHub PR URL or owner/repo#number.", "error");
      return null;
    }
    return parsed;
  }

  const currentBranchUrl = await getCurrentBranchPullRequestUrl(pi, ctx.cwd);
  if (currentBranchUrl != null) {
    const parsed = parsePullRequestSpec(currentBranchUrl);
    if (parsed != null) {
      ctx.ui.notify(`Using PR for current branch: #${parsed.number} (${parsed.owner}/${parsed.repo})`, "info");
      return parsed;
    }
  }

  let summaries: PullRequestSummary[];
  try {
    summaries = await listOpenPullRequests(pi, ctx.cwd, 10);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return null;
  }

  if (summaries.length === 0) {
    ctx.ui.notify("No open pull requests found in the current repository.", "info");
    return null;
  }

  const selected = await pickPullRequestInteractively(ctx, summaries);
  if (selected == null) return null;
  const parsed = parsePullRequestSpec(selected.url);
  if (parsed == null) {
    ctx.ui.notify(`Could not parse PR url: ${selected.url}`, "error");
    return null;
  }
  return parsed;
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewPullRequest(ctx: ExtensionCommandContext, args: string): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    const ref = await resolvePullRequestSpec(pi, ctx, args);
    if (ref == null) return;

    ctx.ui.notify(`Loading PR #${ref.number} from ${ref.owner}/${ref.repo}...`, "info");

    let prepared;
    try {
      prepared = await preparePullRequest(pi, ref, ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to prepare PR: ${message}`, "error");
      return;
    }

    if (prepared.reusedLocalCheckout) {
      ctx.ui.notify("Using current directory checkout (no clone needed).", "info");
    }

    const data = await getReviewWindowData(pi, prepared);
    if (data.files.length === 0) {
      ctx.ui.notify("No reviewable files found in this PR.", "info");
      return;
    }

    const html = buildReviewHtml(data);
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: `PR #${data.pr.number} — ${data.pr.title}`,
    });
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(data.files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();
    const prRef: PullRequestRef = {
      owner: data.pr.baseOwner,
      repo: data.pr.baseRepo,
      number: data.pr.number,
    };

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const sendPostError = (clientId: string, error: unknown): void => {
      const text = error instanceof Error ? error.message : String(error);
      sendWindowMessage({ type: "post-error", clientId, message: text });
    };

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"]): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, data, file, scope);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    const findThreadOwner = (threadId: number): { file: ReviewFile | null; thread: PrReviewThread | null } => {
      for (const file of data.files) {
        const thread = file.threads.find((t) => t.id === threadId);
        if (thread != null) return { file, thread };
      }
      return { file: null, thread: data.orphanThreads.find((t) => t.id === threadId) ?? null };
    };

    const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
      const file = fileMap.get(message.fileId);
      if (file == null) {
        sendWindowMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          message: "Unknown file requested.",
        });
        return;
      }

      try {
        const contents = await loadContents(file, message.scope);
        sendWindowMessage({
          type: "file-data",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          originalContent: contents.originalContent,
          modifiedContent: contents.modifiedContent,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        sendWindowMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          message: messageText,
        });
      }
    };

    const handlePostComment = async (message: ReviewPostCommentPayload): Promise<void> => {
      const file = fileMap.get(message.fileId);
      if (file == null) {
        sendWindowMessage({ type: "post-error", clientId: message.clientId, message: "Unknown file." });
        return;
      }
      const path = message.side === "head"
        ? file.prDiff?.newPath ?? file.path
        : file.prDiff?.oldPath ?? file.path;
      if (path == null) {
        sendWindowMessage({ type: "post-error", clientId: message.clientId, message: "No path available for this side." });
        return;
      }
      try {
        const thread = await postLineComment(pi, prRef, {
          path,
          side: message.side,
          line: message.line,
          body: message.body,
          commitSha: data.pr.headRefOid,
        });
        file.threads.push(thread);
        sendWindowMessage({ type: "thread-updated", clientId: message.clientId, fileId: file.id, thread });
      } catch (error) {
        sendPostError(message.clientId, error);
      }
    };

    const handlePostReply = async (message: ReviewPostReplyPayload): Promise<void> => {
      const { file, thread } = findThreadOwner(message.threadId);
      if (thread == null) {
        sendWindowMessage({ type: "post-error", clientId: message.clientId, message: "Thread not found." });
        return;
      }
      try {
        const comment = await postCommentReply(pi, prRef, message.threadId, message.body);
        thread.comments.push(comment);
        sendWindowMessage({
          type: "thread-updated",
          clientId: message.clientId,
          fileId: file?.id ?? message.fileId,
          thread,
        });
      } catch (error) {
        sendPostError(message.clientId, error);
      }
    };

    ctx.ui.notify(`Opened review window for PR #${data.pr.number}.`, "info");

    try {
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const onMessage = (raw: unknown): void => {
          const message = raw as ReviewWindowMessage;
          switch (message.type) {
            case "request-file":
              void handleRequestFile(message);
              return;
            case "post-comment":
              void handlePostComment(message);
              return;
            case "post-reply":
              void handlePostReply(message);
              return;
            case "submit":
            case "cancel":
              settle(message);
              return;
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(data.pr, data.files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("pr-review", {
    description: "Open a native review window for a GitHub pull request (URL, owner/repo#N, or interactive picker)",
    handler: async (args, ctx) => {
      await reviewPullRequest(ctx, args);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
