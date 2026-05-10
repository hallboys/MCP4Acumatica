# Security Policy

## Supported versions

Only the latest tagged release on `main` is supported. We do not backport
fixes to older tags. Self-hosted deployments should track `main` or the most
recent `25R2-*` tag.

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Use GitHub's private vulnerability reporting:

1. Go to https://github.com/hallboys/MCP4Acumatica/security/advisories/new
2. Describe the issue, affected version/tag, and a proof-of-concept if
   available.
3. We will acknowledge receipt within 5 business days and aim to provide a
   remediation timeline within 10 business days.

If GitHub Security Advisories is not an option, you may email
`security@hallboys.com` with the same information.

## Scope

In scope:

- The Cloudflare Worker code in this repository
- The OAuth flow against Acumatica
- The admin console
- Token storage, redaction, rate-limiting, and role-gate logic
- The `setup.sh` and `install.sh` install paths

Out of scope (report upstream):

- Vulnerabilities in Acumatica itself (report to Acumatica, Inc.)
- Vulnerabilities in Cloudflare Workers, KV, R2, or Durable Objects
  (report to Cloudflare)
- Vulnerabilities in MCP clients (Claude, ChatGPT, etc.)
- Issues that require a compromised Acumatica admin account or an attacker
  with `MCP Access` role privileges already granted

## Disclosure

We follow coordinated disclosure. Once a fix is released, we will credit the
reporter in the release notes unless you ask to remain anonymous.
