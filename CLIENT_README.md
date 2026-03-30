# VikiLeads — Setup Guide

## Requirements

- **Docker Desktop** — [Windows](https://docs.docker.com/desktop/install/windows-install/) / [Mac](https://docs.docker.com/desktop/install/mac-install/)
- **Google Chrome** with extensions: ContactOut, Lusha, SalesQL
- **LinkedIn Sales Navigator** account

---

## Step 1 — Load the Image (one time only)

Open terminal in this folder:

```
docker load -i vikileads.tar.gz
```

Wait for: `Loaded image: vikileads:3.6.0`

---

## Step 2 — Launch Chrome in Debug Mode

Close ALL Chrome windows first, then:

**Windows (Command Prompt):**
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

In Chrome: log into LinkedIn Sales Navigator, activate ContactOut + Lusha + SalesQL.

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

Paste Sales Nav URL → Start → download CSV/XLSX.

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
| Container error | Run `docker compose logs` |
| Reset | `docker compose down` then `docker compose up -d` |