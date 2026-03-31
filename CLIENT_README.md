# VikiLeads — Setup Guide

## Requirements

- **Docker Desktop** — [Windows](https://docs.docker.com/desktop/install/windows-install/) / [Mac](https://docs.docker.com/desktop/install/mac-install/)
- **Google Chrome** with extensions: ContactOut, Lusha, SalesQL
- **LinkedIn Sales Navigator** account

---

## Step 1 — Install Docker Desktop

Download and install Docker Desktop. Open it, wait until it says "Running".

---

## Step 2 — Place these files in a folder

Create a folder (e.g. `C:\VikiLeads`) and put these 3 files inside:

```
VikiLeads/
├── docker-compose.yml
├── .env
└── README.md (this file)
```

---

## Step 3 — Launch Chrome in Debug Mode

Close ALL Chrome windows first, then:

**Windows (Command Prompt):**
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="C:\Chrome_Scraper"
```

**Windows (PowerShell):**
```
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="C:\Chrome_Scraper"
```

**Mac:**
```
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="$HOME/Chrome_Scraper"
```

In Chrome: log into LinkedIn Sales Navigator, activate ContactOut + Lusha + SalesQL.

---

## Step 4 — (Optional) Set API Key

Edit `.env`:

```
DEEPSEEK_API_KEY=sk-your-key-here
```

Leave empty to skip.

---

## Step 5 — Start VikiLeads

Open terminal in the folder and run:

```
docker compose up -d
```

First time: Docker automatically downloads the app (~300MB, one time only).
After that: starts instantly.

---

## Step 6 — Open Dashboard

Go to **http://localhost:3002**

Paste Sales Nav URL → Start → download CSV/XLSX.

---

## Stop

```
docker compose down
```

---

## Update to Latest Version

```
docker compose pull
docker compose up -d
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Cannot connect to Chrome | Chrome must be running with `--remote-debugging-port=9222 --remote-allow-origins=*` |
| Sales Nav not found | Log into Sales Navigator in the debug Chrome |
| Extension data missing | Click extension icon once to activate |
| Container error | Run `docker compose logs` |
| Reset | `docker compose down` then `docker compose up -d` |