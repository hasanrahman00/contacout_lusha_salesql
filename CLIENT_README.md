cd C:\Users\Hassan\OneDrive\Documents\contacout_lusha_salesql

# Build + push (same tag = clients get it on next pull)
docker build -t hasandocker4/vikileads:3.6.0 . --no-cache
docker push hasandocker4/vikileads:3.6.0

---

## For Client — First Time Setup

Send them a folder with 3 files:
```
VikiLeads/
├── docker-compose.yml
├── .env
└── README.md
```

**Step 1 — Install Docker Desktop:**
https://docs.docker.com/desktop/install/windows-install/

**Step 2 — Launch Chrome:**
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="C:\Chrome_Scraper"
```
Log into LinkedIn Sales Navigator + activate extensions.

**Step 3 — Open terminal in the folder, run:**
```
docker compose up -d
```
First time downloads the image automatically (~300MB).

**Step 4 — Open:**
```
http://localhost:3002
```

**Step 5 — When done:**
```
docker compose down
```

---

## For Client — Getting Your Updates

When you push a new version, tell the client to run:
```
docker compose down
docker compose pull
docker compose up -d