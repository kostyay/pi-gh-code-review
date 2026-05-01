# pi-gh-code-review

Native GitHub pull request review window for pi, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

```
pi install git:https://github.com/kostyay/pi-gh-code-review
```

## What it does

Adds a `/pr-review` command to pi.

The command:

1. resolves a GitHub PR. With no argument, falls back to the current branch's PR (looked up via the GitHub REST API by `head=owner:branch`) if one exists, otherwise shows a fuzzy-search TUI picker over the 10 most recent open PRs in the current repo. Also accepts a full PR URL or `owner/repo#N` as an argument
2. if the current directory is already a checkout of the same repo on the PR's head branch and is clean (HEAD matches the PR head, no uncommitted changes), reuses it directly — no clone, no checkout. Otherwise clones / updates the base repo into a reused temp directory under `$TMPDIR/pi-gh-code-review/<owner>-<repo>-<prNumber>` and fetches `refs/pull/N/head` into a local review branch. Aborts with an actionable message if the cwd is on the PR branch but has uncommitted changes or is out of sync with the PR head
3. opens a native review window with two scopes:
   - **PR diff** — files changed in the PR (merge-base..head)
   - **All files** — full PR head tree, for context
4. shows a collapsible sidebar with fuzzy file search and PR status markers
5. lazy-loads file contents on demand as you switch files and scopes
6. fetches existing PR review comments via the GitHub REST API and renders them inline as threads (matching GitHub's location, side, and reply structure). Outdated and file-level threads are surfaced in the file header strip
7. lets you reply to existing threads — posts to `POST /repos/{o}/{r}/pulls/{N}/comments/{id}/replies` and appends to the thread
8. lets you draft comments on the base side, head side, or whole file. For inline drafts, a **Post comment** button (or Cmd/Ctrl+Enter) posts the comment directly to GitHub via `POST /repos/{o}/{r}/pulls/{N}/comments`; otherwise the draft falls through to the prompt on Finish review
9. supports per-file controls: mark file reviewed, toggle word wrap, hide unchanged regions in the diff, and add file-level / overall PR notes
10. supports zoom — Cmd/Ctrl + `+`/`-`/`0` and Cmd/Ctrl + scroll wheel adjust UI scale (default 1.2×, persisted in `localStorage`)
11. inserts the resulting feedback prompt (including PR title and URL) into the pi editor when you submit, using any drafts that were not posted to GitHub

## Usage

```
/pr-review                               # interactive picker (uses gh pr list in cwd)
/pr-review https://github.com/o/r/pull/1
/pr-review owner/repo#42
```

## Inline commenting

- **Single line** — click the line number in the gutter (or the `+` icon that appears on hover).
- **Range** — click and drag down or up across line numbers; release to open the comment form below the last selected line. Same gesture as on github.com.
- **Edit / delete** — hover any of your own posted comments to reveal the pencil and trash icons in the top-right of the comment row.
- **Reply** — use the `Reply` button at the bottom of any existing thread.
- Code-text clicks are reserved for Monaco's text selection — they intentionally do not start a comment.

## Development & debugging

The review UI is a single inlined HTML+JS bundle (`web/index.html` + `web/app.js`) that's embedded into the Glimpse WebView at runtime. To debug it without spinning up pi or hitting GitHub, the repo ships a standalone test harness:

```
node scripts/serve-test.mjs            # serves the review page on http://localhost:5173
```

The harness:

- re-reads `web/index.html` and `web/app.js` on every request (no restart needed when iterating)
- injects mock `ReviewWindowData` (one file, two diffs) and stubs `window.glimpse.send` / `close` so messages are captured on `window.__sentMessages` instead of being sent to a host
- pre-seeds `state.fileContents` so the diff editor mounts immediately

Drive it with `agent-browser` / Playwright for headless interaction tests, e.g.:

```
agent-browser open http://localhost:5173/
agent-browser eval "diffEditor.getModifiedEditor().getDomNode().querySelectorAll('.line-numbers')[4].getBoundingClientRect()"
agent-browser mouse move <x> <y>
agent-browser mouse down left
agent-browser mouse up left
agent-browser eval "JSON.stringify(state.comments)"
```

This is the fastest way to repro and verify Monaco gutter / view-zone / decoration behaviour, since glimpseui's WebView does not expose devtools.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- [`gh` CLI](https://cli.github.com) installed and authenticated (`gh auth login`) — used solely to obtain the GitHub API token (`gh auth token`); all PR operations go directly to the GitHub REST API
- `git` on PATH
- internet access for the Tailwind and Monaco CDNs used by the review window

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
