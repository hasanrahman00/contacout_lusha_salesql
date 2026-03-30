#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# VikiLeads — Build & Export Docker Image
# ═══════════════════════════════════════════════════════════════════
# Run this in your project root (where server.js lives).
# Output: delivery/ folder ready to send to the client.
# ═══════════════════════════════════════════════════════════════════

set -e

TAG="vikileads:3.6.0"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   VikiLeads Docker Build                 ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

echo "🔨 Building ${TAG} (obfuscating source code)..."
docker build -t ${TAG} .
echo "✅ Image built"
echo ""

echo "📦 Exporting to vikileads.tar.gz..."
docker save ${TAG} | gzip > vikileads.tar.gz
echo "✅ Exported ($(du -h vikileads.tar.gz | cut -f1))"
echo ""

echo "📁 Creating delivery/ folder..."
rm -rf delivery && mkdir delivery
mv vikileads.tar.gz delivery/

# ── docker-compose.yml ──────────────────────────────────────────
cat > delivery/docker-compose.yml << 'COMPOSE'
services:
  vikileads:
    image: vikileads:3.6.0
    container_name: vikileads
    ports:
      - "3002:3002"
    environment:
      - CDP_HOST=host.docker.internal
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
COMPOSE

# ── .env template ───────────────────────────────────────────────
cat > delivery/.env << 'ENVFILE'
# DeepSeek API key for domain validation (optional, leave empty to skip)
DEEPSEEK_API_KEY=
ENVFILE

# ── README.md ───────────────────────────────────────────────────
cat > delivery/README.md << 'README'
# VikiLeads — Setup Guide

## Requirements

- **Docker Desktop** — [Windows](https://docs.docker.com/desktop/install/windows-install/) / [Mac](https://docs.docker.com/desktop/install/mac-install/)
- **Google Chrome** with extensions installed & logged in: ContactOut, Lusha, SalesQL
- **LinkedIn Sales Navigator** account

---

## Step 1 — Load the Image (one time only)

```
docker load -i vikileads.tar.gz
```

---

## Step 2 — Launch Chrome in Debug Mode

Close ALL Chrome windows first, then:

**Windows (CMD):**
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Chrome_Scraper"
```

**Windows (PowerShell):**
```
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Chrome_Scraper"
```

**Mac:**
```
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/Chrome_Scraper"
```

In that Chrome window: log into LinkedIn Sales Navigator, make sure extensions are active.

---

## Step 3 — (Optional) Set API Key

Edit `.env`:
```
DEEPSEEK_API_KEY=sk-your-key-here
```

---

## Step 4 — Start VikiLeads

```
docker compose up -d
```

---

## Step 5 — Open Dashboard

Go to **http://localhost:3002**

Paste Sales Nav URL → Start → Download CSV/XLSX.

---

## Stop

```
docker compose down
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Cannot connect to Chrome | Chrome must be running with `--remote-debugging-port=9222` |
| Sales Nav not found | Log into Sales Navigator in the debug Chrome |
| Extension data missing | Click extension icon once to activate |
| Container error | `docker compose logs` |
| Reset | `docker compose down && docker compose up -d` |
README

echo ""
echo "  ✅ Done! Send the delivery/ folder to your client."
echo ""
echo "  delivery/"
echo "  ├── vikileads.tar.gz"
echo "  ├── docker-compose.yml"
echo "  ├── .env"
echo "  └── README.md"
echo ""