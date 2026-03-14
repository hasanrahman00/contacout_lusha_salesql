// ═══════════════════════════════════════════════════════════════════════════════
// 🟠 TASK: Extract SalesQL Data from Sidebar DOM — v3.2.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY DOM EXTRACTION:
//   SalesQL renders inside a cross-origin iframe (li.protechts.net).
//   Playwright's page.on('response') does NOT capture cross-origin iframe
//   requests. CDP browser-level auto-attach also fails on this Chrome setup
//   ("Only flatten protocol is supported"). So we read directly from the
//   rendered DOM inside the iframe.
//
// WHAT WE EXTRACT (from iframe#humanThirdPartyIframe DOM):
//   fullName     — lead name (emoji flags stripped, cleanName applied)
//   firstName    — split from fullName
//   lastName     — split from fullName
//   emailCount   — number shown next to email icon (0 if "-")
//   phoneCount   — number shown next to phone icon (0 if "-")
//   hasEmail     — emailCount > 0
//   hasPhone     — phoneCount > 0
//
// NOTE: SalesQL does NOT expose actual email/phone values in the list DOM.
//       Those only appear when each contact card is expanded individually.
//       emailCount and phoneCount serve as availability flags — useful for
//       filtering/prioritising which leads have data in SalesQL.
//
// SIDEBAR OPEN STATE:
//   isSalesQLOpen(page) — returns true if the SalesQL sidebar iframe is
//   present and visible. Used by job-runner to skip re-activation.
// ═══════════════════════════════════════════════════════════════════════════════

const { cleanName } = require('./nameCleaner');

// ── DOM selectors (from SalesQL's Vue component structure) ───────────────────
// Each contact card: [data-v-280abf87] > ._25WT7RV_Ip1vuc3YEWcv
// Name div (first el-tooltip with class _33a0OhsIbT8IXiry0hAD)
// Email count: div after <i> with text "email"
// Phone count: div after <i> with text "phone"

const CARD_SELECTOR      = '._25WT7RV_Ip1vuc3YEWcv';
const NAME_SELECTOR      = '._33a0OhsIbT8IXiry0hAD';
const COUNT_PARENT_SEL   = '._2QmtDzLJNPsNTLAgOodZ';
const COUNT_VALUE_SEL    = '._1BGbvytcPPq4CpQsvAen._21sclVFAWvFzj1gK3u7N';


// ═══════════════════════════════════════════════════════════════════════════════
// CHECK IF SALESQL SIDEBAR IS OPEN
// ═══════════════════════════════════════════════════════════════════════════════
async function isSalesQLOpen(page) {
    try {
        // Check 1: iframe#humanThirdPartyIframe exists and is visible
        const iframeEl = await page.$('iframe#humanThirdPartyIframe');
        if (!iframeEl) return false;

        const isVisible = await page.evaluate((el) => {
            if (!el) return false;
            const style = el.style;
            const rect  = el.getBoundingClientRect();
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 100 &&
                rect.height > 100
            );
        }, iframeEl).catch(() => false);

        if (!isVisible) return false;

        // Check 2: at least one contact card is rendered inside the iframe
        const frame = await iframeEl.contentFrame().catch(() => null);
        if (!frame) return false;

        const hasCards = await frame.evaluate((sel) => {
            return document.querySelectorAll(sel).length > 0;
        }, CARD_SELECTOR).catch(() => false);

        return hasCards;
    } catch {
        return false;
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// WAIT FOR SALESQL CONTACT CARDS TO RENDER IN THE SIDEBAR
// ═══════════════════════════════════════════════════════════════════════════════
async function waitForSalesQLCards(page, timeoutMs = 15000) {
    const start = Date.now();
    const interval = 400;

    while (Date.now() - start < timeoutMs) {
        try {
            const frame = await getSalesQLFrame(page);
            if (frame) {
                const count = await frame.evaluate((sel) => {
                    return document.querySelectorAll(sel).length;
                }, CARD_SELECTOR).catch(() => 0);

                if (count > 0) {
                    console.log(`✅ [SalesQL Extract] ${count} contact cards found in DOM`);
                    return true;
                }
            }
        } catch {}
        await new Promise(r => setTimeout(r, interval));
    }

    console.log('⚠️ [SalesQL Extract] Timed out waiting for contact cards');
    return false;
}


// ═══════════════════════════════════════════════════════════════════════════════
// GET SALESQL SIDEBAR FRAME
// ═══════════════════════════════════════════════════════════════════════════════
async function getSalesQLFrame(page) {
    try {
        const el = await page.$('iframe#humanThirdPartyIframe');
        if (el) {
            const frame = await el.contentFrame().catch(() => null);
            if (frame) return frame;
        }
    } catch {}

    // Fallback: scan all frames
    for (const frame of page.frames()) {
        try {
            const url = frame.url();
            if (url.includes('protechts') || url.includes('salesql')) return frame;
        } catch {}
    }

    return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACT CONTACT DATA FROM SALESQL SIDEBAR DOM
// ═══════════════════════════════════════════════════════════════════════════════
async function extractSalesQLData(page) {
    console.log('🟠 [SalesQL Extract] Reading contact cards from sidebar DOM...');

    try {
        const frame = await getSalesQLFrame(page);
        if (!frame) {
            console.log('⚠️ [SalesQL Extract] Sidebar frame not found');
            return [];
        }

        // Wait a moment for Vue reactivity to finish rendering
        await page.waitForTimeout(800);

        const rawCards = await frame.evaluate(({ cardSel, nameSel, countParentSel, countValSel }) => {
            const cards = Array.from(document.querySelectorAll(cardSel));
            const results = [];

            for (const card of cards) {
                const nameEl = card.querySelector(nameSel);
                const rawName = (nameEl ? nameEl.textContent : '').trim();
                if (!rawName) continue;

                let emailCount = 0;
                let phoneCount = 0;

                const countParent = card.querySelector(countParentSel);
                if (countParent) {
                    const slots = countParent.querySelectorAll('._1IykDkcPAY4A7-huH3KZ');
                    for (const slot of slots) {
                        const iconEl = slot.querySelector('i.material-icons-outlined');
                        const valEl  = slot.querySelector(countValSel);
                        if (!iconEl || !valEl) continue;
                        const iconText = (iconEl.textContent || '').trim().toLowerCase();
                        const valText  = (valEl.textContent  || '').trim();
                        const num = valText === '-' ? 0 : (parseInt(valText, 10) || 0);
                        if (iconText === 'email') emailCount = num;
                        if (iconText === 'phone') phoneCount = num;
                    }
                }

                results.push({ rawName, emailCount, phoneCount });
            }

            return results;
        }, { cardSel: CARD_SELECTOR, nameSel: NAME_SELECTOR, countParentSel: COUNT_PARENT_SEL, countValSel: COUNT_VALUE_SEL }).catch((err) => {
            console.log(`⚠️ [SalesQL Extract] DOM eval error: ${err.message}`);
            return [];
        });

        if (rawCards.length === 0) {
            console.log('⚠️ [SalesQL Extract] No contact cards found in DOM');
            return [];
        }

        // ── Clean names and build records ─────────────────────────────────────
        const records = [];
        for (const card of rawCards) {
            // Strip emoji flags and special characters from name
            const nameNoEmoji = card.rawName
                .replace(/[\u{1F1E0}-\u{1F1FF}]{2}/gu, '')  // flag emoji pairs
                .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')       // other emoji
                .replace(/[\u{2600}-\u{27BF}]/gu, '')          // misc symbols
                .trim();

            const cleanedFull = cleanName(nameNoEmoji);
            if (!cleanedFull) continue;

            const nameParts = cleanedFull.split(/\s+/);
            const firstName = nameParts[0] || '';
            const lastName  = nameParts.slice(1).join(' ') || '';

            records.push({
                firstName,
                lastName,
                fullName:    cleanedFull,
                emailCount:  card.emailCount,
                phoneCount:  card.phoneCount,
                hasEmail:    card.emailCount > 0,
                hasPhone:    card.phoneCount > 0,
                // These are set later by merge if network capture ever works
                salesqlEmail: '',
                salesqlPhone: '',
                domain:       '',
            });
        }

        const withEmail = records.filter(r => r.hasEmail).length;
        const withPhone = records.filter(r => r.hasPhone).length;
        console.log(`🟢 [SalesQL Extract] Extracted ${records.length} contacts — ${withEmail} have email, ${withPhone} have phone`);

        return records;

    } catch (err) {
        console.log(`⚠️ [SalesQL Extract] Error: ${err.message}`);
        return [];
    }
}


module.exports = { extractSalesQLData, isSalesQLOpen, waitForSalesQLCards, getSalesQLFrame };
