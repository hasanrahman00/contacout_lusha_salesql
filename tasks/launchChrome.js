// ═════════════════════════════════════════════════════════════════
// 🚀 TASK: Launch Chrome with Debugging
// ═════════════════════════════════════════════════════════════════
// Purpose: Start Chrome with remote debugging enabled
// Reuses existing Chrome if already running on the debug port
// ═════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');

async function isChromeRunning(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
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

    console.log('🚀 Launching Chrome with debugging...');

    // 🔧 Spawn Chrome process with debugging flags
    const chromeProcess = spawn(chromePath, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`
    ], {
        detached: true,
        stdio: 'ignore'
    });

    chromeProcess.unref();

    console.log(`✅ Chrome launched on port ${port}`);

    // ⏰ Wait for Chrome to start up
    await new Promise(resolve => setTimeout(resolve, 5000));

    return chromeProcess;
}

module.exports = { launchChrome };
