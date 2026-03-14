# VikiLeads v3.0.0 — LinkedIn Sales Navigator Scraper

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Chrome_Scraper"
```

Network-interception based lead extraction with **Sales Nav + ContactOut + Lusha** enrichment.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Browser (Chrome + 2 Extensions)                              │
│  ┌──────────────────────┐  ┌────────────────────────┐        │
│  │     ContactOut        │  │         Lusha           │        │
│  │  (floating iframe)    │  │    (service worker)     │        │
│  └──────────┬───────────┘  └────────────┬────────────┘        │
│             │ POST                       │ POST                │
│             ▼                            ▼                     │
│  contactout.com/api/v5/   plugin-services.lusha.com/api/v2/   │
│  profiles/encrypted       search                              │
└───────────────────────────┬───────────────────────────────────┘
                            │ CDP Network Interception
                            ▼
┌───────────────────────────────────────────────────────────────┐
│  setupNetworkCapture.js                                        │
│  captureStore.pages[pageNum] = {                               │
│    lusha:      [{ firstName, lastName, domain }],              │
│    contactout: [{ firstName, lastName, domain, linkedinUrl }], │
│  }                                                             │
│  captureStore._latestSalesNavRecords = [{ fullName, ... }]     │
└───────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────┐
│  mergeData.js                                                  │
│  Sales Nav (BASE) → ContactOut domain → Lusha domain (wins)   │
│  LinkedIn URL priority: Lusha > ContactOut > SalesNav /in/    │
└───────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────┐
│  generateCSV.js → leads.csv + leads.xlsx (25 columns)         │
└───────────────────────────────────────────────────────────────┘
```

## Project Structure

```
vikileads-v3/
├── server.js
├── config.js
├── job-runner.js
├── package.json
├── routes/
│   ├── router.js
│   └── api.js
├── jobs/
│   └── manager.js
├── tasks/
│   ├── launchChrome.js
│   ├── connectBrowser.js
│   ├── navigateToLinkedIn.js
│   ├── scrollDashboard.js
│   ├── getPageInfo.js
│   ├── navigateNextPage.js
│   ├── nameCleaner.js
│   ├── activateContactOut.js
│   ├── activateLusha.js
│   ├── setupNetworkCapture.js
│   ├── mergeData.js
│   ├── generateCSV.js
│   ├── xlsxWriter.js
│   ├── emailFilter.js
│   ├── enrichLocation.js
│   └── pageTracker.js
├── public/
│   └── index.html
└── data/
    ├── settings.json
    └── {job-id}/
        ├── leads.jsonl
        ├── leads.csv
        └── leads.xlsx
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start Chrome with your extensions (ContactOut + Lusha)
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Chrome_Scraper"

# 3. Log into LinkedIn Sales Navigator in the Chrome window

# 4. Start the dashboard
npm start
# → http://localhost:3000
```

## Flow Per Page

1. **Scroll** — Human-like scroll (12-18 steps) loads all leads and triggers the Sales Nav API
2. **ContactOut** — Click floating button iframe → sidebar opens → API fires → captured via CDP
3. **Lusha** — Click badge → captured via CDP service worker intercept
4. **Wait** — Poll for all three responses (Sales Nav + ContactOut + Lusha)
5. **Merge** — Sales Nav base + ContactOut domain + Lusha domain (overwrites ContactOut)
6. **CSV/XLSX** — Append to JSONL → regenerate exports
7. **Next** — Click next page → repeat

## CSV Output Columns (25 total)

| Column | Source |
|--------|--------|
| Url Number | Job config |
| Page Number | Tracker |
| Company Name | Sales Nav |
| First Name | Sales Nav |
| Last Name | Sales Nav |
| Job Title | Sales Nav |
| About | Sales Nav |
| Premium | Sales Nav |
| Degree | Sales Nav |
| Position Current | Sales Nav |
| Position Start Month | Sales Nav |
| Position Start Year | Sales Nav |
| Person Sales Url | Sales Nav |
| **Person LinkedIn Url** | **Lusha > ContactOut > SalesNav /in/** |
| City | Sales Nav |
| State | Sales Nav |
| Country | Sales Nav |
| **Website_one** | **Lusha domain > ContactOut domain** |
| Company Linkedin | Sales Nav |
| Industry | Sales Nav |
| Company Full Address | Sales Nav |
| Company City | Sales Nav |
| Company State | Sales Nav |
| Company Country | Sales Nav |
| Company Description | Sales Nav |
