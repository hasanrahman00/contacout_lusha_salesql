// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION FILE — v3.0.0
// ═══════════════════════════════════════════════════════════════════════════════

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

const fs   = require('fs');
const path = require('path');

// ── Load .env file (no dotenv package needed — pure Node fs) ─────────────────
// .env lives in the project root alongside config.js
// Format: KEY=value  (# comments supported, blank lines ignored)
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
    const envLines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n');
    for (const raw of envLines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) {
            process.env[key] = val;
        }
    }
}

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

const DEFAULTS = {
    CHROME_PATH: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    USER_DATA_DIR: 'C:\\Chrome_Scraper',
    PORT: 9222,
};

let userSettings = {};
try {
    if (fs.existsSync(SETTINGS_FILE)) {
        userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
} catch {}

const PORT = userSettings.PORT || DEFAULTS.PORT;

module.exports = {
    PORT,
    CDP_URL: `http://127.0.0.1:${PORT}`,
    CHROME_PATH:       userSettings.CHROME_PATH       || DEFAULTS.CHROME_PATH,
    USER_DATA_DIR:     userSettings.USER_DATA_DIR      || DEFAULTS.USER_DATA_DIR,
    DEEPSEEK_API_KEY:  process.env.DEEPSEEK_API_KEY || userSettings.DEEPSEEK_API_KEY || '',

    MAX_PAGES: 100,

    // ── Fast scroll settings (target 15-20s per page) ────────────────
    SCROLL_OPTIONS: {
        trackerSelector: "a[data-control-name^='view_lead_panel']",
        minSteps: 8,
        maxSteps: 12,
        stepPx: 350,
        minDelayMs: 250,
        maxDelayMs: 600,
        maxRounds: 20,
        bottomStallLimit: 3,
        pauseChance: 0,
        pauseMinMs: 0,
        pauseMaxMs: 0,
    },

    // Network URLs to intercept
    NETWORK_URLS: {
        LUSHA:      'plugin-services.lusha.com/api/v2/search',
        SALESNAV:   'linkedin.com/sales-api/salesApiLeadSearch',
        CONTACTOUT: 'contactout.com/api/v5/profiles/encrypted',
        SALESQL:    'api.salesql.com/extension2/search',
    },

    SETTINGS_FILE,
    DEFAULTS,
};