// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 Website Enricher — website-enricher/enricher.js  v2.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs in a SECOND TERMINAL, parallel to the main scraper.
// Every 3s scans for leads.jsonl rows where Website is empty,
// asks Gemini for the domain, purifies with DeepSeek, writes back.
//
// USAGE (from project root):
//   node website-enricher/enricher.js
//
// Auto-discovers the latest job folder. No --dir flag needed.
// Runs until all rows filled and scraper is done, then exits.
// ═══════════════════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');

const { GeminiScraper }              = require('./geminiScraper');
const { purifyDomains, stripDomain } = require('./deepseekPurifier');

const POLL_INTERVAL_MS = 3000;
const GEMINI_BATCH     = 5;
const GEMINI_DELAY_MS  = 2000;
const GEMINI_CDP_URL   = 'http://127.0.0.1:9224';

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
// Looks inside <projectRoot>/data/ for subfolders containing leads.jsonl,
// returns the one modified most recently.
function findLatestJobDir() {
    const dataRoot = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataRoot)) return null;

    let best = null, bestMtime = 0;
    for (const name of fs.readdirSync(dataRoot)) {
        const dir  = path.join(dataRoot, name);
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
    console.log('🔍 Website Enricher v2.0');
    console.log(`🤖 DeepSeek purification: ${DEEPSEEK_KEY ? 'ENABLED' : 'DISABLED (no API key in .env)'}`);
    console.log(`📸 Debug screenshots: ${DEBUG_DIR ? DEBUG_DIR : 'off'} (add --debug to enable)`);
    console.log('');
    console.log('HOW IT WORKS:');
    console.log('  1. Watches data/ folder every 3s for leads with empty Website column');
    console.log('  2. Asks Gemini (port 9224 Chrome) for each company domain');
    console.log('  3. Purifies results with DeepSeek to drop wrong domains');
    console.log('  4. Writes confirmed domains back to leads.jsonl + regenerates CSV');
    console.log('══════════════════════════════════════════');

    // ── Connect to Gemini Chrome ─────────────────────────────────────────────
    const gemini    = new GeminiScraper(GEMINI_CDP_URL);
    const connected = await gemini.connect();

    if (!connected) {
        console.error('\n❌ Cannot connect to Chrome on port 9224.');
        console.error('Start it first with:\n');
        console.error('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9224 --user-data-dir="C:\\website_enricher"\n');
        process.exit(1);
    }

    // ── Self-test to verify Gemini is working ────────────────────────────────
    console.log('🧪 [Enricher] Self-test: querying Gemini for "Google"...');
    const test = await gemini.selfTest(DEBUG_DIR);
    if (!test.ok) {
        console.error(`❌ Gemini self-test FAILED: ${test.error || 'wrong domain returned'}`);
        console.error('');
        console.error('TROUBLESHOOTING:');
        console.error('  1. Is Chrome running on port 9224? Start it with:');
        console.error('     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9224 --user-data-dir="C:\\website_enricher"');
        console.error('  2. Open http://localhost:9224 in your browser to verify Chrome is accessible');
        console.error('  3. Make sure you are signed into your Google account in the port 9224 window');
        console.error('  4. Navigate to https://gemini.google.com/app in that window manually');
        if (DEBUG_DIR) console.error(`  5. Check screenshots in: ${DEBUG_DIR}`);
        else console.error('  5. Run with --debug flag to capture screenshots for diagnosis');
        process.exit(1);
    }
    console.log(`✅ [Enricher] Self-test passed (got: ${test.domain})`);

    // ── Discover job dir ─────────────────────────────────────────────────────
    let jobDir = null;
    console.log('🔍 [Enricher] Waiting for a job to start (watching data/ folder)...');

    // Poll until a job folder appears
    while (!jobDir) {
        jobDir = findLatestJobDir();
        if (!jobDir) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    const jsonlPath = path.join(jobDir, 'leads.jsonl');
    const doneFile  = path.join(jobDir, 'job.done');
    console.log(`📂 [Enricher] Found job: ${jobDir}`);

    const alreadyQueued = new Set();
    let   totalEnriched = 0;
    let   idleCount     = 0;

    // ── Main poll loop ───────────────────────────────────────────────────────
    while (true) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        // Check for newer job (if scraper started a new URL)
        const newerDir = findLatestJobDir();
        if (newerDir && newerDir !== jobDir) {
            console.log(`📂 [Enricher] Switched to newer job: ${newerDir}`);
            jobDir = newerDir;
        }

        const jobDone = fs.existsSync(path.join(jobDir, 'job.done'));
        const records = readRecords(path.join(jobDir, 'leads.jsonl'));
        const pending = getPending(records, alreadyQueued);

        if (pending.length === 0) {
            idleCount++;
            if (idleCount % 5 === 0) {
                const emptyCount = records.filter(r => !stripDomain(r.salesqlOrgWebsite)).length;
                console.log(`⏳ [Enricher] Watching... ${records.length} leads, ${emptyCount} empty Website, ${totalEnriched} enriched`);
            }
            if (jobDone) {
                console.log(`✅ [Enricher] Job complete. Total enriched: ${totalEnriched}`);
                break;
            }
            continue;
        }

        idleCount = 0;
        const batch = pending.slice(0, GEMINI_BATCH);
        const emptyTotal = records.filter(r => !stripDomain(r.salesqlOrgWebsite)).length;
        console.log(`\n🔍 [Enricher] Processing ${batch.length} companies (${emptyTotal} total empty Website rows)...`);
        console.log('   Companies: ' + batch.map(r => `"${r.companyName}"`).join(', '));

        // Mark as queued immediately
        for (const rec of batch) {
            const key = (rec.personSalesUrl || rec.fullName || '').toLowerCase();
            if (key) alreadyQueued.add(key);
        }

        // ── Step 1: Gemini queries ──────────────────────────────────────────
        const geminiResults = [];
        for (let i = 0; i < batch.length; i++) {
            const rec = batch[i];
            try {
                const domain = await gemini.findWebsite(rec.companyName, DEBUG_DIR);
                geminiResults.push({ companyName: rec.companyName, geminiDomain: domain });
            } catch (err) {
                console.log(`⚠️ [Gemini] "${rec.companyName}": ${err.message}`);
                geminiResults.push({ companyName: rec.companyName, geminiDomain: null });
            }
            if (i < batch.length - 1) {
                await new Promise(r => setTimeout(r, GEMINI_DELAY_MS));
            }
        }

        // ── Step 2: DeepSeek purification ───────────────────────────────────
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

        // ── Step 3: Write back ──────────────────────────────────────────────
        const fresh   = readRecords(path.join(jobDir, 'leads.jsonl'));
        const changed = applyResults(fresh, purified);

        if (changed > 0) {
            writeRecords(path.join(jobDir, 'leads.jsonl'), fresh);
            await regenerateCSV(jobDir);
            totalEnriched += changed;
            console.log(`💾 [Enricher] Wrote ${changed} domains (total: ${totalEnriched})`);
        } else {
            console.log('⚠️ [Enricher] No domains confirmed for this batch');
        }
    }

    await gemini.close();
    console.log('🔍 [Enricher] Done. Exiting.');
}

run().catch(err => {
    console.error(`❌ [Enricher] Fatal: ${err.message}`);
    process.exit(1);
});