// ═══════════════════════════════════════════════════════════════════════════════
// 🟠 TASK: Activate SalesQL Extension — v3.2.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// KEY BEHAVIOUR (v3.2.0):
//   - Checks if sidebar is ALREADY OPEN before clicking the button.
//     If open → skip activation, data is already visible.
//   - Does NOT minimize the sidebar. Stays open for the entire page so that
//     extractSalesQL.js can read the DOM at any time.
//   - Sidebar persists between pages — on the next page, if still open,
//     we wait for the cards to refresh (new page data loads automatically).
//
// ACTIVATION SEQUENCE:
//   1. Detect SalesQL button via [data-v-step="0"] inside [data-v-0bc741d9]
//   2. Click to open sidebar (iframe#humanThirdPartyIframe)
//   3. Wait for contact cards to render inside the iframe DOM
// ═══════════════════════════════════════════════════════════════════════════════

const { isSalesQLOpen, waitForSalesQLCards, getSalesQLFrame } = require('./extractSalesQL');

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
async function humanDelay(page, minMs = 300, maxMs = 700) {
    await page.waitForTimeout(randInt(minMs, maxMs));
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVATE — open the sidebar (skip if already open)
// ═══════════════════════════════════════════════════════════════════════════════
async function activateSalesQL(page) {
    console.log('🟠 [SalesQL] Checking sidebar state...');

    try {
        // ── Skip if already open with cards rendered ─────────────────────────
        const alreadyOpen = await isSalesQLOpen(page);
        if (alreadyOpen) {
            console.log('✅ [SalesQL] Sidebar already open — skipping activation');
            // Still wait for cards to be fresh (new page data may load)
            await waitForSalesQLCards(page, 8000);
            return true;
        }

        await humanDelay(page, 400, 800);

        // ── Strategy 1: click [data-v-step="0"] in [data-v-0bc741d9] ─────────
        const clicked = await page.evaluate(() => {
            const btn = document.querySelector('[data-v-0bc741d9] [data-v-step="0"]')
                || document.querySelector('[data-v-step="0"]');
            if (btn) {
                btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mousedown',  { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('mouseup',    { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('click',      { bubbles: true, cancelable: true }));
                return true;
            }
            // Fallback: img[alt="SalesQL"]
            const img = Array.from(document.querySelectorAll('img[alt="SalesQL"]')).pop();
            if (img) {
                const target = img.closest('[data-v-step]') || img.closest('div') || img;
                target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return true;
            }
            return false;
        }).catch(() => false);

        if (!clicked) {
            // ── Strategy 2: Playwright locator ───────────────────────────────
            const selectors = [
                '[data-v-0bc741d9] [data-v-step="0"]',
                '[data-v-step="0"]',
                'img[alt="SalesQL"]',
            ];
            let found = false;
            for (const sel of selectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        await el.scrollIntoViewIfNeeded();
                        await el.click({ force: true });
                        found = true;
                        console.log(`✅ [SalesQL] Clicked via Playwright (${sel})`);
                        break;
                    }
                } catch {}
            }
            if (!found) {
                console.log('⚠️ [SalesQL] Button not found — extension may not be installed');
                return false;
            }
        } else {
            console.log('✅ [SalesQL] Button clicked');
        }

        // ── Wait for iframe to appear ─────────────────────────────────────────
        console.log('🟠 [SalesQL] Waiting for sidebar iframe...');
        let frameReady = false;
        for (let i = 0; i < 15; i++) {
            await humanDelay(page, 300, 500);
            const frame = await getSalesQLFrame(page);
            if (frame) { frameReady = true; console.log('✅ [SalesQL] Sidebar iframe detected'); break; }
        }

        if (!frameReady) {
            console.log('⚠️ [SalesQL] Sidebar iframe not detected');
            return false;
        }

        // ── Wait for contact cards to render ──────────────────────────────────
        const cardsReady = await waitForSalesQLCards(page, 12000);
        if (!cardsReady) {
            console.log('⚠️ [SalesQL] Cards did not render — sidebar may be loading');
        }

        return true;

    } catch (err) {
        console.log(`⚠️ [SalesQL] Activation error: ${err.message}`);
        return false;
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// NO MINIMIZE — sidebar stays open intentionally
// Called by job-runner during cleanup but is a no-op here.
// ═══════════════════════════════════════════════════════════════════════════════
async function minimizeSalesQL(page) {
    // Intentionally does nothing — sidebar stays open between pages.
    // SalesQL automatically refreshes its data when LinkedIn navigates.
    console.log('🟠 [SalesQL] Sidebar kept open (no minimize)');
    return true;
}


module.exports = { activateSalesQL, minimizeSalesQL };
