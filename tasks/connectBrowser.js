// ═════════════════════════════════════════════════════════════════
// 🔌 TASK: Connect to Browser via CDP
// ═════════════════════════════════════════════════════════════════
// Purpose: Connect Playwright to running Chrome instance
// ═════════════════════════════════════════════════════════════════

const { chromium } = require('playwright');

async function connectToBrowser(cdpUrl) {
    console.log('🔌 Connecting to Chrome via CDP...');
    
    // 🌐 Allow Playwright to see extension pages
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
    
    // 🔗 Connect to Chrome
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    
    console.log(`✅ Connected to browser (${context.pages().length} pages open)`);
    
    return { browser, context };
}

module.exports = { connectToBrowser };
