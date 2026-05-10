# Contributing to MCP4Acumatica

Thanks for your interest in contributing. This project is an independent
community integration of Acumatica ERP with the Model Context Protocol; bug
reports, feature ideas, and pull requests are all welcome.

## Reporting bugs and requesting features

- Use [GitHub Issues](https://github.com/hallboys/MCP4Acumatica/issues).
- Search existing issues before opening a new one.
- For bug reports, include: Acumatica version, MCP client (Claude.ai, Claude
  Desktop, Claude Code, ChatGPT, etc.), and the relevant `wrangler tail` or
  admin-console log lines (with any sensitive values redacted).

## Submitting a pull request

1. Fork the repo and create a topic branch off `main`.
2. Run the type checker before pushing: `npx tsc --noEmit`.
3. Keep PRs focused — one logical change per PR.
4. Include a short description of *why* the change is needed and how you
   tested it. For tool-behavior changes, include a representative model
   prompt and the response shape.
5. By submitting a PR you certify that you have the right to license your
   contribution under the project's Apache 2.0 license (see `LICENSE`).

## Coding conventions

- TypeScript, strict mode. No `any` unless you have a load-bearing reason.
- Every new `.ts` source file must start with the project copyright header:
  ```
  // Copyright 2026 Hall Boys, Inc.
  // SPDX-License-Identifier: Apache-2.0
  ```
- Tool parameter schemas must use simple Zod types (`z.string()`,
  `z.string().optional()`, `z.string().default(...)`) — complex types break
  MCP client discovery. See `CLAUDE.md` for details.
- Prefer extending `getter-registry.ts` over hand-writing per-entity
  handlers when adding a single-record lookup tool.
- Don't commit instance-specific values to `wrangler.jsonc` — it is the
  shared deploy template. Use `git update-index --skip-worktree` for local
  overrides (see `CLAUDE.md` § Configuration).

## Security issues

Please **do not** open public issues for security vulnerabilities. See
[`SECURITY.md`](SECURITY.md) for the disclosure process.
