// ═════════════════════════════════════════════════════════════════
// ➡️ TASK: Navigate to Next Page
// ═════════════════════════════════════════════════════════════════
// Purpose: Click next button and verify page change
// No external dependencies - all logic self-contained
// ═════════════════════════════════════════════════════════════════

// 🔧 Helper: Get page info from URL/DOM
async function getPageInfo(page) {
    return page.evaluate(() => {
        const url = window.location.href;
        let pageNumber = null;
        
        try {
            const u = new URL(url);
            const p = u.searchParams.get('page');
            if (p) {
                const n = Number(p);
                pageNumber = Number.isFinite(n) ? n : null;
            }
        } catch (e) {
            // ignore
        }
        
        if (!pageNumber) {
            const active = document.querySelector('[aria-current="true"]')
                || document.querySelector('.artdeco-pagination__indicator--number.active')
                || document.querySelector('li.artdeco-pagination__indicator--number.active');
            if (active) {
                const text = (active.textContent || '').trim();
                const m = text.match(/\d+/);
                if (m) {
                    pageNumber = Number(m[0]);
                }
            }
        }
        
        return { url, pageNumber };
    });
}

// 🔧 Helper: Get first lead's key (text + href)
async function getLeadListKey(page) {
    return page.evaluate(() => {
        const selectors = [
            'a[data-control-name^="view_lead_panel"]',
            'div.search-results__result-item a',
            'li.search-results__result-item a',
            'a[data-test-search-result-link]'
        ];
        
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const text = (el.textContent || '').trim();
                const href = el.getAttribute('href') || '';
                if (text || href) {
                    return text + '||' + href;
                }
            }
        }
        return null;
    });
}

async function goToNextPage(page, currentPageNum) {
    
    console.log('➡️ Moving to next page...');
    
    const timeoutMs = 15000;
    
    // 🔍 Find next button
    const nextSelectors = [
        "button[aria-label='Next'].artdeco-pagination__button--next",
        "button.artdeco-pagination__button--next",
        "button[aria-label='Next']"
    ];
    
    let nextBtn = null;
    for (const selector of nextSelectors) {
        try {
            nextBtn = await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
            if (nextBtn) break;
        } catch (e) {
            continue;
        }
    }
    
    if (!nextBtn) {
        console.log(`🛑 Next button not found`);
        return { success: false, reason: "next-button-not-found" };
    }
    
    // ⚠️ Check if disabled (last page)
    const disabled = await nextBtn.getAttribute("disabled");
    const ariaDisabled = await nextBtn.getAttribute("aria-disabled");
    
    if (disabled !== null || String(ariaDisabled).toLowerCase() === "true") {
        console.log(`🛑 Reached last page`);
        return { success: false, reason: "disabled" };
    }
    
    // 📸 Capture state before clicking
    const before = await getPageInfo(page);
    const beforeLeadKey = await getLeadListKey(page).catch(() => null);
    
    // 🖱️ Click next button
    try {
        await nextBtn.click();
    } catch (error) {
        await page.evaluate(btn => btn.click(), nextBtn);
    }
    
    // ⏳ Wait for URL/page number to change
    try {
        await page.waitForFunction(
            (beforeUrl, beforePage) => {
                const url = window.location.href;
                let pageNumber = null;
                try {
                    const u = new URL(url);
                    const p = u.searchParams.get('page');
                    if (p) pageNumber = Number(p);
                } catch (e) {}
                return url !== beforeUrl || pageNumber !== beforePage;
            },
            { timeout: timeoutMs },
            before.url,
            before.pageNumber
        );
    } catch (error) {
        console.log(`🛑 Page change timeout`);
        return { success: false, reason: "page-change-timeout" };
    }
    
    // ⏳ Wait for lead list to refresh
    if (beforeLeadKey) {
        try {
            await page.waitForFunction(
                (beforeKey) => {
                    const selectors = [
                        'a[data-control-name^="view_lead_panel"]',
                        'div.search-results__result-item a',
                        'li.search-results__result-item a',
                        'a[data-test-search-result-link]'
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) {
                            const text = (el.textContent || '').trim();
                            const href = el.getAttribute('href') || '';
                            const key = text + '||' + href;
                            if (key && key !== beforeKey) return true;
                        }
                    }
                    return false;
                },
                { timeout: timeoutMs },
                beforeLeadKey
            );
        } catch (error) {
            console.log(`🛑 Lead list refresh timeout`);
            return { success: false, reason: "leadlist-timeout" };
        }
    }
    
    // 💤 Brief stabilize wait (reduced from 2s)
    await page.waitForTimeout(500);
    
    const after = await getPageInfo(page);
    
    // ✅ Verify we moved to expected page
    if (currentPageNum && after.pageNumber && after.pageNumber !== (currentPageNum + 1)) {
        console.log(`⚠️ Page mismatch - expected ${currentPageNum + 1}, got ${after.pageNumber} (continuing anyway)`);
    }
    
    console.log(`✅ Moved to page ${after.pageNumber || 'next'}`);
    return { success: true, pageNumber: after.pageNumber };
}

module.exports = { goToNextPage };
