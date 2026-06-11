#!/usr/bin/env bash
# Copyright 2026 Hall Boys, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# One-shot deploy helper for MCP4Acumatica on Cloudflare Workers.
#
# Prerequisites — you must have these BEFORE running this script:
#   1. A Cloudflare account with `npx wrangler login` already authenticated.
#   2. An Acumatica instance with a Connected Application registered
#      (SM303010). You need its Client ID and Client Secret.
#   3. The Acumatica tenant (login company) name.
#   4. An `MCP Access` role and `MCPAccess` Generic Inquiry configured
#      on the Acumatica side (see docs/self-hosting-guide.md).
#
# What this does:
#   - Creates the Cloudflare KV namespace and R2 bucket (idempotent).
#   - Generates a random COOKIE_ENCRYPTION_KEY.
#   - Prompts for (or generates) ADMIN_SECRET.
#   - Substitutes ACUMATICA_URL, ACUMATICA_TENANT, ACUMATICA_ENDPOINT_VERSION,
#     and the KV namespace id into wrangler.jsonc in place. (wrangler.jsonc
#     is a tracked template — your local mods can be hidden with
#     `git update-index --skip-worktree wrangler.jsonc` after first run.)
#   - Uploads secrets via `wrangler secret put`.
#   - Runs `wrangler deploy`.
#   - Reminds you to update the Acumatica Connected App redirect URI.
#
# Safe to re-run: existing KV/R2 resources are detected and reused; the
# substitution is in place and idempotent (re-running with the same answers
# produces the same wrangler.jsonc). The previous wrangler.jsonc is saved
# to wrangler.jsonc.local-backup before overwriting (gitignored).
#
# If you prefer a no-terminal install, click the "Deploy to Cloudflare"
# button in the README — it covers everything this script does via the
# Cloudflare web UI.

set -euo pipefail

# ── Colors ─────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  BLUE="$(printf '\033[34m')"
  RESET="$(printf '\033[0m')"
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" RESET=""
fi

step()  { printf "\n${BOLD}${BLUE}▶ %s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
err()   { printf "${RED}✗${RESET} %s\n" "$*" >&2; }
hint()  { printf "${DIM}%s${RESET}\n" "$*"; }

# ── Usage ──────────────────────────────────────────────────────
FORCE=0
SKIP_DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --skip-deploy) SKIP_DEPLOY=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      err "Unknown flag: $arg"
      exit 2
      ;;
  esac
done

# ── Dependencies ───────────────────────────────────────────────
step "Checking dependencies"

for bin in node npm openssl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "Missing required binary: $bin"
    exit 1
  fi
done
ok "node, npm, openssl present"

if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  warn "wrangler is not installed locally — running 'npm install' first"
  npm install
fi
ok "wrangler available via npx"

if ! npx wrangler whoami 2>&1 | grep -qi 'logged in\|email\|account'; then
  warn "You may not be logged in to wrangler. Run:  npx wrangler login"
  printf "Continue anyway? [y/N] "
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || exit 1
fi

cd "$(dirname "$0")"

# ── Collect Acumatica config ───────────────────────────────────
step "Acumatica configuration"

prompt() {
  local var="$1" desc="$2" default="${3:-}"
  local current="${!var:-}"
  local shown_default=""
  [ -n "$current" ] && shown_default=" [${current}]"
  [ -z "$current" ] && [ -n "$default" ] && shown_default=" [${default}]"
  printf "  %s%s: " "$desc" "$shown_default"
  local value
  read -r value
  if [ -z "$value" ]; then
    value="${current:-$default}"
  fi
  if [ -z "$value" ]; then
    err "$var is required"
    exit 1
  fi
  printf -v "$var" '%s' "$value"
}

prompt_secret() {
  local var="$1" desc="$2"
  printf "  %s: " "$desc"
  local value
  read -rs value
  echo
  if [ -z "$value" ]; then
    err "$var is required"
    exit 1
  fi
  printf -v "$var" '%s' "$value"
}

# Reject inputs that would break the JSON string context when written into
# wrangler.jsonc (quotes, backslashes, whitespace). The awk substitution
# below trusts that its inputs are plain strings.
reject_unsafe() {
  local var="$1"
  local value="${!var:-}"
  case "$value" in
    *'"'*|*'\'*|*' '*|*$'\t'*|*$'\n'*)
      err "$var cannot contain quotes, backslashes, or whitespace"
      exit 1
      ;;
  esac
}

prompt ACUMATICA_URL "Acumatica instance URL (e.g. https://your-instance.acumatica.com)"
reject_unsafe ACUMATICA_URL
case "$ACUMATICA_URL" in
  https://*|http://*) ;;
  *) err "ACUMATICA_URL must start with http:// or https://"; exit 1 ;;
esac
prompt ACUMATICA_TENANT "Acumatica tenant / login company" "Production"
reject_unsafe ACUMATICA_TENANT
prompt ACUMATICA_ENDPOINT_VERSION "Contract API endpoint version" "25.200.001"
reject_unsafe ACUMATICA_ENDPOINT_VERSION
prompt ACUMATICA_CLIENT_ID "Connected App Client ID (from SM303010)"
reject_unsafe ACUMATICA_CLIENT_ID
prompt_secret ACUMATICA_CLIENT_SECRET "Connected App Client Secret"

step "Admin + encryption secrets"

printf "  Admin console password (leave blank to auto-generate): "
read -rs ADMIN_SECRET
echo
if [ -z "$ADMIN_SECRET" ]; then
  ADMIN_SECRET="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  ok "Generated ADMIN_SECRET: ${BOLD}${ADMIN_SECRET}${RESET}"
  warn "Save this now — it won't be shown again."
fi

COOKIE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
ok "Generated COOKIE_ENCRYPTION_KEY (256-bit hex)"

# ── Create KV namespace (idempotent) ───────────────────────────
step "Cloudflare KV namespace"

KV_ID=""
if [ -f wrangler.jsonc ] && [ $FORCE -eq 0 ]; then
  # Existing wrangler.jsonc may already have a real ID — extract it
  # (strip JSONC comments before parsing to keep the regex boring)
  EXISTING_ID="$(sed 's|//.*||' wrangler.jsonc | tr -d '\n' | grep -oE '"binding"[[:space:]]*:[[:space:]]*"TOKEN_STORE"[^}]*"id"[[:space:]]*:[[:space:]]*"[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | head -n1 || true)"
  if [ -n "$EXISTING_ID" ]; then
    KV_ID="$EXISTING_ID"
    ok "Reusing existing KV namespace id from wrangler.jsonc: $KV_ID"
  fi
fi

if [ -z "$KV_ID" ]; then
  hint "Creating KV namespace 'TOKEN_STORE'…"
  CREATE_OUT="$(npx wrangler kv namespace create TOKEN_STORE 2>&1 || true)"
  KV_ID="$(echo "$CREATE_OUT" | grep -oE '"id"[[:space:]]*:[[:space:]]*"[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | head -n1)"
  if [ -z "$KV_ID" ]; then
    # Older wrangler format: id = "…"
    KV_ID="$(echo "$CREATE_OUT" | grep -oE 'id[[:space:]]*=[[:space:]]*"[a-f0-9]{32}"' | grep -oE '[a-f0-9]{32}' | head -n1)"
  fi
  if [ -z "$KV_ID" ]; then
    err "Failed to parse KV namespace ID from wrangler output:"
    echo "$CREATE_OUT"
    exit 1
  fi
  ok "Created KV namespace: $KV_ID"
fi

# ── Create R2 buckets (idempotent) ─────────────────────────────
# mcp4acumatica-logs  → long-term audit logs (Logpush + DO-written)
# mcp4acumatica-index → schema-knowledge indexes (schema-index.json, etc.)
step "Cloudflare R2 buckets"

for R2_BUCKET in "mcp4acumatica-logs" "mcp4acumatica-index"; do
  R2_OUT="$(npx wrangler r2 bucket create "$R2_BUCKET" 2>&1 || true)"
  if echo "$R2_OUT" | grep -qi 'created\|success'; then
    ok "Created R2 bucket: $R2_BUCKET"
  elif echo "$R2_OUT" | grep -qi 'already exists\|10004'; then
    ok "R2 bucket already exists: $R2_BUCKET"
  else
    warn "Unexpected output from R2 bucket create ($R2_BUCKET) — verify manually:"
    echo "$R2_OUT"
  fi
done

# ── Render wrangler.jsonc ──────────────────────────────────────
step "Rendering wrangler.jsonc"

if [ ! -f wrangler.jsonc ]; then
  err "wrangler.jsonc is missing — this is the tracked deploy template."
  err "Did you delete it? Restore it with: git checkout HEAD -- wrangler.jsonc"
  exit 1
fi

# Save the previous content before overwriting so users who keep custom
# routes / vars in their local copy can recover them. The backup file is
# gitignored.
cp wrangler.jsonc wrangler.jsonc.local-backup
hint "Saved previous wrangler.jsonc to wrangler.jsonc.local-backup."

# Substitute real values into the named fields, in place. Inputs were
# validated above to not contain characters that would escape the JSON
# string context, so straight regex substitution is safe.
#
# The KV id substitution matches both the empty placeholder ("") shipped
# in the tracked template AND any prior real id, so re-running setup.sh
# with the same answers is a no-op.
TMP="$(mktemp)"
awk -v url="$ACUMATICA_URL" \
    -v tenant="$ACUMATICA_TENANT" \
    -v ver="$ACUMATICA_ENDPOINT_VERSION" \
    -v kv="$KV_ID" '
  /"ACUMATICA_URL"[[:space:]]*:/ {
    sub(/"ACUMATICA_URL"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"ACUMATICA_URL\": \"" url "\"")
  }
  /"ACUMATICA_TENANT"[[:space:]]*:/ {
    sub(/"ACUMATICA_TENANT"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"ACUMATICA_TENANT\": \"" tenant "\"")
  }
  /"ACUMATICA_ENDPOINT_VERSION"[[:space:]]*:/ {
    sub(/"ACUMATICA_ENDPOINT_VERSION"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"ACUMATICA_ENDPOINT_VERSION\": \"" ver "\"")
  }
  /"id"[[:space:]]*:/ {
    sub(/"id"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"id\": \"" kv "\"")
  }
  { print }
' wrangler.jsonc > "$TMP"
mv "$TMP" wrangler.jsonc
ok "Wrote wrangler.jsonc with ACUMATICA_URL, tenant, endpoint version, KV id."
hint "To keep your local values out of \`git status\`, run once:"
hint "  git update-index --skip-worktree wrangler.jsonc"

# ── Upload secrets ─────────────────────────────────────────────
step "Uploading secrets to Cloudflare"

put_secret() {
  # $1 = name, $2 = value
  # Pipe the value via stdin so it never lands in shell history or `ps`.
  echo -n "$2" | npx wrangler secret put "$1" >/dev/null
  ok "Set secret: $1"
}

put_secret ACUMATICA_CLIENT_ID "$ACUMATICA_CLIENT_ID"
put_secret ACUMATICA_CLIENT_SECRET "$ACUMATICA_CLIENT_SECRET"
put_secret COOKIE_ENCRYPTION_KEY "$COOKIE_ENCRYPTION_KEY"
put_secret ADMIN_SECRET "$ADMIN_SECRET"

# ── Deploy ─────────────────────────────────────────────────────
WORKER_URL=""
if [ $SKIP_DEPLOY -eq 1 ]; then
  step "Skipping deploy (--skip-deploy)"
else
  step "Deploying worker"
  DEPLOY_LOG="$(mktemp)"
  trap 'rm -f "$DEPLOY_LOG"' EXIT
  # Tee so the user sees live output and we still have it to grep for URLs.
  npx wrangler deploy 2>&1 | tee "$DEPLOY_LOG"
  ok "Deploy succeeded"
  # Prefer the *.workers.dev URL because it's unconditional; custom
  # routes depend on a zone config we can't verify from here.
  WORKER_URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"

  # ── Schema-knowledge index ───────────────────────────────────
  # If swagger.json is present, build the schema index and upload it so the
  # acumatica_search_schema / _get_schema_entity / _list_schema_entities tools
  # work immediately. Without it those tools simply don't register.
  if [ -f swagger.json ]; then
    step "Building & uploading schema index"
    if node scripts/build-schema-index.mjs && node scripts/upload-indexes.mjs; then
      ok "Schema index uploaded to mcp4acumatica-index"
    else
      warn "Schema index build/upload failed — schema-knowledge tools won't appear until you run 'npm run build-index'."
    fi
  else
    warn "swagger.json not found — skipping schema index. To enable the schema-knowledge tools, export your instance's swagger.json to the repo root and run 'npm run build-index'."
  fi
fi

# ── Auto-preflight ─────────────────────────────────────────────
# Log in with the ADMIN_SECRET we just set, then hit /docs/admin/preflight/api
# to surface Acumatica-side misconfig (wrong client_id, wrong tenant,
# missing GI, etc.) before the user ever opens a browser.
if [ -n "$WORKER_URL" ] && command -v curl >/dev/null 2>&1; then
  step "Running preflight against $WORKER_URL"
  # Give Cloudflare a beat to roll out the new version globally.
  sleep 3
  COOKIE_JAR="$(mktemp)"
  trap 'rm -f "$DEPLOY_LOG" "$COOKIE_JAR"' EXIT
  LOGIN_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
    -c "$COOKIE_JAR" \
    -X POST \
    --data-urlencode "secret=$ADMIN_SECRET" \
    "$WORKER_URL/docs/admin/login" || echo "000")"
  if [ "$LOGIN_CODE" = "302" ]; then
    PREFLIGHT_JSON="$(curl -sS -b "$COOKIE_JAR" "$WORKER_URL/docs/admin/preflight/api" || true)"
    if [ -n "$PREFLIGHT_JSON" ]; then
      # node is already a prerequisite, so we always have a JSON parser.
      PREFLIGHT_REPORT="$(
        printf '%s' "$PREFLIGHT_JSON" | node -e '
          let raw = ""; process.stdin.on("data", c => raw += c);
          process.stdin.on("end", () => {
            try {
              const data = JSON.parse(raw);
              const checks = data.checks || [];
              const pass = checks.filter(c => c.status === "pass").length;
              const fail = checks.filter(c => c.status === "fail");
              const warn = checks.filter(c => c.status === "warn");
              console.log(`${pass}/${checks.length} passed, ${fail.length} failed, ${warn.length} warning(s)`);
              for (const c of [...fail, ...warn]) {
                console.log(`  [${c.status.toUpperCase()}] ${c.name} — ${c.detail}`);
                if (c.remediation) console.log(`         ${c.remediation}`);
              }
              process.exit(fail.length > 0 ? 1 : 0);
            } catch (e) {
              console.error("Failed to parse preflight response:", e.message);
              process.exit(2);
            }
          });
        '
      )" || PREFLIGHT_EXIT=$?
      printf '%s\n' "$PREFLIGHT_REPORT"
      if [ "${PREFLIGHT_EXIT:-0}" = "1" ]; then
        warn "Preflight found configuration issues — fix the items above and re-run, or visit $WORKER_URL/docs/admin/preflight to iterate."
      elif [ "${PREFLIGHT_EXIT:-0}" = "0" ]; then
        ok "Preflight: all checks passed"
      fi
    else
      warn "Preflight request returned no body."
    fi
  else
    warn "Auto-login to run preflight failed (HTTP $LOGIN_CODE). Open $WORKER_URL/docs/admin/preflight in a browser to run it manually."
  fi
elif [ -z "$WORKER_URL" ] && [ $SKIP_DEPLOY -eq 0 ]; then
  warn "Could not determine worker URL from deploy output — skipping auto-preflight."
fi

# ── Follow-up reminders ────────────────────────────────────────
step "Next steps"

cat <<EOF
${BOLD}Finish the Acumatica side:${RESET}

  ${BOLD}1.${RESET} In Acumatica, Connected Applications (SM303010):
     Add this redirect URI to the MCP app:
       ${BOLD}https://<your-worker-domain>/callback${RESET}
     ${DIM}(Use the custom route from wrangler.jsonc, or the *.workers.dev URL
      from the deploy output above. Both must be registered if you use both.)${RESET}

  ${BOLD}2.${RESET} Ensure the 'MCP Access' role exists (SM201005) and is assigned to
     every user you want to grant AI assistant access.

  ${BOLD}3.${RESET} Ensure the 'MCPAccess' Generic Inquiry exists (SM208000), is
     ${BOLD}Exposed via OData${RESET}, and is assigned only to the 'MCP Access' role.

${BOLD}Verify the deploy:${RESET}

  • Open the admin console:  https://<your-worker>/docs/admin
  • Log in with the ADMIN_SECRET above.
  • Click ${BOLD}Preflight${RESET} to run live checks against Acumatica.

Any failures will name the specific env var or Acumatica setting that
needs attention.
EOF
