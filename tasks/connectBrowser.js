// ═════════════════════════════════════════════════════════════════
// 🔌 TASK: Connect to Browser via CDP
// ═════════════════════════════════════════════════════════════════
// Fetches wsDebuggerUrl manually with Host: localhost header,
// then patches the URL for Docker before connecting Playwright.
// ═════════════════════════════════════════════════════════════════

const http = require('http');
const { chromium } = require('playwright');
const config = require('../config');

// Fetch /json/version with Host: localhost to get the WebSocket URL
function fetchWsUrl(cdpHost, port) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            `http://${cdpHost}:${port}/json/version`,
            { timeout: 5000, headers: { 'Host': 'localhost' } },
            (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try {
                        const wsUrl = JSON.parse(d).webSocketDebuggerUrl;
                        if (!wsUrl) return reject(new Error('No webSocketDebuggerUrl'));
                        resolve(wsUrl);
                    } catch (e) { reject(e); }
                });
            }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function connectToBrowser(cdpUrl) {
    console.log('🔌 Connecting to Chrome via CDP...');

    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

    const port = config.PORT || 9222;
    const cdpHost = config.CDP_HOST || '127.0.0.1';

    // Step 1: Get wsDebuggerUrl from Chrome (with Host: localhost header)
    const rawWsUrl = await fetchWsUrl(cdpHost, port);
    console.log(`📡 Raw wsUrl: ${rawWsUrl}`);

    // Step 2: Patch hostname — Chrome returns ws://localhost/... but
    // inside Docker we need ws://host.docker.internal:9222/...
    const u = new URL(rawWsUrl);
    u.hostname = cdpHost;
    u.port = String(port);
    const patchedWsUrl = u.toString();
    console.log(`🔗 Connecting to: ${patchedWsUrl}`);

    // Step 3: Connect Playwright directly to the patched WebSocket URL
    const browser = await chromium.connectOverCDP(patchedWsUrl, {
        headers: { 'Host': 'localhost' },
    });
    const context = browser.contexts()[0];

    console.log(`✅ Connected to browser (${context.pages().length} pages open)`);

    return { browser, context };
}

module.exports = { connectToBrowser };