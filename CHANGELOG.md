# Changelog

All notable changes are documented here.



## docs/update-command-docs

Renamed the command from `/github-code-review` to `/pr-review` and significantly enhanced GitHub API integration (#2). Introduced rate-limit-aware REST API calls via a new `gh.ts` module, replacing direct `gh` CLI invocations for improved reliability and performance. The PR resolution logic now intelligently reuses the current directory if it's already a clean checkout of the PR's head branch, falling back to a fuzzy-search TUI picker over recent PRs when no argument is provided. Added client-side UI features including per-file controls (mark reviewed, word wrap toggle, diff folding), keyboard-driven zoom support (Cmd/Ctrl + `+`/`-`/`0` with localStorage persistence), and improved file navigation in the sidebar.

## docs/github-pr-code-review

Rebranded the project from pi-diff-review to pi-gh-code-review (#1) with comprehensive GitHub pull request review capabilities. The tool now resolves PRs via URL, shorthand, or interactive picker; clones/updates the base repository and integrates with `gh` CLI to fetch and render existing review comments inline as threads. Users can reply to threads directly, post inline comments to GitHub, or draft comments that flow into the final feedback prompt. The review window provides two scopes—PR diff and full head tree—with fuzzy file search, and supports macOS, Linux, and Windows with Node.js 20+.
