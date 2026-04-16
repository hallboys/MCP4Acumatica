// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { marked } from "marked";
import type { Env } from "../types/acumatica";
import { adminApp } from "../admin/admin-handler";

// Import markdown files as text modules (wrangler Text rule)
import readmeContent from "../../README.md";
import toolRefContent from "../../docs/tool-reference.md";
import examplePromptsContent from "../../docs/example-prompts.md";
import odataContent from "../../docs/odata-filtering.md";
import architectureContent from "../../docs/architecture.md";
import selfHostingContent from "../../docs/self-hosting-guide.md";

interface DocPage {
  slug: string;
  title: string;
  content: string;
}

const pages: DocPage[] = [
  { slug: "", title: "Overview", content: readmeContent },
  { slug: "tool-reference", title: "Tool Reference", content: toolRefContent },
  { slug: "example-prompts", title: "Example Prompts", content: examplePromptsContent },
  { slug: "odata-filtering", title: "OData Filtering", content: odataContent },
  { slug: "architecture", title: "Architecture", content: architectureContent },
  { slug: "self-hosting-guide", title: "Self-Hosting", content: selfHostingContent },
];

function renderNav(activeSlug: string): string {
  return pages
    .map((p) => {
      const href = p.slug === "" ? "/docs" : `/docs/${p.slug}`;
      const active = p.slug === activeSlug ? ' class="active"' : "";
      return `<a href="${href}"${active}>${p.title}</a>`;
    })
    .join("\n        ");
}

function renderPage(slug: string, html: string): string {
  const page = pages.find((p) => p.slug === slug);
  const title = page ? page.title : "Docs";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - MCP4Acumatica</title>
  <style>
    :root {
      --bg: #fafafa;
      --surface: #ffffff;
      --text: #1a1a2e;
      --text-muted: #555;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --border: #e2e8f0;
      --code-bg: #f1f5f9;
      --nav-bg: #1e293b;
      --nav-text: #cbd5e1;
      --nav-active: #ffffff;
      --table-stripe: #f8fafc;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--text);
      background: var(--bg);
      line-height: 1.6;
    }
    .layout {
      display: flex;
      min-height: 100vh;
    }
    nav {
      width: 260px;
      background: var(--nav-bg);
      padding: 24px 0;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }
    nav .brand {
      padding: 0 24px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      margin-bottom: 16px;
    }
    nav .brand h1 {
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      line-height: 1.3;
    }
    nav .brand span {
      color: var(--nav-text);
      font-size: 12px;
    }
    nav a {
      display: block;
      padding: 10px 24px;
      color: var(--nav-text);
      text-decoration: none;
      font-size: 14px;
      transition: background 0.15s, color 0.15s;
    }
    nav a:hover {
      background: rgba(255,255,255,0.05);
      color: #fff;
    }
    nav a.active {
      color: var(--nav-active);
      background: rgba(255,255,255,0.1);
      font-weight: 600;
      border-left: 3px solid var(--accent);
      padding-left: 21px;
    }
    nav .links {
      padding: 16px 24px 0;
      border-top: 1px solid rgba(255,255,255,0.1);
      margin-top: 16px;
    }
    nav .links a {
      padding: 6px 0;
      font-size: 12px;
      color: var(--nav-text);
    }
    main {
      flex: 1;
      max-width: 900px;
      padding: 40px 48px;
    }
    h1 { font-size: 28px; margin-bottom: 16px; color: var(--text); }
    h2 { font-size: 22px; margin-top: 36px; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    h3 { font-size: 18px; margin-top: 28px; margin-bottom: 8px; }
    h4 { font-size: 15px; margin-top: 20px; margin-bottom: 6px; }
    p { margin-bottom: 12px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul, ol { margin: 0 0 12px 24px; }
    li { margin-bottom: 4px; }
    code {
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace;
    }
    pre {
      background: var(--code-bg);
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      margin-bottom: 16px;
      border: 1px solid var(--border);
    }
    pre code {
      background: none;
      padding: 0;
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 14px;
    }
    th {
      text-align: left;
      padding: 10px 12px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      font-weight: 600;
    }
    td {
      padding: 8px 12px;
      border: 1px solid var(--border);
    }
    tr:nth-child(even) { background: var(--table-stripe); }
    blockquote {
      border-left: 3px solid var(--accent);
      padding: 8px 16px;
      margin: 12px 0;
      color: var(--text-muted);
      background: var(--code-bg);
      border-radius: 0 4px 4px 0;
    }
    blockquote p { margin-bottom: 0; }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 32px 0;
    }
    .health-badge {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 9999px;
      background: #dcfce7;
      color: #166534;
      font-weight: 600;
      margin-left: 8px;
      vertical-align: middle;
    }
    @media (max-width: 768px) {
      .layout { flex-direction: column; }
      nav {
        width: 100%;
        height: auto;
        position: relative;
        display: flex;
        flex-wrap: wrap;
        padding: 12px;
        gap: 4px;
      }
      nav .brand { padding: 0 12px 8px; width: 100%; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 8px; }
      nav a { padding: 8px 12px; font-size: 13px; }
      nav .links { display: none; }
      main { padding: 24px 20px; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <div class="brand">
        <h1>MCP4Acumatica</h1>
        <span>v0.24.0 &middot; 44 tools</span>
      </div>
      ${renderNav(slug)}
      <div class="links">
        <a href="/docs/admin">Admin Console</a>
        <a href="https://github.com/hallboys/MCP4Acumatica" target="_blank">GitHub</a>
        <a href="/health">API Health</a>
        <a href="/mcp">MCP Endpoint</a>
      </div>
    </nav>
    <main>
      ${html}
    </main>
  </div>
</body>
</html>`;
}

const docsApp = new Hono<{ Bindings: Env }>();

// Landing page — render README
docsApp.get("/", (c) => {
  const html = marked.parse(readmeContent) as string;
  return c.html(renderPage("", html));
});

// Admin console (mounted before /:slug catch-all)
docsApp.route("/admin", adminApp);

// Doc pages
docsApp.get("/:slug", (c) => {
  const slug = c.req.param("slug");
  const page = pages.find((p) => p.slug === slug);
  if (!page) {
    return c.html(renderPage("", "<h1>Not Found</h1><p>The requested page does not exist.</p>"), 404);
  }
  const html = marked.parse(page.content) as string;
  return c.html(renderPage(slug, html));
});

export { docsApp };
