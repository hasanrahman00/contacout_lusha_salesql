// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 Website Enricher — website-enricher/enricher.js  v3.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs parallel to the main scraper (spawned from dashboard or standalone).
// Watches leads.jsonl and accumulates companies that need a Website domain.
// Once GEMINI_BATCH (200) pending companies are ready → fires one Gemini
// batch query, purifies with DeepSeek, writes back, then sleeps and waits
// for the next batch to fill up.
//
// When the scraper finishes (job.done), processes whatever is left (<200)
// as a final batch, then exits.
//
// The enricher NEVER exits on its own while the scraper is still active —
// it keeps polling and watching the file until paused manually or job ends.
//
// USAGE:
//   node website-enricher/enricher.js          (standalone, auto-discovers job)
//   Spawned by jobs/manager.js with JOB_DIR env
// ═══════════════════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');

const { GeminiScraper }              = require('./geminiScraper');
const { purifyDomains, stripDomain } = require('./deepseekPurifier');

const POLL_INTERVAL_MS   = 3000;       // how often to check for new leads
const GEMINI_BATCH       = 200;        // companies per Gemini batch query
const GEMINI_CDP_URL     = 'http://127.0.0.1:9224';
const BATCH_COOLDOWN_MS  = 5000;       // sleep between batches to avoid Gemini rate-limit
const IDLE_LOG_EVERY     = 10;         // log "watching..." every N idle polls

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadEnv() {
    const envFile = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envFile)) return;
    for (const raw of fs.readFileSync(envFile, 'utf-8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) process.env[key] = val;
    }
}

// ── Auto-discover the latest active job folder ─────────────────────────────────
function findLatestJobDir() {
    const dataRoot = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataRoot)) return null;

    let best = null, bestMtime = 0;
    for (const name of fs.readdirSync(dataRoot)) {
        const dir   = path.join(dataRoot, name);
        const jsonl = path.join(dir, 'leads.jsonl');
        try {
            const stat = fs.statSync(jsonl);
            if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; best = dir; }
        } catch {}
    }
    return best;
}

function readRecords(jsonlPath) {
    if (!fs.existsSync(jsonlPath)) return [];
    return fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

function writeRecords(jsonlPath, records) {
    fs.writeFileSync(jsonlPath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

async function regenerateCSV(jobDir) {
    const jsonl = path.join(jobDir, 'leads.jsonl');
    const csv   = path.join(jobDir, 'leads.csv');
    try {
        const { generateCSV } = require('../tasks/generateCSV');
        await generateCSV(jsonl, csv);
        console.log('📊 [Enricher] CSV regenerated');
    } catch (err) {
        console.log(`⚠️ [Enricher] CSV error: ${err.message}`);
    }
}

function getPending(records, alreadyQueued) {
    return records.filter(r => {
        if (stripDomain(r.salesqlOrgWebsite)) return false;  // already has website
        if (!r.companyName?.trim()) return false;             // no company name
        const key = (r.personSalesUrl || r.fullName || '').toLowerCase();
        return key && !alreadyQueued.has(key);
    });
}

function applyResults(records, results) {
    const map = new Map();
    for (const r of results) {
        if (r.domain) map.set(r.companyName?.toLowerCase().trim(), r.domain);
    }
    let changed = 0;
    for (const rec of records) {
        const key = rec.companyName?.toLowerCase().trim();
        if (key && map.has(key) && !stripDomain(rec.salesqlOrgWebsite)) {
            rec.salesqlOrgWebsite = map.get(key);
            changed++;
        }
    }
    return changed;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-LAUNCH CHROME ON PORT 9224
// ═══════════════════════════════════════════════════════════════════════════════
async function ensureGeminiChrome(chromePath) {
    const PORT = 9224;
    const UDD  = 'C:\\website_enricher';
    const http = require('http');

    function checkRunning() {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${PORT}/json/version`, { timeout: 2000 }, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try { const p = JSON.parse(d); resolve(!!p.Browser); }
                    catch { resolve(false); }
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    if (await checkRunning()) {
        console.log(`✅ [Enricher] Chrome already running on port ${PORT}`);
        return;
    }

    const exe = chromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    console.log(`🚀 [Enricher] Launching Chrome on port ${PORT}...`);
    console.log(`   Path: ${exe}`);
    console.log(`   Profile: ${UDD}`);

    const { spawn } = require('child_process');
    const child = spawn(exe, [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${UDD}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        if (await checkRunning()) {
            console.log(`✅ [Enricher] Chrome launched on port ${PORT}`);
            return;
        }
    }
    throw new Error(`Chrome did not start on port ${PORT} within 15s — check the path in Settings`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS ONE BATCH  (Gemini → Purify → Write back)
// ═══════════════════════════════════════════════════════════════════════════════
async function processBatch(batch, gemini, DEEPSEEK_KEY, jobDir, alreadyQueued, DEBUG_DIR) {
    const jsonlPath = path.join(jobDir, 'leads.jsonl');

    // Mark as queued immediately so next poll won't re-pick them
    for (const rec of batch) {
        const key = (rec.personSalesUrl || rec.fullName || '').toLowerCase();
        if (key) alreadyQueued.add(key);
    }

    // ── Step 1: Gemini batch query ──────────────────────────────────────────
    let geminiResults = [];
    try {
        geminiResults = await gemini.findWebsitesBatch(
            batch.map(r => r.companyName),
            DEBUG_DIR
        );
    } catch (err) {
        console.log(`⚠️ [Gemini] Batch error: ${err.message}`);
        geminiResults = batch.map(r => ({ companyName: r.companyName, geminiDomain: null }));
    }

    // ── Step 2: DeepSeek purification ───────────────────────────────────────
    const withDomains = geminiResults.filter(r => r.geminiDomain);
    let   purified    = geminiResults.map(r => ({ companyName: r.companyName, domain: r.geminiDomain }));

    if (DEEPSEEK_KEY && withDomains.length > 0) {
        console.log(`🤖 [Purifier] Verifying ${withDomains.length} domains with DeepSeek...`);
        const confirmed = await purifyDomains(withDomains, DEEPSEEK_KEY);
        const pMap = new Map(confirmed.map(r => [r.companyName?.toLowerCase(), r.domain]));
        purified = geminiResults.map(r => ({
            companyName: r.companyName,
            domain: pMap.get(r.companyName?.toLowerCase()) || null,
        }));
    }

    // ── Step 3: Write back ──────────────────────────────────────────────────
    const fresh   = readRecords(jsonlPath);
    const changed = applyResults(fresh, purified);

    if (changed > 0) {
        writeRecords(jsonlPath, fresh);
        await regenerateCSV(jobDir);
        console.log(`💾 [Enricher] Wrote ${changed} domains`);
    } else {
        console.log('⚠️ [Enricher] No domains confirmed for this batch');
    }

    return changed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
    loadEnv();
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
    const DEBUG_DIR    = process.argv.includes('--debug')
        ? path.join(__dirname, 'debug-screenshots')
        : null;

    if (DEBUG_DIR) fs.mkdirSync(DEBUG_DIR, { recursive: true });

    console.log('══════════════════════════════════════════');
    console.log('🔍 Website Enricher v3.0 (Batch-Watch Mode)');
    console.log(`🤖 DeepSeek purification: ${DEEPSEEK_KEY ? 'ENABLED' : 'DISABLED (no API key in .env)'}`);
    console.log(`📦 Batch size: ${GEMINI_BATCH} companies`);
    console.log(`⏱️  Batch cooldown: ${BATCH_COOLDOWN_MS / 1000}s`);
    console.log(`📸 Debug screenshots: ${DEBUG_DIR ? DEBUG_DIR : 'off'} (add --debug to enable)`);
    console.log('');
    console.log('HOW IT WORKS:');
    console.log('  1. Watches leads.jsonl — waits for batch of 200 to accumulate');
    console.log('  2. Fires ONE Gemini query per batch, purifies with DeepSeek');
    console.log('  3. Writes domains back, sleeps, then watches for next batch');
    console.log('  4. When scraper finishes: processes remaining leads, then exits');
    console.log('  5. Stays active until manually paused or job completes');
    console.log('══════════════════════════════════════════');

    // ── Connect to Gemini Chrome ─────────────────────────────────────────────
    let chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    try {
        const settingsFile = path.join(__dirname, '..', 'data', 'settings.json');
        if (fs.existsSync(settingsFile)) {
            const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
            if (s.CHROME_PATH) chromePath = s.CHROME_PATH;
        }
    } catch {}

    try {
        await ensureGeminiChrome(chromePath);
    } catch (err) {
        console.error(`❌ [Enricher] Could not start Chrome: ${err.message}`);
        process.exit(1);
    }

    const gemini    = new GeminiScraper(GEMINI_CDP_URL);
    const connected = await gemini.connect();

    if (!connected) {
        console.error('\n❌ Cannot connect to Chrome on port 9224.');
        console.error('Start it first with:\n');
        console.error('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9224 --user-data-dir="C:\\website_enricher"\n');
        process.exit(1);
    }

    // ── Open fresh Gemini chat ──────────────────────────────────────────────
    await gemini.newChat();
    console.log('✅ [Enricher] Gemini chat ready');

    // ── Discover job dir ────────────────────────────────────────────────────
    // Use JOB_DIR env (when spawned by manager) or auto-discover
    let jobDir = process.env.JOB_DIR || null;

    if (jobDir && fs.existsSync(jobDir)) {
        console.log(`📂 [Enricher] Using JOB_DIR: ${jobDir}`);
    } else {
        jobDir = null;
        console.log('🔍 [Enricher] Waiting for a job to start (watching data/ folder)...');
        while (!jobDir) {
            jobDir = findLatestJobDir();
            if (!jobDir) await sleep(POLL_INTERVAL_MS);
        }
        console.log(`📂 [Enricher] Found job: ${jobDir}`);
    }

    const alreadyQueued = new Set();
    let   totalEnriched = 0;
    let   idleCount     = 0;

    // ═════════════════════════════════════════════════════════════════════════
    // MAIN WATCH LOOP — stays alive until job done + all remaining processed
    // ═════════════════════════════════════════════════════════════════════════
    while (true) {
        await sleep(POLL_INTERVAL_MS);

        // ── Check for newer job (if scraper started a new URL) ──────────
        const newerDir = findLatestJobDir();
        if (newerDir && newerDir !== jobDir) {
            console.log(`📂 [Enricher] Switched to newer job: ${newerDir}`);
            jobDir = newerDir;
            await gemini.newChat();
        }

        const jsonlPath = path.join(jobDir, 'leads.jsonl');
        const jobDone   = fs.existsSync(path.join(jobDir, 'job.done'));
        const records   = readRecords(jsonlPath);
        const pending   = getPending(records, alreadyQueued);

        // ────────────────────────────────────────────────────────────────
        // CASE 1: Batch ready (>= GEMINI_BATCH pending)
        //         Process exactly one batch, then loop back to watch.
        // ────────────────────────────────────────────────────────────────
        if (pending.length >= GEMINI_BATCH) {
            idleCount = 0;
            const batch = pending.slice(0, GEMINI_BATCH);
            const emptyTotal = records.filter(r => !stripDomain(r.salesqlOrgWebsite)).length;

            console.log(`\n🔍 [Enricher] Batch ready! Processing ${batch.length} companies (${emptyTotal} total empty)...`);
            console.log('   First 5: ' + batch.slice(0, 5).map(r => `"${r.companyName}"`).join(', '));

            const changed = await processBatch(batch, gemini, DEEPSEEK_KEY, jobDir, alreadyQueued, DEBUG_DIR);
            totalEnriched += changed;
            console.log(`📈 [Enricher] Running total enriched: ${totalEnriched}`);

            // ── Cooldown between batches (avoid Gemini rate-limit) ───────
            console.log(`😴 [Enricher] Batch done. Cooling down ${BATCH_COOLDOWN_MS / 1000}s before watching again...`);
            await sleep(BATCH_COOLDOWN_MS);
            continue;
        }

        // ────────────────────────────────────────────────────────────────
        // CASE 2: Job is done (scraper finished) — process whatever is left
        // ────────────────────────────────────────────────────────────────
        if (jobDone) {
            if (pending.length > 0) {
                // Final batch: process all remaining even if < GEMINI_BATCH
                console.log(`\n🏁 [Enricher] Scraper done! Processing final ${pending.length} remaining companies...`);
                console.log('   First 5: ' + pending.slice(0, 5).map(r => `"${r.companyName}"`).join(', '));

                const changed = await processBatch(pending, gemini, DEEPSEEK_KEY, jobDir, alreadyQueued, DEBUG_DIR);
                totalEnriched += changed;
                console.log(`📈 [Enricher] Final total enriched: ${totalEnriched}`);
            }

            // All done — exit
            console.log(`\n✅ [Enricher] Job complete. Total enriched: ${totalEnriched}`);
            break;
        }

        // ────────────────────────────────────────────────────────────────
        // CASE 3: Not enough pending yet, scraper still active — keep watching
        // ────────────────────────────────────────────────────────────────
        idleCount++;
        if (idleCount % IDLE_LOG_EVERY === 0) {
            const emptyCount = records.filter(r => !stripDomain(r.salesqlOrgWebsite)).length;
            console.log(`⏳ [Enricher] Watching... ${records.length} leads, ${pending.length}/${GEMINI_BATCH} pending for next batch, ${emptyCount} empty Website, ${totalEnriched} enriched so far`);
        }
    }

    await gemini.close();
    console.log('🔍 [Enricher] Done. Exiting.');
}

run().catch(err => {
    console.error(`❌ [Enricher] Fatal: ${err.message}`);
    process.exit(1);
});