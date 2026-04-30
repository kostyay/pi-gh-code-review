const reviewData = JSON.parse(document.getElementById("gh-review-data").textContent || "{}");

const state = {
  activeFileId: null,
  currentScope: reviewData.files.some((file) => file.inPrDiff) ? "pr-diff" : "all-files",
  comments: [],
  overallComment: "",
  hideUnchanged: false,
  wrapLines: true,
  collapsedDirs: {},
  reviewedFiles: {},
  scrollPositions: {},
  sidebarCollapsed: false,
  fileFilter: "",
  fileContents: {},
  fileErrors: {},
  pendingRequestIds: {},
  pendingPosts: {},
  postErrors: {},
  replyDrafts: {},
  pendingReplies: {},
};

const sidebarEl = document.getElementById("sidebar");
const sidebarTitleEl = document.getElementById("sidebar-title");
const sidebarSearchInputEl = document.getElementById("sidebar-search-input");
const toggleSidebarButton = document.getElementById("toggle-sidebar-button");
const scopePrDiffButton = document.getElementById("scope-pr-diff-button");
const scopeAllButton = document.getElementById("scope-all-button");
const windowTitleEl = document.getElementById("window-title");
const prMetaEl = document.getElementById("pr-meta");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const modeHintEl = document.getElementById("mode-hint");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");

const pr = reviewData.pr || {};
windowTitleEl.textContent = pr.number != null ? `PR #${pr.number} — ${pr.title || ""}` : "Review";
windowTitleEl.title = pr.url || "";
const metaParts = [];
if (pr.author) metaParts.push(`@${pr.author}`);
if (pr.headRefName && pr.baseRefName) metaParts.push(`${pr.headRefName} → ${pr.baseRefName}`);
if (pr.baseOwner && pr.baseRepo) metaParts.push(`${pr.baseOwner}/${pr.baseRepo}`);
if (pr.state) metaParts.push(pr.state.toLowerCase());
prMetaEl.textContent = metaParts.join(" • ");
prMetaEl.title = pr.url || "";

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;
let requestSequence = 0;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

const LANGUAGE_BY_EXT = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  sh: "shell",
  yml: "yaml", yaml: "yaml",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  py: "python",
  go: "go",
};

function inferLanguage(path) {
  if (!path) return "plaintext";
  const ext = path.toLowerCase().split(".").pop();
  return LANGUAGE_BY_EXT[ext] || "plaintext";
}

function scopeLabel(scope) {
  return scope === "pr-diff" ? "PR diff" : "All files";
}

function scopeHint(scope) {
  if (scope === "pr-diff") {
    return "Review changes in this pull request (merge-base..head). Hover or click line numbers in the gutter to add an inline comment.";
  }
  return "Browse the full PR head tree. Hover or click line numbers in the gutter to add a code review comment.";
}

function statusLabel(status) {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInlineMarkdown(text) {
  const escaped = escapeHtml(text || "");
  // Code blocks first
  let html = escaped.replace(/```([\s\S]*?)```/g, (_, body) => `<pre style="margin:6px 0;padding:8px 10px;background:rgba(110,118,129,0.4);border-radius:6px;overflow-x:auto;"><code style="background:transparent;padding:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;">${body}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, (_, body) => `<code>${body}</code>`);
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Bare URLs
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (match, prefix, url) => `${prefix}<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  return html;
}

const RELATIVE_TIME_UNITS = [
  { limit: 60, divisor: 1, suffix: null },          // <60s
  { limit: 3600, divisor: 60, suffix: "m" },
  { limit: 86400, divisor: 3600, suffix: "h" },
  { limit: 86400 * 30, divisor: 86400, suffix: "d" },
  { limit: 86400 * 365, divisor: 86400 * 30, suffix: "mo" },
  { limit: Infinity, divisor: 86400 * 365, suffix: "y" },
];

function formatRelativeTime(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const diff = (Date.now() - ms) / 1000;
  for (const unit of RELATIVE_TIME_UNITS) {
    if (diff >= unit.limit) continue;
    if (unit.suffix == null) return "just now";
    return `${Math.floor(diff / unit.divisor)}${unit.suffix} ago`;
  }
  return "";
}

function statusBadgeClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "deleted": return "text-[#f85149]";
    case "renamed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function isFileReviewed(fileId) {
  return state.reviewedFiles[fileId] === true;
}

function getScopedFiles() {
  if (state.currentScope === "pr-diff") {
    return reviewData.files.filter((file) => file.inPrDiff);
  }
  return reviewData.files.filter((file) => file.hasHeadFile);
}

function ensureActiveFileForScope() {
  const scopedFiles = getScopedFiles();
  if (scopedFiles.length === 0) {
    state.activeFileId = null;
    return;
  }
  if (scopedFiles.some((file) => file.id === state.activeFileId)) {
    return;
  }
  state.activeFileId = scopedFiles[0].id;
}

function activeFile() {
  return reviewData.files.find((file) => file.id === state.activeFileId) ?? null;
}

function getScopeComparison(file, scope = state.currentScope) {
  if (!file) return null;
  return scope === "pr-diff" ? file.prDiff : null;
}

function activeComparison() {
  return getScopeComparison(activeFile(), state.currentScope);
}

function activeFileShowsDiff() {
  return activeComparison() != null;
}

function getScopeFilePath(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.newPath || comparison?.oldPath || file?.path || "";
}

function getScopeDisplayPath(file, scope = state.currentScope) {
  const comparison = getScopeComparison(file, scope);
  return comparison?.displayPath || file?.path || "";
}

function getFileSearchPath(file) {
  return file?.path || "";
}

function getBaseName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function getActiveStatus(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.status ?? null;
}

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, "");
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = i;
    score += 10;

    if (i === previousMatchIndex + 1) {
      score += 8;
    }

    const previousChar = i > 0 ? candidate[i - 1] : "";
    if (i === 0 || previousChar === "/" || previousChar === "_" || previousChar === "-" || previousChar === ".") {
      score += 12;
    }

    previousMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return -1;
  if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
  return score;
}

function getFileSearchScore(query, file) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;

  const path = getFileSearchPath(file).toLowerCase();
  const baseName = getBaseName(path);
  const pathScore = scoreSubsequence(normalizedQuery, path);
  const baseScore = scoreSubsequence(normalizedQuery, baseName);
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);

  if (score < 0) return -1;
  if (baseName === normalizedQuery) score += 200;
  else if (baseName.startsWith(normalizedQuery)) score += 120;
  else if (path.includes(normalizedQuery)) score += 35;

  return score;
}

function getFilteredFiles() {
  const scopedFiles = getScopedFiles();
  const query = state.fileFilter.trim();
  if (!query) return [...scopedFiles];

  return scopedFiles
    .map((file) => ({ file, score: getFileSearchScore(query, file) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return getFileSearchPath(a.file).localeCompare(getFileSearchPath(b.file));
    })
    .map((entry) => entry.file);
}

function buildTree(files) {
  const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
  for (const file of files) {
    const path = getFileSearchPath(file);
    const parts = path.split("/");
    let node = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: new Map(),
          file: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
      if (isLeaf) node.file = file;
    }
  }
  return root;
}

function cacheKey(scope, fileId) {
  return `${scope}:${fileId}`;
}

function captureScrollState() {
  if (!diffEditor) return null;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  return {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreScrollState(scrollState) {
  if (!diffEditor || !scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function saveCurrentScrollPosition() {
  if (!state.activeFileId) return;
  const captured = captureScrollState();
  if (captured) state.scrollPositions[cacheKey(state.currentScope, state.activeFileId)] = captured;
}

function restoreFileScrollPosition() {
  if (!state.activeFileId) return;
  restoreScrollState(state.scrollPositions[cacheKey(state.currentScope, state.activeFileId)]);
}

function getRequestState(fileId, scope = state.currentScope) {
  const key = cacheKey(scope, fileId);
  return {
    contents: state.fileContents[key],
    error: state.fileErrors[key],
    requestId: state.pendingRequestIds[key],
  };
}

function ensureFileLoaded(fileId, scope = state.currentScope) {
  if (!fileId) return;
  const key = cacheKey(scope, fileId);
  if (state.fileContents[key] != null) return;
  if (state.fileErrors[key] != null) return;
  if (state.pendingRequestIds[key] != null) return;

  const requestId = `request:${Date.now()}:${++requestSequence}`;
  state.pendingRequestIds[key] = requestId;
  renderTree();
  if (window.glimpse?.send) {
    window.glimpse.send({ type: "request-file", requestId, fileId, scope });
  }
}

function openFile(fileId) {
  if (state.activeFileId === fileId) {
    ensureFileLoaded(fileId, state.currentScope);
    return;
  }
  saveCurrentScrollPosition();
  state.activeFileId = fileId;
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(fileId, state.currentScope);
}

function threadCommentCountFor(file) {
  if (state.currentScope !== "pr-diff") return 0;
  return (file.threads || []).reduce((acc, thread) => acc + (thread.comments?.length || 0), 0);
}

function getFileDisplayMeta(file) {
  const draftCount = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope).length;
  const requestState = getRequestState(file.id, state.currentScope);
  return {
    count: draftCount + threadCommentCountFor(file),
    reviewed: isFileReviewed(file.id),
    loading: requestState.requestId != null && requestState.contents == null,
    errored: requestState.error != null,
    status: getActiveStatus(file),
  };
}

function statusDotMarkup(meta) {
  const color = meta.reviewed ? "text-[#3fb950]" : meta.errored ? "text-red-400" : meta.loading ? "text-[#58a6ff]" : "text-transparent";
  const glyph = meta.reviewed ? "●" : meta.errored ? "!" : meta.loading ? "…" : "●";
  return `<span class="shrink-0 text-[10px] ${color}">${glyph}</span>`;
}

function countAndStatusMarkup(meta) {
  const countBadge = meta.count > 0
    ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${meta.count}</span>`
    : "";
  const statusBadge = meta.status
    ? `<span class="font-medium ${statusBadgeClass(meta.status)}">${escapeHtml(statusLabel(meta.status).charAt(0))}</span>`
    : "";
  return `${countBadge}${statusBadge}`;
}

function renderTreeNode(node, depth) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indentPx = 12;

  for (const child of children) {
    if (child.kind === "dir") {
      const collapsed = state.collapsedDirs[child.path] === true;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] text-[#c9d1d9] hover:bg-[#21262d]";
      row.style.paddingLeft = `${depth * indentPx + 8}px`;
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-[#8b949e] transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="truncate">${escapeHtml(child.name)}</span>
      `;
      row.addEventListener("click", () => {
        state.collapsedDirs[child.path] = !collapsed;
        renderTree();
      });
      fileTreeEl.appendChild(row);
      if (!collapsed) renderTreeNode(child, depth + 1);
      continue;
    }

    const file = child.file;
    const meta = getFileDisplayMeta(file);
    const isActive = file.id === state.activeFileId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[13px]",
      isActive ? "bg-[#373e47] text-white" : meta.reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
    ].join(" ");
    button.style.paddingLeft = `${(depth * indentPx) + 26}px`;
    button.innerHTML = `
      <span class="flex min-w-0 items-center gap-1.5 truncate ${isActive ? "font-medium" : ""}">
        ${statusDotMarkup(meta)}
        <span class="truncate">${escapeHtml(child.name)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${countAndStatusMarkup(meta)}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  }
}

function renderSearchResults(files) {
  files.forEach((file) => {
    const path = getFileSearchPath(file);
    const baseName = getBaseName(path);
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const meta = getFileDisplayMeta(file);
    const isActive = file.id === state.activeFileId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "group flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left",
      isActive ? "bg-[#373e47] text-white" : "text-[#c9d1d9] hover:bg-[#21262d]",
    ].join(" ");
    button.innerHTML = `
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          ${statusDotMarkup(meta)}
          <span class="truncate text-[13px] ${isActive ? "font-medium" : ""}">${escapeHtml(baseName)}</span>
        </span>
        <span class="mt-0.5 block truncate pl-[14px] text-[11px] ${isActive ? "text-[#c9d1d9]" : "text-review-muted"}">${escapeHtml(parentPath || path)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${countAndStatusMarkup(meta)}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  });
}

function updateSidebarLayout() {
  const collapsed = state.sidebarCollapsed;
  sidebarEl.style.width = collapsed ? "0px" : "280px";
  sidebarEl.style.minWidth = collapsed ? "0px" : "280px";
  sidebarEl.style.flexBasis = collapsed ? "0px" : "280px";
  sidebarEl.style.borderRightWidth = collapsed ? "0px" : "1px";
  sidebarEl.style.pointerEvents = collapsed ? "none" : "auto";
  toggleSidebarButton.textContent = collapsed ? "Show sidebar" : "Hide sidebar";
}

function updateScopeButtons() {
  const counts = {
    prDiff: reviewData.files.filter((file) => file.inPrDiff).length,
    all: reviewData.files.filter((file) => file.hasHeadFile).length,
  };

  const applyButtonClasses = (button, active, disabled) => {
    button.disabled = disabled;
    button.className = disabled
      ? "cursor-default rounded-md border border-review-border bg-[#11161d] px-2.5 py-1 text-[11px] font-medium text-review-muted opacity-60"
      : active
        ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-[11px] font-medium text-[#3fb950] hover:bg-[#238636]/25"
        : "cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-[11px] font-medium text-review-text hover:bg-[#21262d]";
  };

  scopePrDiffButton.textContent = `PR diff${counts.prDiff > 0 ? ` (${counts.prDiff})` : ""}`;
  scopeAllButton.textContent = `All files${counts.all > 0 ? ` (${counts.all})` : ""}`;

  applyButtonClasses(scopePrDiffButton, state.currentScope === "pr-diff", counts.prDiff === 0);
  applyButtonClasses(scopeAllButton, state.currentScope === "all-files", counts.all === 0);
}

function updateToggleButtons() {
  const file = activeFile();
  const reviewed = file ? isFileReviewed(file.id) : false;
  toggleReviewedButton.textContent = reviewed ? "Reviewed" : "Mark reviewed";
  toggleReviewedButton.className = reviewed
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]";
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  toggleUnchangedButton.textContent = state.hideUnchanged ? "Show full file" : "Show changed areas only";
  toggleUnchangedButton.style.display = activeFileShowsDiff() ? "inline-flex" : "none";
  updateScopeButtons();
  modeHintEl.textContent = scopeHint(state.currentScope);
  submitButton.disabled = false;
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    renderSideBySide: activeFileShowsDiff(),
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: activeFileShowsDiff() && state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function renderTree() {
  ensureActiveFileForScope();
  fileTreeEl.innerHTML = "";
  const scopedFiles = getScopedFiles();
  const visibleFiles = getFilteredFiles();

  if (visibleFiles.length === 0) {
    const message = state.fileFilter.trim()
      ? `No files match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>.`
      : `No files in <span class="text-review-text">${escapeHtml(scopeLabel(state.currentScope).toLowerCase())}</span>.`;
    fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        ${message}
      </div>
    `;
  } else if (state.fileFilter.trim()) {
    renderSearchResults(visibleFiles);
  } else {
    renderTreeNode(buildTree(visibleFiles), 0);
  }

  sidebarTitleEl.textContent = scopeLabel(state.currentScope);
  const drafts = state.comments.length;
  const totalThreads = state.currentScope === "pr-diff"
    ? reviewData.files.reduce((acc, file) => acc + (file.threads?.length || 0), 0) + (reviewData.orphanThreads?.length || 0)
    : 0;
  const filteredSuffix = state.fileFilter.trim() ? ` • ${visibleFiles.length} shown` : "";
  const threadsSuffix = totalThreads > 0 ? ` • ${totalThreads} existing thread${totalThreads === 1 ? "" : "s"}` : "";
  summaryEl.textContent = `${scopedFiles.length} file(s) • ${drafts} draft${drafts === 1 ? "" : "s"}${threadsSuffix}${state.overallComment ? " • overall note" : ""}${filteredSuffix}`;
  updateToggleButtons();
  updateSidebarLayout();
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showOverallCommentModal() {
  showTextModal({
    title: "Overall review note",
    description: "This note is prepended to the generated prompt above the inline comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      renderTree();
    },
  });
}

function showFileCommentModal() {
  const file = activeFile();
  if (!file) return;
  showTextModal({
    title: `File comment for ${getScopeDisplayPath(file, state.currentScope)}`,
    description: `This comment applies to the whole file in ${scopeLabel(state.currentScope).toLowerCase()}.`,
    initialValue: "",
    saveLabel: "Add comment",
    onSave: (value) => {
      if (!value) return;
      state.comments.push({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        fileId: file.id,
        scope: state.currentScope,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
      submitButton.disabled = false;
      updateCommentsUI();
    },
  });
}

function layoutEditor() {
  if (!diffEditor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  diffEditor.layout({ width, height });
}

function clearViewZones() {
  if (!diffEditor || activeViewZones.length === 0) return;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  activeViewZones = [];
}

function buildThreadCommentMarkup(comment) {
  const initial = (comment.author?.login || "?").charAt(0).toUpperCase();
  const avatarSrc = comment.author?.avatarUrl ? `<img src="${escapeAttr(comment.author.avatarUrl)}" alt="${escapeAttr(comment.author.login || "")}">` : escapeHtml(initial);
  const relative = formatRelativeTime(comment.createdAt);
  const timestamp = relative ? `<span title="${escapeAttr(comment.createdAt)}">${escapeHtml(relative)}</span>` : "";
  const link = comment.htmlUrl ? `<a href="${escapeAttr(comment.htmlUrl)}" target="_blank" rel="noopener noreferrer" style="color:#8b949e;">view</a>` : "";
  const sep = timestamp && link ? "·" : "";
  return `
    <div class="gh-thread-comment">
      <div class="gh-thread-avatar">${avatarSrc}</div>
      <div class="gh-thread-body">
        <div class="gh-thread-body-header">
          <span class="gh-thread-author">${escapeHtml(comment.author?.login || "unknown")}</span>
          ${timestamp}
          ${sep ? `<span>${sep}</span>` : ""}
          ${link}
        </div>
        <div class="gh-thread-body-text">${renderInlineMarkdown(comment.body || "")}</div>
      </div>
    </div>
  `;
}

function buildThreadHeaderMarkup(thread) {
  const sideLabel = thread.side === "base" ? "base" : "head";
  let location;
  if (thread.fileLevel) {
    location = `${escapeHtml(thread.path)} (file-level)`;
  } else if (thread.line == null) {
    location = `${escapeHtml(thread.path)} (line not in current diff)`;
  } else if (thread.startLine != null && thread.startLine !== thread.line) {
    location = `${escapeHtml(thread.path)}:${thread.startLine}-${thread.line} (${sideLabel})`;
  } else {
    location = `${escapeHtml(thread.path)}:${thread.line} (${sideLabel})`;
  }
  const replyCount = Math.max(0, (thread.comments?.length || 1) - 1);
  const repliesPart = replyCount > 0 ? `${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "";
  const badges = [];
  if (thread.outdated) badges.push(`<span class="gh-thread-badge outdated">Outdated</span>`);
  if (thread.fileLevel) badges.push(`<span class="gh-thread-badge">File</span>`);
  return `
    <div class="gh-thread-header">
      <div class="gh-thread-meta">
        <span>${location}</span>
        ${repliesPart ? `<span>· ${repliesPart}</span>` : ""}
      </div>
      <div class="gh-thread-meta">${badges.join("")}</div>
    </div>
  `;
}

function buildThreadReplyMarkup(thread) {
  const draft = state.replyDrafts[thread.id] ?? "";
  const open = draft.length > 0 || state.replyDraftOpen?.[thread.id] === true;
  const pending = state.pendingReplies[thread.id] === true;
  const error = state.postErrors[`reply:${thread.id}`] || "";
  if (!open) {
    return `
      <div class="gh-thread-reply-bar" style="padding:6px 12px;border-top:1px solid #21262d;background:#0d1117;display:flex;justify-content:flex-end;">
        <button data-action="open-reply" data-thread-id="${thread.id}" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]">Reply</button>
      </div>
    `;
  }
  return `
    <div class="gh-thread-reply" style="padding:8px 12px 10px 12px;border-top:1px solid #21262d;background:#0d1117;">
      <textarea data-action="reply-input" data-thread-id="${thread.id}" class="scrollbar-thin min-h-[60px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-xs text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Reply…">${escapeHtml(draft)}</textarea>
      ${error ? `<div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);color:#ffa198;font-size:11px;">${escapeHtml(error)}</div>` : ""}
      <div style="margin-top:6px;display:flex;justify-content:flex-end;gap:6px;">
        <button data-action="cancel-reply" data-thread-id="${thread.id}" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button data-action="post-reply" data-thread-id="${thread.id}" ${pending ? "disabled" : ""} class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-3 py-1 text-xs font-medium text-white hover:bg-[#2ea043] disabled:cursor-default disabled:opacity-60">${pending ? "Posting…" : "Reply"}</button>
      </div>
    </div>
  `;
}

function renderThreadDOM(thread) {
  const container = document.createElement("div");
  container.className = "gh-thread";
  const commentsHtml = (thread.comments || []).map(buildThreadCommentMarkup).join("");
  container.innerHTML = `${buildThreadHeaderMarkup(thread)}${commentsHtml}${buildThreadReplyMarkup(thread)}`;
  attachThreadHandlers(container, thread);
  return container;
}

function attachThreadHandlers(container, thread) {
  const openBtn = container.querySelector("[data-action='open-reply']");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      state.replyDraftOpen = state.replyDraftOpen || {};
      state.replyDraftOpen[thread.id] = true;
      state.replyDrafts[thread.id] = state.replyDrafts[thread.id] ?? "";
      updateCommentsUI();
    });
  }
  const cancelBtn = container.querySelector("[data-action='cancel-reply']");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      state.replyDraftOpen = state.replyDraftOpen || {};
      state.replyDraftOpen[thread.id] = false;
      delete state.replyDrafts[thread.id];
      delete state.postErrors[`reply:${thread.id}`];
      updateCommentsUI();
    });
  }
  const postBtn = container.querySelector("[data-action='post-reply']");
  if (postBtn) {
    postBtn.addEventListener("click", () => postReply(thread.id));
  }
  const input = container.querySelector("[data-action='reply-input']");
  if (input) {
    input.addEventListener("input", () => {
      state.replyDrafts[thread.id] = input.value;
      if (state.postErrors[`reply:${thread.id}`]) {
        delete state.postErrors[`reply:${thread.id}`];
        const err = container.querySelector(".gh-thread-reply div[style*='ffa198']");
        if (err) err.remove();
      }
    });
    input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        postReply(thread.id);
      }
    });
    setTimeout(() => input.focus(), 30);
  }
}

function estimateThreadHeight(thread) {
  const headerPx = 36;
  const padding = 12;
  let total = headerPx + padding;
  for (const comment of thread.comments || []) {
    const lines = String(comment.body || "").split(/\r?\n/).length;
    total += 56 + Math.max(0, lines - 1) * 18;
  }
  return total;
}


function canPostInline(comment) {
  if (comment.scope !== "pr-diff") return false;
  if (comment.side === "file") return false;
  if (comment.startLine == null) return false;
  const file = reviewData.files.find((entry) => entry.id === comment.fileId);
  if (!file || !file.prDiff) return false;
  const sideHasPath = comment.side === "original"
    ? file.prDiff.oldPath != null
    : file.prDiff.newPath != null;
  return sideHasPath;
}

function renderCommentDOM(comment, onDelete) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  const title = comment.side === "file"
    ? `File comment • ${scopeLabel(comment.scope)}`
    : `${comment.side === "original" ? "Base" : "Head"} line ${comment.startLine} • ${scopeLabel(comment.scope)}`;

  const postable = canPostInline(comment);
  const pending = state.pendingPosts[comment.id] === true;
  const postError = state.postErrors[comment.id] || "";

  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <div class="flex items-center gap-1">
        ${postable ? `<button data-action="post" ${pending ? "disabled" : ""} class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-2 py-1 text-xs font-medium text-white hover:bg-[#2ea043] disabled:cursor-default disabled:opacity-60">${pending ? "Posting…" : "Post comment"}</button>` : ""}
        <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
      </div>
    </div>
    <textarea data-comment-id="${escapeAttr(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
    ${postError ? `<div class="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">${escapeHtml(postError)}</div>` : ""}
    ${postable ? `<div class="mt-1 text-[10px] text-review-muted">Tip: Cmd/Ctrl+Enter posts to GitHub. Use “Finish review” to send all unposted drafts to the pi editor.</div>` : ""}
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
    if (state.postErrors[comment.id]) {
      delete state.postErrors[comment.id];
      const err = container.querySelector(".text-red-300");
      if (err) err.remove();
    }
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && postable) {
      event.preventDefault();
      postInlineDraft(comment);
    }
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  const postButton = container.querySelector("[data-action='post']");
  if (postButton) {
    postButton.addEventListener("click", () => postInlineDraft(comment));
  }
  if (!comment.body) setTimeout(() => textarea.focus(), 50);
  return container;
}

function postInlineDraft(comment) {
  if (!canPostInline(comment)) return;
  if (state.pendingPosts[comment.id]) return;
  const body = (comment.body || "").trim();
  if (body.length === 0) {
    state.postErrors[comment.id] = "Comment body cannot be empty.";
    updateCommentsUI();
    return;
  }
  state.pendingPosts[comment.id] = true;
  delete state.postErrors[comment.id];
  if (window.glimpse?.send) {
    window.glimpse.send({
      type: "post-comment",
      clientId: comment.id,
      fileId: comment.fileId,
      side: comment.side === "original" ? "base" : "head",
      line: comment.startLine,
      body,
    });
  }
  updateCommentsUI();
}

function postReply(threadId) {
  const draft = state.replyDrafts[threadId];
  if (draft == null) return;
  const body = String(draft).trim();
  if (body.length === 0) {
    state.postErrors[`reply:${threadId}`] = "Reply cannot be empty.";
    updateCommentsUI();
    return;
  }
  if (state.pendingReplies[threadId]) return;
  const fileId = findFileIdForThread(threadId);
  state.pendingReplies[threadId] = true;
  delete state.postErrors[`reply:${threadId}`];
  if (window.glimpse?.send) {
    window.glimpse.send({
      type: "post-reply",
      clientId: `reply:${threadId}`,
      fileId: fileId || "",
      threadId,
      body,
    });
  }
  updateCommentsUI();
}

function findFileIdForThread(threadId) {
  for (const file of reviewData.files) {
    if ((file.threads || []).some((thread) => thread.id === threadId)) return file.id;
  }
  return null;
}

function canCommentOnSide(file, side) {
  if (!file) return false;
  const comparison = activeComparison();
  if (side === "original") {
    return comparison != null && comparison.hasOriginal;
  }
  return comparison != null ? comparison.hasModified : file.hasHeadFile;
}

function isActiveFileReady() {
  const file = activeFile();
  if (!file) return false;
  const requestState = getRequestState(file.id, state.currentScope);
  return requestState.contents != null && requestState.error == null;
}

function getInlineThreadsForFile(file) {
  if (state.currentScope !== "pr-diff") return [];
  return (file.threads || []).filter((thread) => !thread.outdated && !thread.fileLevel && thread.line != null);
}

function getNonInlineThreadsForFile(file) {
  if (state.currentScope !== "pr-diff") return [];
  return (file.threads || []).filter((thread) => thread.outdated || thread.fileLevel || thread.line == null);
}

function syncViewZones() {
  clearViewZones();
  if (!diffEditor || !isActiveFileReady()) return;
  const file = activeFile();
  if (!file) return;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && comment.side !== "file");

  inlineComments.forEach((item) => {
    const editor = item.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(item, () => {
      state.comments = state.comments.filter((comment) => comment.id !== item.id);
      updateCommentsUI();
    });

    editor.changeViewZones((accessor) => {
      const lineCount = typeof item.body === "string" && item.body.length > 0 ? item.body.split("\n").length : 1;
      const id = accessor.addZone({
        afterLineNumber: item.startLine,
        heightInPx: Math.max(150, lineCount * 22 + 86),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });

  const inlineThreads = getInlineThreadsForFile(file);
  inlineThreads.forEach((thread) => {
    const editor = thread.side === "base" ? originalEditor : modifiedEditor;
    const domNode = renderThreadDOM(thread);
    editor.changeViewZones((accessor) => {
      const id = accessor.addZone({
        afterLineNumber: thread.line,
        heightInPx: estimateThreadHeight(thread),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });
}

function updateDecorations() {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  const comments = file ? state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && comment.side !== "file") : [];
  const originalRanges = [];
  const modifiedRanges = [];

  for (const comment of comments) {
    const range = {
      range: new monacoApi.Range(comment.startLine, 1, comment.startLine, 1),
      options: {
        isWholeLine: true,
        className: comment.side === "original" ? "review-comment-line-original" : "review-comment-line-modified",
        glyphMarginClassName: comment.side === "original" ? "review-comment-glyph-original" : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  if (file) {
    const inlineThreads = getInlineThreadsForFile(file);
    for (const thread of inlineThreads) {
      const startLine = thread.startLine ?? thread.line;
      const endLine = thread.line;
      const range = {
        range: new monacoApi.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          className: thread.side === "base" ? "gh-thread-line-original" : "gh-thread-line-modified",
          glyphMarginClassName: "gh-thread-glyph",
        },
      };
      if (thread.side === "base") originalRanges.push(range);
      else modifiedRanges.push(range);
    }
  }

  originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, originalRanges);
  modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modifiedRanges);
}

function renderFileComments() {
  fileCommentsContainer.innerHTML = "";
  const file = activeFile();
  if (!file) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  const fileComments = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && comment.side === "file");
  const nonInlineThreads = getNonInlineThreadsForFile(file);

  if (fileComments.length === 0 && nonInlineThreads.length === 0) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileCommentsContainer.className = "border-b border-review-border bg-[#0d1117] px-4 py-4 space-y-4";

  fileComments.forEach((comment) => {
    const dom = renderCommentDOM(comment, () => {
      state.comments = state.comments.filter((item) => item.id !== comment.id);
      updateCommentsUI();
    });
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  });

  nonInlineThreads.forEach((thread) => {
    const dom = renderThreadDOM(thread);
    dom.style.margin = "0";
    fileCommentsContainer.appendChild(dom);
  });
}

function getPlaceholderContents(file, scope) {
  const path = getScopeDisplayPath(file, scope);
  const requestState = getRequestState(file.id, scope);
  if (requestState.error) {
    const body = `Failed to load ${path}\n\n${requestState.error}`;
    return { originalContent: body, modifiedContent: body };
  }
  const body = `Loading ${path}...`;
  return { originalContent: body, modifiedContent: body };
}

function getMountedContents(file, scope = state.currentScope) {
  return getRequestState(file.id, scope).contents || getPlaceholderContents(file, scope);
}

function mountFile(options = {}) {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  if (!file) {
    currentFileLabelEl.textContent = "No file selected";
    clearViewZones();
    if (originalModel) originalModel.dispose();
    if (modifiedModel) modifiedModel.dispose();
    originalModel = monacoApi.editor.createModel("", "plaintext");
    modifiedModel = monacoApi.editor.createModel("", "plaintext");
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    applyEditorOptions();
    updateDecorations();
    renderFileComments();
    requestAnimationFrame(layoutEditor);
    return;
  }

  ensureFileLoaded(file.id, state.currentScope);

  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll ? captureScrollState() : null;
  const language = inferLanguage(getScopeFilePath(file) || file.path);
  const contents = getMountedContents(file, state.currentScope);

  clearViewZones();
  currentFileLabelEl.textContent = getScopeDisplayPath(file, state.currentScope);

  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();

  originalModel = monacoApi.editor.createModel(contents.originalContent, language);
  modifiedModel = monacoApi.editor.createModel(contents.modifiedContent, language);

  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  applyEditorOptions();
  syncViewZones();
  updateDecorations();
  renderFileComments();
  const applyScroll = () => {
    layoutEditor();
    if (options.restoreFileScroll) restoreFileScrollPosition();
    if (options.preserveScroll) restoreScrollState(scrollState);
  };
  requestAnimationFrame(() => {
    applyScroll();
    setTimeout(applyScroll, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) comment.body = textarea.value;
  });
}

function updateCommentsUI() {
  renderTree();
  syncViewZones();
  updateDecorations();
  renderFileComments();
}

function renderAll(options = {}) {
  renderTree();
  submitButton.disabled = false;
  if (diffEditor && monacoApi) {
    mountFile(options);
    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
    });
  } else {
    renderFileComments();
  }
}

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;
    state.comments.push({
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: file.id,
      scope: state.currentScope,
      side,
      startLine: line,
      endLine: line,
      body: "",
    });
    updateCommentsUI();
    editor.revealLineInCenter(line);
  }

  editor.onMouseMove((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
      return;
    }

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [{
        range: new monacoApi.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" },
      }]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

function mergeUpdatedThread(fileId, thread) {
  const file = reviewData.files.find((entry) => entry.id === fileId);
  if (!file) {
    reviewData.orphanThreads = reviewData.orphanThreads || [];
    const existingIdx = reviewData.orphanThreads.findIndex((t) => t.id === thread.id);
    if (existingIdx >= 0) reviewData.orphanThreads[existingIdx] = thread;
    else reviewData.orphanThreads.push(thread);
    return;
  }
  file.threads = file.threads || [];
  const idx = file.threads.findIndex((t) => t.id === thread.id);
  if (idx >= 0) file.threads[idx] = thread;
  else file.threads.push(thread);
}

window.__reviewReceive = function (message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "thread-updated") {
    const clientId = message.clientId;
    mergeUpdatedThread(message.fileId, message.thread);
    if (state.pendingPosts[clientId]) {
      delete state.pendingPosts[clientId];
      delete state.postErrors[clientId];
      state.comments = state.comments.filter((comment) => comment.id !== clientId);
    }
    if (clientId && clientId.startsWith("reply:")) {
      const threadId = Number(clientId.slice("reply:".length));
      delete state.pendingReplies[threadId];
      delete state.postErrors[clientId];
      delete state.replyDrafts[threadId];
      if (state.replyDraftOpen) state.replyDraftOpen[threadId] = false;
    }
    const scrollState = captureScrollState();
    updateCommentsUI();
    if (scrollState) restoreScrollState(scrollState);
    return;
  }

  if (message.type === "post-error") {
    const clientId = message.clientId;
    if (clientId && clientId.startsWith("reply:")) {
      const threadId = Number(clientId.slice("reply:".length));
      delete state.pendingReplies[threadId];
      state.postErrors[clientId] = message.message || "Failed to post reply.";
    } else if (clientId) {
      delete state.pendingPosts[clientId];
      state.postErrors[clientId] = message.message || "Failed to post comment.";
    }
    updateCommentsUI();
    return;
  }

  const key = cacheKey(message.scope, message.fileId);

  if (message.type === "file-data") {
    state.fileContents[key] = {
      originalContent: message.originalContent,
      modifiedContent: message.modifiedContent,
    };
    delete state.fileErrors[key];
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope) {
      mountFile({ restoreFileScroll: true });
    }
    return;
  }

  if (message.type === "file-error") {
    state.fileErrors[key] = message.message || "Unknown error";
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope) {
      mountFile({ preserveScroll: false });
    }
  }
};

function setupMonaco() {
  window.require.config({
    paths: {
      vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    },
  });

  window.require(["vs/editor/editor.main"], function () {
    monacoApi = window.monaco;

    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
      },
    });
    monacoApi.editor.setTheme("review-dark");

    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: activeFileShowsDiff(),
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
    });

    createGlyphHoverActions(diffEditor.getOriginalEditor(), "original");
    createGlyphHoverActions(diffEditor.getModifiedEditor(), "modified");

    if (typeof ResizeObserver !== "undefined") {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    mountFile();
  });
}

function switchScope(scope) {
  const hasScopeFiles = {
    "pr-diff": reviewData.files.some((file) => file.inPrDiff),
    "all-files": reviewData.files.some((file) => file.hasHeadFile),
  };
  if (!hasScopeFiles[scope] || state.currentScope === scope) return;
  saveCurrentScrollPosition();
  state.currentScope = scope;
  renderAll({ restoreFileScroll: true });
  const file = activeFile();
  if (file) ensureFileLoaded(file.id, state.currentScope);
}

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  const payload = {
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: state.comments
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
  };
  window.glimpse.send(payload);
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

overallCommentButton.addEventListener("click", () => {
  showOverallCommentModal();
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

toggleUnchangedButton.addEventListener("click", () => {
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(layoutEditor);
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

toggleReviewedButton.addEventListener("click", () => {
  const file = activeFile();
  if (!file) return;
  state.reviewedFiles[file.id] = !isFileReviewed(file.id);
  renderTree();
});

scopePrDiffButton.addEventListener("click", () => {
  switchScope("pr-diff");
});

scopeAllButton.addEventListener("click", () => {
  switchScope("all-files");
});

toggleSidebarButton.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  updateSidebarLayout();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

sidebarSearchInputEl.addEventListener("input", () => {
  state.fileFilter = sidebarSearchInputEl.value;
  renderTree();
});

sidebarSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    sidebarSearchInputEl.value = "";
    state.fileFilter = "";
    renderTree();
  }
});

ensureActiveFileForScope();
renderTree();
renderFileComments();
updateSidebarLayout();
setupMonaco();
