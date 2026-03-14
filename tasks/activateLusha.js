// ═══════════════════════════════════════════════════════════════════════════════
// 🎯 TASK: Activate Lusha Extension — v3.2.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// v3.2.0 CHANGES:
//   - Sidebar stays OPEN after data extraction (no minimize).
//   - isLushaOpen() checks if the Lusha iframe is already visible with contacts.
//     If open → skip badge click, data already captured via network interception.
//   - minimizeLusha() is a no-op — kept for API compatibility but does nothing.
//   - On retry: if network data hasn't arrived but sidebar IS open, we just wait
//     longer rather than toggling the sidebar closed/open again.
// ═══════════════════════════════════════════════════════════════════════════════


// ── Check if Lusha sidebar is already open with contacts rendered ────────────
async function isLushaOpen(page) {
    try {
        // Check iframe exists and is visible
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const url  = frame.url();
                const name = frame.name();
                if (
                    url.includes('LU__extension_iframe') ||
                    name === 'LU__extension_iframe' ||
                    url.includes('lusha.com')
                ) {
                    // Frame is attached — check it has content (not zero-size)
                    const iframeEl = await page.$('iframe#LU__extension_iframe')
                        || await page.$('iframe[name="LU__extension_iframe"]');

                    if (iframeEl) {
                        const isVisible = await page.evaluate((el) => {
                            const rect = el.getBoundingClientRect();
                            const s = window.getComputedStyle(el);
                            return (
                                s.display !== 'none' &&
                                s.visibility !== 'hidden' &&
                                rect.width > 50 &&
                                rect.height > 100
                            );
                        }, iframeEl).catch(() => false);
                        if (isVisible) return true;
                    }

                    // Fallback: frame has contacts in DOM
                    const hasContacts = await frame.evaluate(() => {
                        return document.querySelectorAll('[data-test-id^="contact-"]').length > 0
                            || document.querySelectorAll('.bulk-contact-profile-container').length > 0
                            || document.querySelectorAll('.bulk-contact-full-name').length > 0;
                    }).catch(() => false);

                    if (hasContacts) return true;
                }
            } catch {}
        }
    } catch {}
    return false;
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVATE — click badge to trigger API; skip if sidebar already open
// ═══════════════════════════════════════════════════════════════════════════════
async function activateLusha(page) {
    console.log('🔵 [Lusha] Checking sidebar state...');

    try {
        // ── Skip if already open ─────────────────────────────────────────────
        const alreadyOpen = await isLushaOpen(page);
        if (alreadyOpen) {
            console.log('✅ [Lusha] Sidebar already open — skipping badge click');
            return true;
        }

        const lushaSelectors = [
            '#LU__extension_badge_main',
            '#LU__extension_badge_wrapper',
            'div[id="LU__extension_badge_main"]',
            '[id*="LU__extension_badge"]',
        ];

        let clicked = false;

        for (const selector of lushaSelectors) {
            try {
                const count = await page.locator(selector).count();
                if (count > 0) {
                    await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        if (el) { el.scrollIntoView({ block: 'center' }); el.click(); }
                    }, selector);
                    console.log('✅ [Lusha] Badge clicked — API triggered');
                    clicked = true;
                    break;
                }
            } catch {}
        }

        if (!clicked) {
            console.log('⚠️ [Lusha] Badge not found');
            return false;
        }

        // Wait briefly for iframe to appear
        for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(300);
            const frames = page.frames();
            const hasFrame = frames.some(f => {
                try {
                    return f.url().includes('LU__extension_iframe') ||
                           f.name() === 'LU__extension_iframe' ||
                           f.url().includes('lusha.com');
                } catch { return false; }
            });
            if (hasFrame) break;
        }

        await handleLushaPrivacyApproval(page);
        return true;

    } catch (error) {
        console.log(`⚠️ [Lusha] Activation error: ${error.message}`);
        return false;
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// NO MINIMIZE — sidebar stays open intentionally
// ═══════════════════════════════════════════════════════════════════════════════
async function minimizeLusha(page) {
    // Intentionally does nothing — sidebar stays open between pages.
    // Network capture catches the API response passively.
    console.log('🔵 [Lusha] Sidebar kept open (no minimize)');
    return true;
}


async function handleLushaPrivacyApproval(page) {
    try {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const url = frame.url();
                if (url.includes('lusha') || url.includes('LU__extension')) {
                    const clicked = await frame.evaluate(() => {
                        const button = document.querySelector('[data-test-id="privacy-approval-button"]')
                            || Array.from(document.querySelectorAll('button')).find(b =>
                                /got it,?\s*let'?s? go/i.test(b.textContent || '')
                            );
                        if (button) { button.click(); return true; }
                        return false;
                    }).catch(() => false);
                    if (clicked) {
                        console.log('✅ [Lusha] Privacy approval handled');
                        return true;
                    }
                }
            } catch {}
        }
    } catch {}
    return false;
}


module.exports = { activateLusha, minimizeLusha, isLushaOpen };
