// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION FILE — v3.7.0
// ═══════════════════════════════════════════════════════════════════════════════
// Priority: process.env (Docker/system) → .env file → settings.json (dashboard) → defaults
// ═══════════════════════════════════════════════════════════════════════════════

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

const fs   = require('fs');
const path = require('path');

// ── Load .env file (pure Node, no dotenv) ───────────────────────────────────
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
    for (const raw of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
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

// ── Dashboard settings.json (UI overrides, lowest priority) ─────────────────
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
let dashSettings = {};
try {
    if (fs.existsSync(SETTINGS_FILE)) {
        dashSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
} catch {}

// ── Helper: env var → dashboard setting → default ───────────────────────────
const env = (key, fallback) => process.env[key] || dashSettings[key] || fallback;

// ── Resolved config ─────────────────────────────────────────────────────────
const CHROME_PATH   = env('CHROME_PATH',   '');
const USER_DATA_DIR = env('USER_DATA_DIR',  '');
const PORT          = parseInt(env('CDP_PORT', '9222'), 10);
const CDP_HOST      = env('CDP_HOST', '127.0.0.1');

module.exports = {
    // Chrome
    CHROME_PATH,
    USER_DATA_DIR,
    PORT,

    // CDP connection
    CDP_HOST,
    CDP_URL: `http://${CDP_HOST}:${PORT}`,

    // API keys
    DEEPSEEK_API_KEY: env('DEEPSEEK_API_KEY', ''),

    // Scraper
    MAX_PAGES: parseInt(env('MAX_PAGES', '100'), 10),

    // UI controls (set via docker-compose environment)
    HIDE_LOGS:     env('HIDE_LOGS', '')     === 'true',
    HIDE_SETTINGS: env('HIDE_SETTINGS', '') === 'true',

    // Fast scroll settings
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

    // For dashboard settings page
    SETTINGS_FILE,
    DEFAULTS: { CHROME_PATH, USER_DATA_DIR, PORT },
};