// ═══════════════════════════════════════════════════════════════════════════════
// 🎬 JOB RUNNER — VikiLeads v3.4.0 (FAST MODE)
// ═══════════════════════════════════════════════════════════════════════════════
//
// FLOW (per page) — target 15–20s:
//   1. PARALLEL: Scroll + ContactOut + Lusha (all fire at once)
//   2. Wait for scroll to reach bottom
//   3. Activate SalesQL (after scroll — needs all leads visible)
//   4. Fast unified poll for all 3 responses (300ms intervals, 5s cap)
//   5. Retry stragglers with short timeouts
//   6. Minimize sidebars (ContactOut + Lusha)
//   7. Merge: Sales Nav (BASE) + ContactOut + Lusha + SalesQL (ENRICH)
//   8. Save JSONL + generate CSV/XLSX
//   9. Navigate to next page
//
//         Data sources: Sales Nav (base) + Lusha + ContactOut + SalesQL (email + phone)
// ═══════════════════════════════════════════════════════════════════════════════

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

const config = require('./config');
const fs     = require('fs');
const path   = require('path');

const JOB_URL        = process.env.JOB_URL;
const JOB_DIR        = process.env.JOB_DIR;
const JOB_URL_NUMBER = process.env.JOB_URL_NUMBER || '';
const MAX_PAGES      = parseInt(process.env.JOB_MAX_PAGES  || '100', 10);
const START_PAGE     = parseInt(process.env.JOB_START_PAGE || '0',   10);

if (!JOB_URL || !JOB_DIR) { console.error('Missing JOB_URL or JOB_DIR'); process.exit(1); }
if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR, { recursive: true });

const LEADS_JSONL = path.join(JOB_DIR, 'leads.jsonl');
const LEADS_CSV   = path.join(JOB_DIR, 'leads.csv');

const { launchChrome }                            = require('./tasks/launchChrome');
const { connectToBrowser }                        = require('./tasks/connectBrowser');
const { navigateToLinkedIn }                      = require('./tasks/navigateToLinkedIn');
const { scrollDashboardPage }                     = require('./tasks/scrollDashboard');
const { getCurrentPageInfo }                      = require('./tasks/getPageInfo');
const { goToNextPage }                            = require('./tasks/navigateNextPage');
const { activateLusha, minimizeLusha }            = require('./tasks/activateLusha');
const { activateContactOut, minimizeContactOut }  = require('./tasks/activateContactOut');
const { activateSalesQL, minimizeSalesQL }          = require('./tasks/activateSalesQL');
const { extractSalesQLData, isSalesQLOpen }         = require('./tasks/extractSalesQL');
const { setupNetworkCapture }                     = require('./tasks/setupNetworkCapture');
const { mergePageData }                           = require('./tasks/mergeData');
const { generateCSV }                             = require('./tasks/generateCSV');
const { enrichPageAsync, waitForAllEnrichments }  = require('./tasks/deepseekEnrich');
const { PageTracker }                             = require('./tasks/pageTracker');


(async () => {
    let stopRequested = false;
    process.on('message', (msg) => {
        if (msg && msg.action === 'stop') {
            console.log('⏸ Stop requested — finishing current page...');
            stopRequested = true;
        }
    });

    const tracker = new PageTracker(JOB_DIR);

    try {
        console.log('══════════════════════════════════════════');
        console.log('🚀 JOB STARTING — VikiLeads v3.3.0');
        console.log(`📎 URL: ${JOB_URL.slice(0, 80)}...`);
        if (JOB_URL_NUMBER) console.log(`🔢 URL Number: ${JOB_URL_NUMBER}`);
        console.log(`📂 Output: ${JOB_DIR}`);
        if (START_PAGE > 0) console.log(`♻️ Resuming from page ${START_PAGE}`);
        console.log('══════════════════════════════════════════');

        await launchChrome(config.CHROME_PATH, config.PORT, config.USER_DATA_DIR);
        const { browser, context } = await connectToBrowser(config.CDP_URL);

        if (!fs.existsSync(LEADS_JSONL)) fs.writeFileSync(LEADS_JSONL, '', { flag: 'wx' });

        const captureStore = await setupNetworkCapture(context, browser);

        // ── DeepSeek API key (from settings.json → DEEPSEEK_API_KEY) ─────────
        const DEEPSEEK_KEY = config.DEEPSEEK_API_KEY || '';
        if (DEEPSEEK_KEY) {
            console.log('🤖 [DeepSeek] Domain enrichment enabled');
        } else {
            console.log('⚠️ [DeepSeek] No API key in settings — domain enrichment disabled');
        }

        let navUrl = JOB_URL;
        if (START_PAGE > 1) {
            try { const u = new URL(navUrl); u.searchParams.set('page', String(START_PAGE)); navUrl = u.toString(); }
            catch { navUrl += (navUrl.includes('?') ? '&' : '?') + `page=${START_PAGE}`; }
        }
        const page = await navigateToLinkedIn(context, navUrl);

        console.log('⏳ Waiting for Sales Nav content...');
        try {
            await page.waitForSelector("a[data-control-name^='view_lead_panel']", { state: 'visible', timeout: 30000 });
            console.log('✅ Sales Nav content visible');
        } catch { console.log('⚠️ Sales Nav content not found — continuing'); }

        const startInfo = await getCurrentPageInfo(page);
        let currentPage = startInfo.pageNumber || START_PAGE || 1;
        let hasNextPage = true;

        // Initialize page bucket and clear enrichment before the loop.
        captureStore.setPage(currentPage);
        captureStore.clearCurrent();

        // Sales Nav may have fired during initial page load when store.currentPage
        // was still 1 (the default). If we're starting on a page other than 1
        // (e.g. URL has ?page=3), retag the captured data to the actual page.
        if (captureStore._latestSalesNavRecords.length > 0 &&
            captureStore._salesNavForPage !== currentPage) {
            captureStore._salesNavForPage = currentPage;
            console.log(`♻️ Retagged Sales Nav data → page ${currentPage}`);
        }

        while (hasNextPage && currentPage <= MAX_PAGES && !stopRequested) {
            const pageStart = Date.now();
            const pageNum   = currentPage;
            console.log(`\n📄 ═══ Page ${pageNum} ═══`);

            tracker.pageStarted(pageNum);
            // setPage + clearCurrent moved to end of previous iteration (before navigation)

            // ══════════════════════════════════════════════════════════
            // WAIT FOR SALES NAV — fires on page load, must arrive before
            // we activate extensions. Poll up to 10s (20 × 500ms).
            // Uses isSalesNavFresh() which checks _salesNavForPage === currentPage.
            // No explicit clear needed — page number mismatch blocks stale data.
            // ══════════════════════════════════════════════════════════
            console.log('⏳ Waiting for Sales Nav data...');
            let snReady = captureStore.isSalesNavFresh();
            if (!snReady) {
                for (let w = 0; w < 12; w++) {
                    await page.waitForTimeout(400);
                    if (captureStore.isSalesNavFresh()) { snReady = true; break; }
                }
            }
            if (snReady) console.log('✅ Sales Nav data ready (' + captureStore.getSalesNavRecords().length + ' records)');
            else         console.log('⚠️ Sales Nav not received after 5s — will skip page');

            // ══════════════════════════════════════════════════════════
            // SCROLL + ContactOut + Lusha — ALL IN PARALLEL
            // ContactOut & Lusha fire their APIs on activation.
            // Scroll runs in background. All three launch at once.
            // ══════════════════════════════════════════════════════════
            console.log('⚡ [Step 1] Parallel: Scroll + ContactOut + Lusha...');
            const scrollPromise     = scrollDashboardPage(page, config.SCROLL_OPTIONS);
            const contactOutPromise = activateContactOut(page);
            const lushaPromise      = activateLusha(page);

            // Wait for both extensions to finish activation (click + sidebar detect)
            await Promise.all([contactOutPromise, lushaPromise]);
            console.log('✅ ContactOut + Lusha activation done');

            // ══════════════════════════════════════════════════════════
            // Wait for scroll to finish (leads must all be visible)
            // ══════════════════════════════════════════════════════════
            await scrollPromise;

            // ══════════════════════════════════════════════════════════
            // STEP 2: Activate SalesQL — AFTER scroll so all 25 leads
            //         are visible and SalesQL can batch-enrich them.
            //         (same logic as before)
            // ══════════════════════════════════════════════════════════
            console.log('⚡ [Step 2] SalesQL activation (post-scroll)...');
            await activateSalesQL(page);

            // ══════════════════════════════════════════════════════════
            // STEP 3: Fast parallel response capture
            // Poll ALL three sources simultaneously with tight timeouts
            // ══════════════════════════════════════════════════════════
            console.log('⚡ [Step 3] Fast response capture...');

            const POLL_INTERVAL = 300;   // ms between polls
            const MAX_POLL_MS   = 5000;  // hard cap for initial poll round

            let luReady  = captureStore.getCurrent().lusha.length > 0;
            let coReady  = captureStore.getCurrent().contactout.length > 0;
            let sqlReady = captureStore.getCurrent().salesql.length > 0;

            // ── Unified fast poll — check all three every 300ms up to 5s ──
            if (!luReady || !coReady || !sqlReady) {
                const pollStart = Date.now();
                while (Date.now() - pollStart < MAX_POLL_MS) {
                    await page.waitForTimeout(POLL_INTERVAL);
                    if (!luReady  && captureStore.getCurrent().lusha.length > 0)      luReady  = true;
                    if (!coReady  && captureStore.getCurrent().contactout.length > 0)  coReady  = true;
                    if (!sqlReady && captureStore.getCurrent().salesql.length > 0)     sqlReady = true;
                    if (luReady && coReady && sqlReady) break;
                }
            }

            if (luReady)  console.log('✅ Lusha data captured');
            if (coReady)  console.log('✅ ContactOut data captured');
            if (sqlReady) console.log(`✅ SalesQL: ${captureStore.getCurrent().salesql.length} records from network`);

            // ── Retry stragglers with short extension wait (3s cap each) ──
            if (!luReady) {
                console.log('⚠️ Lusha not received — extra 3s wait...');
                for (let w = 0; w < 10; w++) {
                    await page.waitForTimeout(POLL_INTERVAL);
                    if (captureStore.getCurrent().lusha.length > 0) { luReady = true; break; }
                }
                if (luReady) console.log('✅ Lusha arrived on retry');
                else { console.log('⚠️ Lusha missing'); tracker.note(pageNum, 'Lusha missing'); }
            }

            if (!coReady) {
                console.log('⚠️ ContactOut not received — retry activation...');
                await minimizeContactOut(page);
                await page.waitForTimeout(300);
                await activateContactOut(page);
                for (let w = 0; w < 10; w++) {
                    await page.waitForTimeout(POLL_INTERVAL);
                    if (captureStore.getCurrent().contactout.length > 0) { coReady = true; break; }
                }
                if (coReady) console.log('✅ ContactOut arrived on retry');
                else { console.log('⚠️ ContactOut missing after retry'); tracker.note(pageNum, 'ContactOut missing'); }
            }

            // ── SalesQL — network primary, DOM extraction fallback ──────
            if (!sqlReady) {
                // Quick poll 1.5s more
                for (let w = 0; w < 5; w++) {
                    await page.waitForTimeout(POLL_INTERVAL);
                    if (captureStore.getCurrent().salesql.length > 0) { sqlReady = true; break; }
                }
                if (sqlReady) {
                    console.log(`✅ SalesQL: ${captureStore.getCurrent().salesql.length} records (delayed)`);
                } else {
                    // Fallback: DOM extraction
                    console.log('⚠️ SalesQL network empty — DOM extraction...');
                    const sqlRecords = await extractSalesQLData(page);
                    if (sqlRecords.length > 0) {
                        captureStore.getCurrent().salesql = sqlRecords;
                        sqlReady = true;
                        console.log(`✅ SalesQL: ${sqlRecords.length} records from DOM`);
                    } else {
                        await page.waitForTimeout(2000);
                        const sqlRetry = await extractSalesQLData(page);
                        if (sqlRetry.length > 0) {
                            captureStore.getCurrent().salesql = sqlRetry;
                            sqlReady = true;
                            console.log(`✅ SalesQL: ${sqlRetry.length} records from DOM on retry`);
                        } else {
                            console.log('⚠️ SalesQL: no data');
                            tracker.note(pageNum, 'SalesQL empty');
                        }
                    }
                }
            }

            // ══════════════════════════════════════════════════════════
            // STEP 4: Minimize ContactOut (Lusha + SalesQL minimized before navigation)
            // ══════════════════════════════════════════════════════════
            console.log('⚡ [Step 4] Minimizing ContactOut...');
            await minimizeContactOut(page);

            // ── Page tracker ───────────────────────────────────────────
            tracker.pageExtracted(pageNum, {
                sn:         captureStore.getSalesNavRecords().length,
                contactout: captureStore.getCurrent().contactout.length,
                lusha:      captureStore.getCurrent().lusha.length,
                salesql:    captureStore.getCurrent().salesql.length,  // DOM-extracted
            });

            // ══════════════════════════════════════════════════════════
            // STEP 5: Merge + Save
            // ══════════════════════════════════════════════════════════
            const salesNavRecs  = captureStore.getSalesNavRecords();
            const salesNavLocs  = captureStore.getSalesNavLocations();

            const pageData = {
                lusha:             captureStore.getCurrent().lusha,
                contactout:        captureStore.getCurrent().contactout,
                salesql:           captureStore.getCurrent().salesql,
                salesNavRecords:   salesNavRecs,
                salesNavLocations: salesNavLocs,
            };

            const merged = mergePageData(pageData);
            tracker.pageMerged(pageNum, merged.length);

            for (const rec of merged) {
                rec.url_number = JOB_URL_NUMBER || '';
                rec.pageNumber = pageNum;
            }

            if (merged.length > 0) {
                const lines = merged.map(r => JSON.stringify(r)).join('\n') + '\n';
                fs.appendFileSync(LEADS_JSONL, lines);
                console.log(`💾 Appended ${merged.length} leads`);
            } else if (!snReady) {
                tracker.pageSkipped(pageNum, 'no Sales Nav data — page will be missed');
            }

            const totalLeads = await generateCSV(LEADS_JSONL, LEADS_CSV);

            // ── DeepSeek domain enrichment — fire and forget (runs in background) ──
            // Does NOT block the scraper. Validates Website/Website_one/Website_two
            // against Company Name and rewrites the best match into the Website column.
            enrichPageAsync(merged, {
                apiKey:       DEEPSEEK_KEY,
                leadsJsonl:   LEADS_JSONL,
                leadsCSV:     LEADS_CSV,
                generateCSVFn: generateCSV,
                pageNum,
            });

            const elapsed = ((Date.now() - pageStart) / 1000).toFixed(1);
            console.log(`✅ Page ${pageNum} done — ${totalLeads} total — ${elapsed}s`);

            tracker.pageSaved(pageNum, totalLeads);

            if (stopRequested) break;

            // ══════════════════════════════════════════════════════════
            // STEP 6: Minimize Lusha + SalesQL before navigation
            // ══════════════════════════════════════════════════════════
            console.log('⚡ [Step 6] Minimizing Lusha + SalesQL...');
            await minimizeSalesQL(page);
            await minimizeLusha(page);

            // Short pause before navigating (1–1.5s)
            const navDelay = 1000 + Math.floor(Math.random() * 500);
            console.log(`⏱ Waiting ${(navDelay/1000).toFixed(1)}s before navigation...`);
            await page.waitForTimeout(navDelay);

            const safeToNavigate = tracker.pageNavigating(pageNum);
            if (!safeToNavigate) {
                console.log(`⚠️ Continuing navigation despite tracker warning`);
            }

            // Clear enrichment buckets BEFORE navigation so Sales Nav data
            // arriving during navigation is correctly seen as fresh for the next page.
            captureStore.setPage(currentPage + 1);  // estimate; corrected below
            captureStore.clearCurrent();

            console.log('➡️ Moving to next page...');
            const nextResult = await goToNextPage(page, currentPage);

            if (!nextResult.success) {
                hasNextPage = false;
                break;
            }

            tracker.pageNavigated(pageNum, nextResult.pageNumber);
            currentPage = nextResult.pageNumber;
            captureStore.currentPage = currentPage;  // correct the estimate above

            try {
                await page.waitForSelector("a[data-control-name^='view_lead_panel']", { state: 'visible', timeout: 10000 });
            } catch { console.log('⚠️ New page content slow'); }
        }

        // Wait for all background DeepSeek enrichments to finish before final CSV
        await waitForAllEnrichments();
        await generateCSV(LEADS_JSONL, LEADS_CSV);

        if (stopRequested) {
            console.log(`\n⏸ Stopped at page ${currentPage}. GRACEFUL STOP.`);
        } else {
            console.log(`\n🏁 Completed!`);
        }

        try {
            const csvLines = fs.readFileSync(LEADS_CSV, 'utf-8').split('\n').filter(l => l.trim());
            console.log(`📊 Final: ${Math.max(0, csvLines.length - 1)} leads in CSV`);
        } catch {}

        tracker.summary();

        // Write sentinel file so website-enricher knows the job is complete
        try { fs.writeFileSync(path.join(JOB_DIR, 'job.done'), new Date().toISOString()); } catch {}

        process.exit(0);

    } catch (error) {
        console.error(`\n❌ ERROR: ${error.message}`);
        tracker.summary();
        process.exit(1);
    }
})();