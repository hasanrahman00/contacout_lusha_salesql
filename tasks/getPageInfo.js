// ═════════════════════════════════════════════════════════════════
// 📋 TASK: Get Current Page Info
// ═════════════════════════════════════════════════════════════════
// Purpose: Retrieve current page number and URL from LinkedIn pagination
// No external dependencies - all logic self-contained
// ═════════════════════════════════════════════════════════════════

async function getCurrentPageInfo(page) {
    
    console.log('📊 Getting current page info...');
    
    // 📍 Extract page info from URL and DOM
    const pageInfo = await page.evaluate(() => {
        const url = window.location.href;
        let pageNumber = null;
        
        // Try to get page number from URL parameter
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
        
        // If not in URL, try to get from pagination DOM
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
    
    console.log(`✅ Current page: ${pageInfo.pageNumber || 'unknown'}`);
    return pageInfo;
}

module.exports = { getCurrentPageInfo };
