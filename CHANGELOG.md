# Changelog

All notable changes are documented here.


## docs/github-pr-code-review

Rebranded the project from pi-diff-review to pi-gh-code-review (#1) with comprehensive GitHub pull request review capabilities. The tool now resolves PRs via URL, shorthand, or interactive picker; clones/updates the base repository and integrates with `gh` CLI to fetch and render existing review comments inline as threads. Users can reply to threads directly, post inline comments to GitHub, or draft comments that flow into the final feedback prompt. The review window provides two scopes—PR diff and full head tree—with fuzzy file search, and supports macOS, Linux, and Windows with Node.js 20+.
