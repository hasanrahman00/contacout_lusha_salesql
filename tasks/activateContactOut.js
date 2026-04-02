// ═══════════════════════════════════════════════════════════════════════════════
// 🟣 TASK: Activate & Minimize ContactOut Extension — v2.7.1
// ═══════════════════════════════════════════════════════════════════════════════
//
// KEY FINDING: ContactOut injects TWO iframes into the page:
//
//   1. BUTTON IFRAME (small, always visible on right edge):
//      <iframe id="90RSCh5" style="width:32px; height:84px; ..."
//              src="https://contactout.com/extension/action button/497">
//        └─ <div id="app">
//           └─ <button id="floating-button" class="floating-button">
//              └─ <img alt="contactout" ...>
//
//   2. SIDEBAR IFRAME (large, appears after clicking the button):
//      <iframe style="position:fixed; width:640px; height:100%; ..."
//              src="https://contactout.com/...">
//        └─ Contains profile data + rollup/minimize button
//
// Both live in the MAIN PAGE DOM as injected iframes (not in main page body).
// We must find the iframe element first → get its contentFrame → interact inside.
//
// SMOOTH OPEN/CLOSE:
//   - Human-like delay before/after actions
//   - Hover → click sequence for natural interaction
//   - Settle delays for sidebar animation
// ═══════════════════════════════════════════════════════════════════════════════

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── Smooth human-like delay ──────────────────────────────────────────────────
async function humanDelay(page, minMs = 150, maxMs = 400) {
    await page.waitForTimeout(randInt(minMs, maxMs));
}


// ═══════════════════════════════════════════════════════════════════════════════
// FIND CONTACTOUT BUTTON IFRAME (the small floating button)
// ═══════════════════════════════════════════════════════════════════════════════
// Src pattern: contactout.com/extension/action
// Characteristics: small (width ~32px), contains #floating-button
// ═══════════════════════════════════════════════════════════════════════════════
async function getContactOutButtonFrame(page) {
    // Method 1: Search all page frames by URL
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const url = frame.url();
            if (url.includes('contactout.com/extension/action')) {
                return frame;
            }
        } catch {}
    }

    // Method 2: Find iframe element in main DOM by src attribute
    const iframeSelectors = [
        'iframe[src*="contactout.com/extension/action"]',
        'iframe[src*="contactout.com/extension"]',
    ];

    for (const sel of iframeSelectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                const frame = await el.contentFrame();
                if (frame) return frame;
            }
        } catch {}
    }

    // Method 3: Brute force — check ALL iframes via contentFrame().url()
    // KEY FIX: Extension-injected iframes often have NO src attribute in the DOM.
    // The extension navigates them programmatically, so we must check the
    // contentFrame's actual URL instead of relying on getAttribute('src').
    const allIframes = await page.$$('iframe');
    for (const iframeEl of allIframes) {
        try {
            const frame = await iframeEl.contentFrame();
            if (!frame) continue;
            const frameUrl = frame.url();
            if (frameUrl && frameUrl.includes('contactout.com/extension/action')) {
                return frame;
            }
        } catch {}
    }

    // Method 4: Find by visual fingerprint — small iframe with ContactOut's
    // purple box-shadow: rgba(101, 82, 255, ...) and ~32px width
    for (const iframeEl of allIframes) {
        try {
            const match = await page.evaluate((el) => {
                const s = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                // ContactOut button: ~32px wide, ~84px tall, purple shadow
                const isSmall = rect.width > 20 && rect.width < 60 && rect.height > 50 && rect.height < 120;
                const hasPurpleShadow = (s.boxShadow || '').includes('101') && (s.boxShadow || '').includes('82') && (s.boxShadow || '').includes('255');
                return isSmall && hasPurpleShadow;
            }, iframeEl);

            if (match) {
                const frame = await iframeEl.contentFrame();
                if (frame) {
                    console.log('✅ [ContactOut] Found button iframe via visual fingerprint');
                    return frame;
                }
            }
        } catch {}
    }

    // Method 5: Find any small contactout iframe by checking contentFrame URL broadly
    for (const iframeEl of allIframes) {
        try {
            const frame = await iframeEl.contentFrame();
            if (!frame) continue;
            const frameUrl = frame.url();
            if (frameUrl && frameUrl.includes('contactout')) {
                // Verify it's the button (small) not the sidebar (large)
                const isSmall = await page.evaluate((el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width < 100;
                }, iframeEl);
                if (isSmall) return frame;
            }
        } catch {}
    }

    // Method 6: Check frames that have the floating button DOM
    for (const frame of frames) {
        try {
            const url = frame.url();
            if (!url.includes('contactout')) continue;
            const hasBtn = await frame.evaluate(() => {
                return !!document.querySelector('#floating-button');
            }).catch(() => false);
            if (hasBtn) return frame;
        } catch {}
    }

    return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// FIND CONTACTOUT SIDEBAR IFRAME (the large panel with data + rollup button)
// ═══════════════════════════════════════════════════════════════════════════════
// Characteristics: large (width ~640px), position:fixed, contains profile data
// ═══════════════════════════════════════════════════════════════════════════════
async function getContactOutSidebarFrame(page) {
    // Method 1: Search all frames for ContactOut sidebar URLs
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const url = frame.url();
            // Sidebar URL is different from the action button URL
            if (url.includes('contactout.com') && !url.includes('/extension/action')) {
                // Verify it has the rollup/minimize button or profile content
                const isSidebar = await frame.evaluate(() => {
                    return !!(
                        document.querySelector('[data-testid="rollup-button"]') ||
                        document.querySelector('.header-actions__rollup-button') ||
                        document.querySelector('.co-minus') ||
                        document.querySelector('[class*="profile"]') ||
                        document.querySelector('[class*="sidebar"]')
                    );
                }).catch(() => false);
                if (isSidebar) return frame;
            }
        } catch {}
    }

    // Method 2: Find large ContactOut iframe in DOM by src attribute
    const allIframes = await page.$$('iframe');
    for (const iframeEl of allIframes) {
        try {
            const src = await iframeEl.getAttribute('src');
            if (src && src.includes('contactout') && !src.includes('/extension/action')) {
                const frame = await iframeEl.contentFrame();
                if (frame) return frame;
            }
        } catch {}
    }

    // Method 3: Check ALL iframes via contentFrame().url() — handles no-src iframes
    for (const iframeEl of allIframes) {
        try {
            const frame = await iframeEl.contentFrame();
            if (!frame) continue;
            const frameUrl = frame.url();
            if (frameUrl && frameUrl.includes('contactout.com') && !frameUrl.includes('/extension/action')) {
                // Verify it's the sidebar (large width)
                const isLarge = await page.evaluate((el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 200;
                }, iframeEl);
                if (isLarge) return frame;
            }
        } catch {}
    }

    // Method 4: Find by style — sidebar is typically 640px wide, position:fixed
    for (const iframeEl of allIframes) {
        try {
            const frame = await iframeEl.contentFrame();
            if (!frame) continue;
            const frameUrl = frame.url();
            if (!frameUrl || !frameUrl.includes('contactout')) continue;

            const isLarge = await page.evaluate((el) => {
                const style = el.style || {};
                const rect = el.getBoundingClientRect();
                return rect.width > 200 || (style.width && parseInt(style.width) > 200);
            }, iframeEl);

            if (isLarge) return frame;
        } catch {}
    }

    return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVATE — Find button iframe → click #floating-button inside it
// ═══════════════════════════════════════════════════════════════════════════════
async function activateContactOut(page) {
    console.log('🟣 [ContactOut] Activating extension...');

    try {
        // ── Step 1: Wait for lead cards to be present ────────────────────
        try {
            await page.waitForSelector(
                "a[data-control-name^='view_lead_panel']",
                { state: 'visible', timeout: 5000 }
            );
            console.log('✅ [ContactOut] Lead cards visible');
        } catch {
            console.log('⚠️ [ContactOut] Lead cards not visible — trying anyway');
        }

        // ── Step 2: Small human-like pause before clicking ───────────────
        await humanDelay(page, 200, 400);

        // ── Step 3: Find the ContactOut BUTTON IFRAME ────────────────────
        let buttonFrame = null;

        // Poll for the iframe (it may take a moment to inject)
        for (let attempt = 0; attempt < 6; attempt++) {
            buttonFrame = await getContactOutButtonFrame(page);
            if (buttonFrame) break;
            console.log(`🟣 [ContactOut] Button iframe not found, polling... (${attempt + 1}/6)`);
            await humanDelay(page, 300, 500);
        }

        if (!buttonFrame) {
            // ── FALLBACK: Find iframe element by visual fingerprint and click via coordinates ──
            // Extension iframes may block contentFrame() access but we can still click them
            console.log('🟣 [ContactOut] Trying coordinate-click fallback...');
            const allIframes = await page.$$('iframe');
            let clickedViaCoords = false;

            for (const iframeEl of allIframes) {
                try {
                    const match = await page.evaluate((el) => {
                        const s = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        const isSmall = rect.width > 20 && rect.width < 60 && rect.height > 50 && rect.height < 120;
                        const hasPurpleShadow = (s.boxShadow || '').includes('101') && (s.boxShadow || '').includes('255');
                        const isFixed = s.position === 'fixed';
                        // Also check by id pattern — ContactOut uses random-looking short ids
                        const hasContactOutStyle = (s.borderRadius || '').includes('4px') && rect.width < 50;
                        return (isSmall && (hasPurpleShadow || isFixed)) || (isSmall && hasContactOutStyle);
                    }, iframeEl);

                    if (match) {
                        const box = await iframeEl.boundingBox();
                        if (box) {
                            const x = box.x + box.width / 2;
                            const y = box.y + box.height / 2;
                            await page.mouse.click(x, y);
                            console.log(`✅ [ContactOut] Clicked button iframe via coordinates (${Math.round(x)}, ${Math.round(y)})`);
                            clickedViaCoords = true;
                            break;
                        }
                    }
                } catch {}
            }

            if (!clickedViaCoords) {
                console.log('⚠️ [ContactOut] Button iframe not found — extension may not be installed');
                return false;
            }

            // Wait for sidebar to open after coordinate click
            console.log('🟣 [ContactOut] Waiting for sidebar to open...');
            await humanDelay(page, 400, 800);
            return true;
        }

        console.log('✅ [ContactOut] Button iframe found');

        // ── Step 4: Click #floating-button INSIDE the iframe ─────────────
        await humanDelay(page, 200, 400);

        const clicked = await buttonFrame.evaluate(() => {
            const btn = document.querySelector('#floating-button')
                || document.querySelector('button.floating-button')
                || document.querySelector('#app button');
            if (btn) {
                // Simulate real hover → click sequence
                btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mousedown',  { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('mouseup',    { bubbles: true, cancelable: true }));
                btn.dispatchEvent(new MouseEvent('click',      { bubbles: true, cancelable: true }));
                return true;
            }
            return false;
        }).catch(() => false);

        if (!clicked) {
            // Fallback: try clicking the img inside
            const imgClicked = await buttonFrame.evaluate(() => {
                const img = document.querySelector('img[alt="contactout"]')
                    || document.querySelector('img.logo-text');
                if (img) {
                    const target = img.closest('button') || img.parentElement || img;
                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return true;
                }
                return false;
            }).catch(() => false);

            if (!imgClicked) {
                console.log('⚠️ [ContactOut] Floating button not clickable inside iframe');
                return false;
            }
            console.log('✅ [ContactOut] Clicked via img fallback');
        } else {
            console.log('✅ [ContactOut] Floating button clicked');
        }

        // ── Step 5: Wait for sidebar to smoothly open ────────────────────
        console.log('🟣 [ContactOut] Waiting for sidebar to open...');

        let sidebarReady = false;
        for (let i = 0; i < 8; i++) {
            await humanDelay(page, 200, 350);

            const sidebarFrame = await getContactOutSidebarFrame(page);
            if (sidebarFrame) {
                sidebarReady = true;
                console.log('✅ [ContactOut] Sidebar iframe detected');
                break;
            }
        }

        if (!sidebarReady) {
            console.log('⚠️ [ContactOut] Sidebar not detected — API call may still fire via network');
        }

        // ── Step 6: Short settle delay — let the API call complete ──────
        await humanDelay(page, 400, 800);

        return true;

    } catch (error) {
        console.log(`⚠️ [ContactOut] Activation error: ${error.message}`);
        return false;
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// MINIMIZE — Smoothly close the sidebar
// ═══════════════════════════════════════════════════════════════════════════════
// The rollup button is INSIDE the sidebar iframe:
//   <button class="header-actions__rollup-button" data-testid="rollup-button">
//     <span class="co-minus"></span>
//   </button>
// ═══════════════════════════════════════════════════════════════════════════════
async function minimizeContactOut(page) {
    try {
        console.log('🟣 [ContactOut] Minimizing sidebar...');

        await humanDelay(page, 100, 250);

        // ── Method 1: Find sidebar iframe → click rollup inside it ───────
        const sidebarFrame = await getContactOutSidebarFrame(page);
        if (sidebarFrame) {
            const minimized = await sidebarFrame.evaluate(() => {
                const btn = document.querySelector('button[data-testid="rollup-button"]')
                    || document.querySelector('.header-actions__rollup-button')
                    || document.querySelector('[data-testid="rollup-button"]');
                if (btn) {
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return 'rollup';
                }
                const minus = document.querySelector('.co-minus');
                if (minus) {
                    const target = minus.closest('button') || minus;
                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return 'co-minus';
                }
                const closeBtn = document.querySelector('[class*="minimize"]')
                    || document.querySelector('[class*="rollup"]')
                    || document.querySelector('[class*="close-btn"]');
                if (closeBtn) {
                    const target = closeBtn.closest('button') || closeBtn;
                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return 'close-fallback';
                }
                return null;
            }).catch(() => null);

            if (minimized) {
                await humanDelay(page, 150, 300);
                console.log(`✅ [ContactOut] Sidebar minimized (${minimized})`);
                return true;
            }
        }

        // ── Method 2: Search ALL contactout iframes for rollup button ────
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const url = frame.url();
                if (!url.includes('contactout')) continue;

                const clicked = await frame.evaluate(() => {
                    const btn = document.querySelector('button[data-testid="rollup-button"]')
                        || document.querySelector('.header-actions__rollup-button')
                        || document.querySelector('.co-minus');
                    if (btn) {
                        const target = btn.closest('button') || btn;
                        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        return true;
                    }
                    return false;
                }).catch(() => false);

                if (clicked) {
                    await humanDelay(page, 150, 300);
                    console.log('✅ [ContactOut] Sidebar minimized (frame scan)');
                    return true;
                }
            } catch {}
        }

        // ── Method 3: Toggle via floating button again ───────────────────
        const buttonFrame = await getContactOutButtonFrame(page);
        if (buttonFrame) {
            const toggled = await buttonFrame.evaluate(() => {
                const btn = document.querySelector('#floating-button')
                    || document.querySelector('#app button');
                if (btn) {
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return true;
                }
                return false;
            }).catch(() => false);

            if (toggled) {
                await humanDelay(page, 150, 300);
                console.log('✅ [ContactOut] Sidebar toggled closed (button iframe)');
                return true;
            }
        }

        console.log('⚠️ [ContactOut] Minimize button not found');
        return false;

    } catch (error) {
        console.log(`⚠️ [ContactOut] Minimize error: ${error.message}`);
        return false;
    }
}


module.exports = { activateContactOut, minimizeContactOut, getContactOutButtonFrame, getContactOutSidebarFrame };