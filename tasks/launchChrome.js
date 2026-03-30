// ═════════════════════════════════════════════════════════════════
// 🚀 TASK: Launch Chrome with Debugging
// ═════════════════════════════════════════════════════════════════
// LOCAL MODE  (CHROME_PATH set) → auto-launch if not running, reuse if running
// DOCKER MODE (CHROME_PATH empty) → connect only, clear error if not reachable
// ═════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const config = require('../config');

async function isChromeRunning(port) {
    try {
        const res = await fetch(`http://${config.CDP_HOST}:${port}/json/version`, {
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.Browser) return true;
        }
    } catch {
        // Not running or not reachable
    }
    return false;
}

async function launchChrome(chromePath, port, userDataDir) {
    // Check if Chrome is already running on the debug port
    const alreadyRunning = await isChromeRunning(port);
    if (alreadyRunning) {
        console.log(`✅ Chrome already running on port ${port}, reusing existing window.`);
        return null;
    }

    // ── Docker / remote mode: no CHROME_PATH means we can't launch ──────
    if (!chromePath) {
        throw new Error(
            `Chrome is not reachable on ${config.CDP_HOST}:${port}.\n` +
            `Launch Chrome manually with:\n` +
            `  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ` +
            `--remote-debugging-port=${port} --remote-allow-origins=* ` +
            `--user-data-dir="C:\\Chrome_Scraper"`
        );
    }

    // ── Local mode: auto-launch Chrome ──────────────────────────────────
    console.log('🚀 Launching Chrome with debugging...');

    const chromeProcess = spawn(chromePath, [
        `--remote-debugging-port=${port}`,
        `--remote-allow-origins=*`,
        `--user-data-dir=${userDataDir}`
    ], {
        detached: true,
        stdio: 'ignore'
    });

    chromeProcess.unref();

    // Wait for Chrome to start, then verify it's reachable
    console.log(`⏳ Waiting for Chrome to start on port ${port}...`);
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isChromeRunning(port)) {
            console.log(`✅ Chrome launched and ready on port ${port}`);
            return chromeProcess;
        }
    }

    console.log(`⚠️ Chrome launched but not yet responding — continuing anyway`);
    return chromeProcess;
}

module.exports = { launchChrome };