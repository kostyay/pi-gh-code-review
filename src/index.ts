import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import {
  getReviewWindowData,
  listOpenPullRequests,
  loadReviewFileContents,
  parsePullRequestSpec,
  postCommentReply,
  postLineComment,
  preparePullRequest,
  type PullRequestRef,
} from "./pr.js";
import { composeReviewPrompt } from "./prompt.js";
import type {
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

function formatPullRequestOption(pr: PullRequestSummary): string {
  return `#${pr.number}  ${pr.title}  —  @${pr.author}  (${pr.headRefName} → ${pr.baseRefName})`;
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

  let summaries: PullRequestSummary[];
  try {
    summaries = await listOpenPullRequests(pi, ctx.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message, "error");
    return null;
  }

  if (summaries.length === 0) {
    ctx.ui.notify("No open pull requests found in the current repository.", "info");
    return null;
  }

  const labels = summaries.map(formatPullRequestOption);
  const choice = await ctx.ui.select("Select a pull request to review", labels);
  if (choice == null) return null;
  const index = labels.indexOf(choice);
  if (index < 0) return null;
  const selected = summaries[index];
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

    ctx.ui.notify(`Fetching PR #${ref.number} from ${ref.owner}/${ref.repo}...`, "info");

    let prepared;
    try {
      prepared = await preparePullRequest(pi, ref);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to prepare PR: ${message}`, "error");
      return;
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

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"]): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, data, file, scope);
      contentCache.set(cacheKey, pending);
      return pending;
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

        const prRef: PullRequestRef = {
          owner: data.pr.baseOwner,
          repo: data.pr.baseRepo,
          number: data.pr.number,
        };

        const sendPostError = (clientId: string, error: unknown): void => {
          const text = error instanceof Error ? error.message : String(error);
          sendWindowMessage({ type: "post-error", clientId, message: text });
        };

        const handlePostComment = async (message: ReviewPostCommentPayload): Promise<void> => {
          const file = data.files.find((entry) => entry.id === message.fileId);
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

        const findThreadOwner = (threadId: number): { file: ReviewFile | null; thread: typeof data.files[number]["threads"][number] | null } => {
          for (const file of data.files) {
            const thread = file.threads.find((t) => t.id === threadId);
            if (thread != null) return { file, thread };
          }
          const orphan = data.orphanThreads.find((t) => t.id === threadId) ?? null;
          return { file: null, thread: orphan };
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

  pi.registerCommand("github-code-review", {
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
