#!/usr/bin/env node
// Build the review HTML with mock data and serve it on a local port for
// playwright/agent-browser debugging.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function escapeForInlineScript(value) {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const sampleOriginal = Array.from({ length: 60 }, (_, i) => `// original line ${i + 1}`).join("\n");
const sampleModified = Array.from({ length: 60 }, (_, i) => {
  if (i === 4) return `// modified line 5 — changed`;
  if (i === 5) return `// modified line 6 — changed`;
  if (i === 12) return `// modified line 13 — changed`;
  return `// original line ${i + 1}`;
}).join("\n");

const data = {
  pr: {
    url: "https://example.com/pr/1",
    number: 1,
    title: "Test PR",
    body: "",
    author: "kostyay",
    state: "OPEN",
    headRefName: "feat/test",
    baseRefName: "main",
    headRefOid: "deadbeef",
    baseRefOid: "cafef00d",
    mergeBase: "cafef00d",
    baseOwner: "torqio",
    baseRepo: "test",
    isCrossRepository: false,
  },
  workDir: "/tmp",
  files: [
    {
      id: "file-1",
      path: "src/example.ts",
      inPrDiff: true,
      hasHeadFile: true,
      prDiff: {
        status: "modified",
        oldPath: "src/example.ts",
        newPath: "src/example.ts",
        displayPath: "src/example.ts",
        hasOriginal: true,
        hasModified: true,
      },
      threads: [],
    },
  ],
  orphanThreads: [],
  viewerLogin: "kostyay",
  // Inline content for the test harness so the editor can mount without an
  // explicit request-file round-trip.
  __testFileContents: {
    "pr-diff:file-1": {
      originalContent: sampleOriginal,
      modifiedContent: sampleModified,
    },
  },
};

// Inject a test shim that pre-fills fileContents and a mock window.glimpse.
const testShim = `
window.glimpse = {
  send: (msg) => { console.log("[glimpse.send]", JSON.stringify(msg)); window.__sentMessages = window.__sentMessages || []; window.__sentMessages.push(msg); },
  close: () => { console.log("[glimpse.close]"); },
};
const __testContents = (window.reviewData && window.reviewData.__testFileContents) || (JSON.parse(document.getElementById("gh-review-data").textContent || "{}").__testFileContents || {});
window.__seedTestContents = function() {
  Object.entries(__testContents).forEach(([key, value]) => {
    if (typeof state !== "undefined" && state.fileContents) state.fileContents[key] = value;
  });
};
`;

function renderHtml() {
  // Re-read on every request so source edits show up without restarting the server.
  const templateHtml = readFileSync(join(root, "web/index.html"), "utf8");
  const appJs = readFileSync(join(root, "web/app.js"), "utf8");
  return templateHtml
    .replace("__INLINE_DATA__", escapeForInlineScript(JSON.stringify(data)))
    .replace("__INLINE_JS__", `${testShim}\n${appJs}\nwindow.__seedTestContents && window.__seedTestContents();\nif (typeof renderAll === "function") renderAll();`);
}

const PORT = Number(process.env.PORT || 5173);
createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderHtml());
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`Test review server listening on http://localhost:${PORT}`);
});
