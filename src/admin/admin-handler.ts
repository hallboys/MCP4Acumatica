// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Env } from "../types/acumatica";
import { getConfig, setConfig, deleteConfig, CONFIG_KEYS } from "../lib/config";

// ── Crypto helpers ────────────────────────────────────────────────

async function hmacSign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function hmacVerify(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(payload, secret);
  // Timing-safe comparison via subtle crypto
  if (expected.length !== signature.length) return false;
  const enc = new TextEncoder();
  const a = enc.encode(expected);
  const b = enc.encode(signature);
  // Use XOR comparison to avoid timing leaks
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}

// ── Session cookie helpers ────────────────────────────────────────

const SESSION_COOKIE = "mcp_admin_session";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

async function createSessionCookie(secret: string): Promise<string> {
  const exp = Date.now() + SESSION_DURATION_MS;
  const payload = String(exp);
  const sig = await hmacSign(payload, secret);
  const value = `${payload}.${sig}`;
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/docs/admin; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}`;
}

async function validateSession(cookieHeader: string | undefined, secret: string): Promise<boolean> {
  const cookies = parseCookies(cookieHeader);
  const session = cookies[SESSION_COOKIE];
  if (!session) return false;

  const dotIdx = session.lastIndexOf(".");
  if (dotIdx < 0) return false;

  const payload = session.substring(0, dotIdx);
  const sig = session.substring(dotIdx + 1);

  if (!(await hmacVerify(payload, sig, secret))) return false;

  const exp = parseInt(payload, 10);
  return !isNaN(exp) && Date.now() < exp;
}

// ── Shared layout ────────────────────────────────────────────────

function renderAdminPage(title: string, activeTab: string, bodyHtml: string): string {
  const tabs = [
    { slug: "logs", label: "Logs" },
    { slug: "settings", label: "Settings" },
  ];

  const navLinks = tabs
    .map((t) => {
      const active = t.slug === activeTab ? ' class="active"' : "";
      return `<a href="/docs/admin/${t.slug}"${active}>${t.label}</a>`;
    })
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - MCP4Acumatica Admin</title>
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
      --danger: #dc2626;
      --success: #16a34a;
      --warning: #ca8a04;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--text);
      background: var(--bg);
      line-height: 1.6;
    }
    .layout { display: flex; min-height: 100vh; }
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
    nav .brand h1 { color: #fff; font-size: 16px; font-weight: 600; line-height: 1.3; }
    nav .brand span { color: var(--nav-text); font-size: 12px; }
    nav .section-label {
      padding: 8px 24px 4px;
      color: var(--nav-text);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
    }
    nav a {
      display: block;
      padding: 10px 24px;
      color: var(--nav-text);
      text-decoration: none;
      font-size: 14px;
      transition: background 0.15s, color 0.15s;
    }
    nav a:hover { background: rgba(255,255,255,0.05); color: #fff; }
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
    nav .links a { padding: 6px 0; font-size: 12px; color: var(--nav-text); }
    main { flex: 1; max-width: 1100px; padding: 40px 48px; }
    h1 { font-size: 28px; margin-bottom: 16px; color: var(--text); }
    h2 { font-size: 22px; margin-top: 36px; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    p { margin-bottom: 12px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Form styles */
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
    .form-group .description { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
    .form-group input[type="text"], .form-group input[type="password"], .form-group input[type="date"], .form-group select {
      width: 100%;
      max-width: 600px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
    }
    .form-group textarea {
      width: 100%;
      max-width: 600px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 13px;
      font-family: "SF Mono", "Fira Code", Menlo, monospace;
      min-height: 60px;
      resize: vertical;
    }
    .source-badge {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 9999px;
      font-weight: 600;
      margin-left: 8px;
      vertical-align: middle;
    }
    .source-kv { background: #dbeafe; color: #1e40af; }
    .source-env { background: #dcfce7; color: #166534; }
    .source-default { background: #f1f5f9; color: #555; }

    /* Button styles */
    .btn {
      display: inline-block;
      padding: 8px 16px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); text-decoration: none; }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-secondary { background: var(--code-bg); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }

    /* Table styles */
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; background: var(--code-bg); border: 1px solid var(--border); font-weight: 600; font-size: 12px; }
    td { padding: 8px 12px; border: 1px solid var(--border); }
    tr:nth-child(even) { background: var(--table-stripe); }

    /* Log-specific */
    .log-type { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
    .log-type-tool_invocation { background: #dbeafe; color: #1e40af; }
    .log-type-tool_error { background: #fecaca; color: #991b1b; }
    .log-type-auth_event { background: #dcfce7; color: #166534; }
    .log-type-field_redaction { background: #fef3c7; color: #92400e; }
    .log-details { font-family: "SF Mono", Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; background: var(--code-bg); padding: 8px; border-radius: 4px; }
    .filters { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; align-items: end; }
    .filters .form-group { margin-bottom: 0; }
    .alert { padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
    .alert-success { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .alert-error { background: #fecaca; color: #991b1b; border: 1px solid #fca5a5; }
    .alert-info { background: #dbeafe; color: #1e40af; border: 1px solid #bfdbfe; }
    .login-box { max-width: 400px; margin: 60px auto; padding: 32px; background: var(--surface); border-radius: 12px; border: 1px solid var(--border); }
    .login-box h1 { text-align: center; font-size: 22px; }
    .login-box .form-group input { max-width: 100%; }
    .empty-state { text-align: center; padding: 40px; color: var(--text-muted); }

    @media (max-width: 768px) {
      .layout { flex-direction: column; }
      nav { width: 100%; height: auto; position: relative; display: flex; flex-wrap: wrap; padding: 12px; gap: 4px; }
      nav .brand { padding: 0 12px 8px; width: 100%; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 8px; }
      nav a { padding: 8px 12px; font-size: 13px; }
      nav .section-label { display: none; }
      nav .links { display: none; }
      main { padding: 24px 20px; }
      .filters { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <div class="brand">
        <h1>MCP4Acumatica</h1>
        <span>Admin Console</span>
      </div>
      <div class="section-label">Admin</div>
      ${navLinks}
      <div class="links">
        <a href="/docs">Documentation</a>
        <a href="/health">API Health</a>
        <form method="POST" action="/docs/admin/logout" style="margin:0">
          <a href="#" onclick="this.parentElement.submit();return false" style="color:#f87171">Logout</a>
        </form>
      </div>
    </nav>
    <main>
      ${bodyHtml}
    </main>
  </div>
</body>
</html>`;
}

// ── Login page (no layout — standalone) ──────────────────────────

function renderLoginPage(error?: string): string {
  const errorHtml = error ? `<div class="alert alert-error">${error}</div>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin Login - MCP4Acumatica</title>
  <style>
    :root { --accent: #2563eb; --accent-hover: #1d4ed8; --border: #e2e8f0; --bg: #fafafa; --surface: #ffffff; --text: #1a1a2e; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    .login-box { max-width: 400px; margin: 80px auto; padding: 32px; background: var(--surface); border-radius: 12px; border: 1px solid var(--border); }
    .login-box h1 { text-align: center; font-size: 22px; margin-bottom: 8px; }
    .login-box p { text-align: center; font-size: 14px; color: #555; margin-bottom: 20px; }
    label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px; }
    input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
    .btn-primary { display: block; width: 100%; padding: 10px; background: var(--accent); color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .btn-primary:hover { background: var(--accent-hover); }
    .alert-error { padding: 10px 14px; background: #fecaca; color: #991b1b; border: 1px solid #fca5a5; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>MCP4Acumatica</h1>
    <p>Admin Console</p>
    ${errorHtml}
    <form method="POST" action="/docs/admin/login">
      <label for="secret">Admin Secret</label>
      <input type="password" id="secret" name="secret" placeholder="Enter admin secret" required autofocus>
      <button type="submit" class="btn-primary">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

// ── Admin Hono app ───────────────────────────────────────────────

const adminApp = new Hono<{ Bindings: Env }>();

// Login page
adminApp.get("/login", (c) => {
  return c.html(renderLoginPage());
});

// Login handler
adminApp.post("/login", async (c) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret) {
    return c.html(renderLoginPage("Admin access is not configured. Set ADMIN_SECRET via wrangler secret put."), 503);
  }

  const body = await c.req.parseBody();
  const submitted = typeof body.secret === "string" ? body.secret : "";

  // Timing-safe comparison
  const enc = new TextEncoder();
  const a = enc.encode(submitted);
  const b = enc.encode(secret);
  let match = a.length === b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) match = false;
  }

  if (!match) {
    return c.html(renderLoginPage("Invalid secret. Please try again."), 401);
  }

  const signingKey = c.env.COOKIE_ENCRYPTION_KEY || secret;
  const cookie = await createSessionCookie(signingKey);
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/docs/admin/logs",
      "Set-Cookie": cookie,
    },
  });
});

// Logout handler
adminApp.post("/logout", (c) => {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/docs/admin/login",
      "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/docs/admin; Max-Age=0`,
    },
  });
});

// Auth middleware — protect everything except /login and /logout
adminApp.use("/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/docs/admin/login" || path === "/docs/admin/logout") {
    return next();
  }

  const secret = c.env.ADMIN_SECRET;
  if (!secret) {
    return c.redirect("/docs/admin/login");
  }

  const signingKey = c.env.COOKIE_ENCRYPTION_KEY || secret;
  const valid = await validateSession(c.req.header("cookie"), signingKey);
  if (!valid) {
    return c.redirect("/docs/admin/login");
  }

  await next();
});

// ── Admin root redirect ──────────────────────────────────────────

adminApp.get("/", (c) => c.redirect("/docs/admin/logs"));

// ── Settings page ────────────────────────────────────────────────

adminApp.get("/settings", async (c) => {
  const kv = c.env.TOKEN_STORE;
  const envLookup: Record<string, string | undefined> = {
    REDACT_PATTERNS: c.env.REDACT_PATTERNS,
    REDACT_SKIP: c.env.REDACT_SKIP,
    ACUMATICA_MAX_RECORDS: c.env.ACUMATICA_MAX_RECORDS,
  };

  let rows = "";
  for (const cfg of CONFIG_KEYS) {
    const kvValue = await kv.get(`config:${cfg.key}`);
    const envValue = envLookup[cfg.envVar];
    const effectiveValue = kvValue ?? envValue ?? "";
    const source = kvValue !== null ? "kv" : envValue ? "env" : "default";
    const badge = `<span class="source-badge source-${source}">${source.toUpperCase()}</span>`;

    rows += `
      <div class="form-group" id="cfg-${cfg.key}">
        <label>${cfg.label} ${badge}</label>
        <div class="description">${cfg.description}</div>
        <div style="display:flex;gap:8px;align-items:start">
          <textarea name="${cfg.key}" id="input-${cfg.key}">${effectiveValue}</textarea>
          <button class="btn btn-primary btn-sm" onclick="saveSetting('${cfg.key}')">Save</button>
          ${kvValue !== null ? `<button class="btn btn-secondary btn-sm" onclick="resetSetting('${cfg.key}')">Reset</button>` : ""}
        </div>
      </div>`;
  }

  const html = `
    <h1>Settings</h1>
    <p>Runtime configuration stored in KV. Changes take effect when the next MCP session starts (DOs recycle within minutes on idle).</p>
    <div id="settings-alert"></div>
    ${rows}
    <script>
      async function saveSetting(key) {
        const value = document.getElementById('input-' + key).value;
        const res = await fetch('/docs/admin/settings/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value })
        });
        const data = await res.json();
        showAlert(data.ok ? 'Setting saved. Changes apply on next MCP session.' : 'Error: ' + data.error, data.ok ? 'success' : 'error');
        if (data.ok) setTimeout(() => location.reload(), 800);
      }
      async function resetSetting(key) {
        const res = await fetch('/docs/admin/settings/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value: null })
        });
        const data = await res.json();
        showAlert(data.ok ? 'Setting reset to env default.' : 'Error: ' + data.error, data.ok ? 'success' : 'error');
        if (data.ok) setTimeout(() => location.reload(), 800);
      }
      function showAlert(msg, type) {
        document.getElementById('settings-alert').innerHTML = '<div class="alert alert-' + type + '">' + msg + '</div>';
      }
    </script>`;

  return c.html(renderAdminPage("Settings", "settings", html));
});

// Settings API
adminApp.get("/settings/api", async (c) => {
  const kv = c.env.TOKEN_STORE;
  const envLookup: Record<string, string | undefined> = {
    REDACT_PATTERNS: c.env.REDACT_PATTERNS,
    REDACT_SKIP: c.env.REDACT_SKIP,
    ACUMATICA_MAX_RECORDS: c.env.ACUMATICA_MAX_RECORDS,
  };

  const result: Record<string, { value: string; source: string }> = {};
  for (const cfg of CONFIG_KEYS) {
    const kvValue = await kv.get(`config:${cfg.key}`);
    const envValue = envLookup[cfg.envVar];
    result[cfg.key] = {
      value: kvValue ?? envValue ?? "",
      source: kvValue !== null ? "kv" : envValue ? "env" : "default",
    };
  }

  return c.json(result);
});

adminApp.post("/settings/api", async (c) => {
  try {
    const body = await c.req.json<{ key: string; value: string | null }>();
    const kv = c.env.TOKEN_STORE;

    // Validate key is a known config key
    const valid = CONFIG_KEYS.find((cfg) => cfg.key === body.key);
    if (!valid) {
      return c.json({ ok: false, error: "Unknown config key" }, 400);
    }

    if (body.value === null || body.value === "") {
      await deleteConfig(kv, body.key);
    } else {
      await setConfig(kv, body.key, body.value);
    }

    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Invalid request" }, 400);
  }
});

// ── Logs page ────────────────────────────────────────────────────

adminApp.get("/logs", (c) => {
  const today = new Date().toISOString().split("T")[0];

  const html = `
    <h1>Logs</h1>
    <p>View logs from R2 (Logpush) with long-term retention.</p>
    <div class="filters">
      <div class="form-group">
        <label>Start Date</label>
        <input type="date" id="startDate" value="${today}">
      </div>
      <div class="form-group">
        <label>End Date</label>
        <input type="date" id="endDate" value="${today}">
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="filterType">
          <option value="">All</option>
          <option value="tool_invocation">Tool Invocation</option>
          <option value="tool_error">Tool Error</option>
          <option value="auth_event">Auth Event</option>
          <option value="field_redaction">Field Redaction</option>
        </select>
      </div>
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="filterUsername" placeholder="Filter by username...">
      </div>
      <div class="form-group">
        <label>Tool</label>
        <input type="text" id="filterTool" placeholder="Filter by tool name...">
      </div>
      <div class="form-group">
        <label>&nbsp;</label>
        <button class="btn btn-primary" onclick="loadLogs()">Search</button>
      </div>
    </div>
    <div id="logs-alert"></div>
    <div id="logs-table">
      <div class="empty-state">Select a date range and click Search to load logs.</div>
    </div>
    <div id="logs-pagination" style="margin-top:12px"></div>
    <script>
      let currentPage = 0;
      const pageSize = 25;

      async function loadLogs(page) {
        if (page !== undefined) currentPage = page;
        else currentPage = 0;

        const params = new URLSearchParams({
          startDate: document.getElementById('startDate').value,
          endDate: document.getElementById('endDate').value,
          page: String(currentPage),
          pageSize: String(pageSize),
        });
        const type = document.getElementById('filterType').value;
        const username = document.getElementById('filterUsername').value;
        const tool = document.getElementById('filterTool').value;
        if (type) params.set('type', type);
        if (username) params.set('username', username);
        if (tool) params.set('tool', tool);

        document.getElementById('logs-table').innerHTML = '<div class="empty-state">Loading...</div>';

        try {
          const res = await fetch('/docs/admin/logs/api?' + params);
          const data = await res.json();

          if (data.error) {
            document.getElementById('logs-table').innerHTML = '<div class="alert alert-error">' + data.error + '</div>';
            return;
          }

          if (!data.logs || data.logs.length === 0) {
            document.getElementById('logs-table').innerHTML = '<div class="empty-state">No log entries found for the selected criteria.</div>';
            document.getElementById('logs-pagination').innerHTML = '';
            return;
          }

          let html = '<table><thead><tr><th>Timestamp</th><th>Type</th><th>Tool</th><th>User</th><th>Status</th><th>Duration</th></tr></thead><tbody>';
          for (const log of data.logs) {
            const ts = log.timestamp ? new Date(log.timestamp).toLocaleString() : '';
            const type = log.type || '';
            const typeClass = 'log-type log-type-' + type;
            const tool = log.tool || log.eventType || '';
            const user = log.acumaticaUsername || log.username || '';
            const status = log.statusCode || '';
            const duration = log.durationMs ? log.durationMs + 'ms' : '';
            const details = JSON.stringify(log, null, 2);

            html += '<tr onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\\'none\\'?\\'table-row\\':\\'none\\'" style="cursor:pointer">';
            html += '<td>' + ts + '</td>';
            html += '<td><span class="' + typeClass + '">' + type + '</span></td>';
            html += '<td>' + tool + '</td>';
            html += '<td>' + user + '</td>';
            html += '<td>' + status + '</td>';
            html += '<td>' + duration + '</td>';
            html += '</tr>';
            html += '<tr style="display:none"><td colspan="6"><div class="log-details">' + details.replace(/</g, '&lt;') + '</div></td></tr>';
          }
          html += '</tbody></table>';

          document.getElementById('logs-table').innerHTML = html;

          // Pagination
          let pag = '';
          if (currentPage > 0) pag += '<button class="btn btn-secondary btn-sm" onclick="loadLogs(' + (currentPage - 1) + ')">Previous</button> ';
          pag += 'Page ' + (currentPage + 1);
          if (data.hasMore) pag += ' <button class="btn btn-secondary btn-sm" onclick="loadLogs(' + (currentPage + 1) + ')">Next</button>';
          pag += ' <span style="color:var(--text-muted);font-size:12px;margin-left:12px">' + data.totalEntries + ' entries from ' + data.filesRead + ' log file(s)</span>';
          document.getElementById('logs-pagination').innerHTML = pag;

        } catch (err) {
          document.getElementById('logs-table').innerHTML = '<div class="alert alert-error">Failed to load logs: ' + err.message + '</div>';
        }
      }
    </script>`;

  return c.html(renderAdminPage("Logs", "logs", html));
});

// ── Log reading helpers ──────────────────────────────────────────

/** List R2 objects matching date-scoped prefixes, with a hard cap. */
async function listObjectsByDateRange(
  bucket: R2Bucket,
  prefixes: string[],
  maxObjects: number
): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  for (const prefix of prefixes) {
    if (objects.length >= maxObjects) break;
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({
        prefix,
        cursor,
        limit: Math.min(1000, maxObjects - objects.length),
      });
      for (const obj of listed.objects) {
        objects.push(obj);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor && objects.length < maxObjects);
  }
  return objects;
}

/** Generate date strings YYYY-MM-DD from start to end inclusive. */
function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (d <= end && dates.length < 31) {
    dates.push(d.toISOString().split("T")[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/** Read an R2 object and parse NDJSON lines into structured log entries. */
async function parseLogObject(r2Obj: R2ObjectBody, key: string): Promise<Record<string, unknown>[]> {
  let text: string;
  if (key.endsWith(".gz") || key.endsWith(".json.gz") || key.endsWith(".log.gz")) {
    const ds = new DecompressionStream("gzip");
    const decompressed = r2Obj.body.pipeThrough(ds);
    text = await new Response(decompressed).text();
  } else {
    text = await r2Obj.text();
  }

  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Logpush wraps events — extract our structured logs from the Logs array
      if (entry.Logs && Array.isArray(entry.Logs)) {
        for (const logGroup of entry.Logs) {
          if (logGroup.Message && Array.isArray(logGroup.Message)) {
            for (const msg of logGroup.Message) {
              try {
                const parsed = JSON.parse(msg);
                if (parsed.type) entries.push(parsed);
              } catch {
                // Not JSON — skip
              }
            }
          }
        }
      } else if (entry.type) {
        // Direct structured log entry (DO-written logs)
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/** Check if a log entry matches the active filters. */
function matchesFilters(
  entry: Record<string, unknown>,
  filterType: string,
  filterUsername: string,
  filterTool: string
): boolean {
  if (filterType && entry.type !== filterType) return false;
  if (filterUsername) {
    const user = ((entry.acumaticaUsername as string) || (entry.username as string) || "").toLowerCase();
    if (!user.includes(filterUsername)) return false;
  }
  if (filterTool) {
    const tool = ((entry.tool as string) || (entry.eventType as string) || "").toLowerCase();
    if (!tool.includes(filterTool)) return false;
  }
  return true;
}

// Logs API — reads NDJSON files from R2 (Logpush + DO-written)
// Uses streaming server-side pagination: reads only enough files to
// fill one page of filtered results, then stops. Prevents timeouts.
adminApp.get("/logs/api", async (c) => {
  const bucket = c.env.mcp4acumatica_logs;
  if (!bucket) {
    return c.json({ error: "Log bucket not configured. Add R2 binding to wrangler.jsonc." }, 500);
  }

  const startDate = c.req.query("startDate") || new Date().toISOString().split("T")[0];
  const endDate = c.req.query("endDate") || startDate;
  const filterType = c.req.query("type") || "";
  const filterUsername = (c.req.query("username") || "").toLowerCase();
  const filterTool = (c.req.query("tool") || "").toLowerCase();
  const page = parseInt(c.req.query("page") || "0", 10);
  const pageSize = Math.min(parseInt(c.req.query("pageSize") || "25", 10), 200);

  try {
    const dates = dateRange(startDate, endDate);
    const maxObjects = 1000;

    // Build date-scoped prefixes for both DO logs and Logpush logs
    const prefixes: string[] = [];
    for (const d of dates) {
      prefixes.push(`do-logs/${d}/`);           // DO-written tool logs
      prefixes.push(`${d.replace(/-/g, "")}/`); // Logpush YYYYMMDD/ format
    }

    // List objects using prefix-scoped queries
    const scopedObjects = await listObjectsByDateRange(bucket, prefixes, maxObjects);

    // Sort by upload time descending (newest first)
    scopedObjects.sort((a, b) => (b.uploaded?.getTime() || 0) - (a.uploaded?.getTime() || 0));

    // Streaming pagination: read files in parallel batches, filter
    // incrementally, and stop once we have enough entries to fill the
    // requested page plus one extra (to detect hasMore).
    const filtered: Record<string, unknown>[] = [];
    let filesRead = 0;
    const batchSize = 25;
    const needEntries = (page + 1) * pageSize + 1; // entries needed to fill page + hasMore

    for (let i = 0; i < scopedObjects.length; i += batchSize) {
      const batch = scopedObjects.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (obj) => {
          const r2Obj = await bucket.get(obj.key);
          if (!r2Obj) return [];
          return parseLogObject(r2Obj, obj.key);
        })
      );
      for (const entries of results) {
        for (const entry of entries) {
          if (matchesFilters(entry, filterType, filterUsername, filterTool)) {
            filtered.push(entry);
          }
        }
      }
      filesRead += batch.length;

      // Stop early once we have enough filtered entries for this page
      if (filtered.length >= needEntries) break;
    }

    // Sort by timestamp descending
    filtered.sort((a, b) => {
      const ta = new Date((a.timestamp as string) || 0).getTime();
      const tb = new Date((b.timestamp as string) || 0).getTime();
      return tb - ta;
    });

    // Paginate
    const start = page * pageSize;
    const pageEntries = filtered.slice(start, start + pageSize);
    const hasMore = filtered.length > start + pageSize;

    return c.json({
      logs: pageEntries,
      hasMore,
      totalEntries: filtered.length,
      filesRead,
      page,
      pageSize,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to read logs" }, 500);
  }
});

export { adminApp };
