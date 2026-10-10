#!/usr/bin/env bash
# Installs or updates the dashboard on the server. Run as the `aligned` user
# (it uses sudo only for systemd, nginx and certbot), from the app directory
# the deploy synced to /home/aligned/workspace-dashboard:
#   bash ops/setup-server.sh [hostname]
# Safe to re-run. It never touches the database, the secrets directory, the
# system Node.js, or any other app's service or nginx site.
#
# Optional environment (the GitHub deploy passes these from repo secrets):
#   WSD_SA_KEY_JSON      service-account key JSON, written to the secrets dir
#   WSD_ADMIN_USER / WSD_ADMIN_PASSWORD   first admin login, only if none exists
#   WSD_ANTHROPIC_API_KEY  turns on the "Ask" AI assistant
#   SUDO_ASKPASS         lets sudo take a password non-interactively
set -euo pipefail
HOST_NAME="${1:-emails.aligned-tech.com}"
CONTACT_EMAIL="mayssam.ismail@aligned-tech.com"
APP="$HOME/workspace-dashboard"
DATA="$HOME/workspace-dashboard-data"
SECRETS="$HOME/workspace-dashboard-secrets"
NODE_VERSION="v22.22.0"
SUDO="sudo"; [ -n "${SUDO_ASKPASS:-}" ] && SUDO="sudo -A"

cd "$APP"
mkdir -p "$DATA" "$SECRETS"
chmod 700 "$DATA" "$SECRETS"

# Node 22.13+ is needed for the built-in SQLite. The quotation app on the same
# server may run an older system Node, so rather than upgrade that, this app
# gets its own private copy under ~/.local when the system one is too old.
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || ! node_ok "$NODE_BIN"; then
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
  PRIVATE="$HOME/.local/node-$NODE_VERSION-linux-$ARCH"
  if [ ! -x "$PRIVATE/bin/node" ]; then
    echo "System Node is $( [ -n "$NODE_BIN" ] && "$NODE_BIN" -v || echo missing ) — installing a private Node $NODE_VERSION for this app only..."
    mkdir -p "$HOME/.local"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.xz" | tar -xJ -C "$HOME/.local"
  fi
  NODE_BIN="$PRIVATE/bin/node"
fi
NODE_DIR="$(dirname "$NODE_BIN")"
echo "Using Node $("$NODE_BIN" -v) at $NODE_BIN"

echo "Installing dependencies..."
PATH="$NODE_DIR:$PATH" npm ci --omit=dev --no-audit --no-fund

if [ -n "${WSD_SA_KEY_JSON:-}" ]; then
  umask 077
  printf '%s' "$WSD_SA_KEY_JSON" > "$SECRETS/service-account.json"
  echo "Service-account key written."
fi
# Optional: the Anthropic API key for the "Ask" assistant, kept in the
# service's EnvironmentFile (never in the code directory).
if [ -n "${WSD_ANTHROPIC_API_KEY:-}" ]; then
  umask 077
  touch "$SECRETS/env"
  grep -v '^ANTHROPIC_API_KEY=' "$SECRETS/env" > "$SECRETS/env.tmp" || true
  printf 'ANTHROPIC_API_KEY=%s\n' "$WSD_ANTHROPIC_API_KEY" >> "$SECRETS/env.tmp"
  mv "$SECRETS/env.tmp" "$SECRETS/env"
  echo "Anthropic API key written (Ask assistant on)."
fi
[ -f "$SECRETS/service-account.json" ] || echo "NOTE: no service-account key at $SECRETS/service-account.json yet — Google sync stays off until it is there."

DB_FILE="$DATA/dashboard.db" "$NODE_BIN" --disable-warning=ExperimentalWarning ops/ensure-admin.js

echo "Installing systemd service..."
sed -e "s|__NODE__|$NODE_BIN|" -e "s|/home/aligned|$HOME|g" -e "s|^User=.*|User=$(id -un)|" \
  ops/workspace-dashboard.service > /tmp/workspace-dashboard.service
$SUDO install -m 644 /tmp/workspace-dashboard.service /etc/systemd/system/workspace-dashboard.service
rm -f /tmp/workspace-dashboard.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable workspace-dashboard >/dev/null
$SUDO systemctl restart workspace-dashboard

if command -v nginx >/dev/null 2>&1; then
  # Don't clobber an existing site file: certbot edits it in place to add HTTPS.
  if [ ! -f /etc/nginx/sites-available/workspace-dashboard.conf ]; then
    echo "Installing nginx site for $HOST_NAME..."
    sed "s/emails.aligned-tech.com/$HOST_NAME/g" ops/nginx-workspace-dashboard.conf > /tmp/wsd-nginx.conf
    $SUDO install -m 644 /tmp/wsd-nginx.conf /etc/nginx/sites-available/workspace-dashboard.conf
    rm -f /tmp/wsd-nginx.conf
    $SUDO ln -sf /etc/nginx/sites-available/workspace-dashboard.conf /etc/nginx/sites-enabled/workspace-dashboard.conf
  fi
  $SUDO nginx -t && $SUDO systemctl reload nginx
  if command -v certbot >/dev/null 2>&1 && ! $SUDO test -d "/etc/letsencrypt/live/$HOST_NAME"; then
    echo "Requesting an HTTPS certificate for $HOST_NAME..."
    $SUDO certbot --nginx -d "$HOST_NAME" --non-interactive --agree-tos -m "$CONTACT_EMAIL" --redirect \
      || echo "WARNING: certbot failed — check that $HOST_NAME's DNS points at this server, then re-run the deploy."
  fi
else
  echo "WARNING: nginx is not installed; the app listens on 127.0.0.1:3100 only."
fi

# Health check: the API must answer (401 = up and asking for a login).
for i in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/me || true)
  if [ "$code" = "401" ]; then echo "OK: dashboard is up on 127.0.0.1:3100"; exit 0; fi
  sleep 1
done
echo "ERROR: dashboard did not come up. Recent log:" >&2
$SUDO journalctl -u workspace-dashboard -n 40 --no-pager >&2 || true
exit 1
