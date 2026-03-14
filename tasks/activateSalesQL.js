// ═══════════════════════════════════════════════════════════════════════════════
// 🟠 TASK: Activate SalesQL Extension — v3.2.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// KEY BEHAVIOUR (v3.2.0):
//   - Checks if sidebar is ALREADY OPEN before clicking the button.
//     If open → skip activation, data is already visible.
//   - Sidebar is minimized AFTER extraction is complete (before next page navigation).
//   - minimizeSalesQL() clicks the remove icon (._283pfsIaDQtBtkrPBTC8) inside the iframe.
//   - On re-activation next page: if sidebar still open, wait for cards to refresh.
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
    console.log('🟠 [SalesQL] Minimizing sidebar...');
    try {
        // TWO buttons share the same icon class _283pfsIaDQtBtkrPBTC8:
        //   button[0]: open_in_new  (external link — wrong)
        //   button[1]: remove       (minimize — correct)
        // Must filter by i.textContent === "remove".
        // Use Playwright .filter() with has-text to get the exact right button.

        // Strategy 1: button containing an <i> with exact text "remove"
        // Playwright :has-text matches trimmed textContent
        try {
            const removeBtn = page.locator('button.sql-button--medium-square').filter({
                has: page.locator('i', { hasText: /^\s*remove\s*$/i })
            });
            if (await removeBtn.count() > 0) {
                await removeBtn.first().click({ force: true, timeout: 3000 });
                console.log('✅ [SalesQL] Sidebar minimized (filter-remove-text)');
                return true;
            }
        } catch {}

        // Strategy 2: evaluate to get bounding rect of the "remove" icon, then click by coords
        const coords = await page.evaluate(() => {
            const icons = Array.from(document.querySelectorAll('i._283pfsIaDQtBtkrPBTC8, i.material-icons'));
            for (const icon of icons) {
                if ((icon.textContent || '').trim().toLowerCase() === 'remove') {
                    const btn = icon.closest('button') || icon.closest('[data-v-730c4c00]');
                    if (btn) {
                        const r = btn.getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                    }
                }
            }
            return null;
        }).catch(() => null);

        if (coords) {
            await page.mouse.click(coords.x, coords.y);
            console.log('✅ [SalesQL] Sidebar minimized (coords-click)');
            return true;
        }

        // Strategy 3: locator by text content on the <i> element itself
        try {
            const iRemove = page.locator('i._283pfsIaDQtBtkrPBTC8', { hasText: /^\s*remove\s*$/i });
            if (await iRemove.count() > 0) {
                await iRemove.first().click({ force: true, timeout: 3000 });
                console.log('✅ [SalesQL] Sidebar minimized (i-hasText-remove)');
                return true;
            }
        } catch {}

        // Strategy 4: all square buttons — the minimize is LAST (open_in_new comes first)
        try {
            const allBtns = page.locator('button.sql-button--medium-square');
            const total = await allBtns.count();
            if (total >= 2) {
                await allBtns.last().click({ force: true, timeout: 3000 });
                console.log('✅ [SalesQL] Sidebar minimized (last-square-btn)');
                return true;
            }
        } catch {}

        console.log('⚠️ [SalesQL] Minimize button not found');
        return false;

    } catch (err) {
        console.log(`⚠️ [SalesQL] Minimize error: ${err.message}`);
        return false;
    }
}


module.exports = { activateSalesQL, minimizeSalesQL };