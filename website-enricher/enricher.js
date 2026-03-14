// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 Website Enricher — website-enricher/enricher.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs PARALLEL to the main scraper job. Watches leads.jsonl every 3s for
// records with an empty Website column, enriches them via:
//
//   1. Gemini (Chrome port 9224) → finds official domain for company name
//   2. DeepSeek Purifier         → confirms/rejects the domain
//   3. Writes confirmed domain back to Website in leads.jsonl
//   4. Regenerates leads.csv + leads.xlsx
//
// PARALLEL DESIGN:
//   - Main scraper and this enricher run completely independently.
//   - Both write to the same leads.jsonl (enricher patches only the Website field).
//   - Enricher processes records in batches (GEMINI_BATCH) to avoid hammering Gemini.
//   - Already-enriched rows (Website not empty) are skipped every poll cycle.
//   - When the main job finishes (sentinel file appears), enricher drains
//     remaining rows then exits.
//
// LAUNCH:
//   node website-enricher/enricher.js --dir "C:\...\data\jobid" [--watch]
//
//   --dir   path to the job output folder (contains leads.jsonl)
//   --watch keep running even after main scraper finishes (default: auto-stop)
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');

const { GeminiScraper }  = require('./geminiScraper');
const { purifyDomains, stripDomain } = require('./deepseekPurifier');

// ── Config ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3000;   // check for new empty-Website rows every 3s
const GEMINI_BATCH     = 5;      // how many company names to send to Gemini per round
const GEMINI_DELAY_MS  = 1500;   // pause between Gemini queries (rate-limit safety)
const GEMINI_CDP_URL   = 'http://127.0.0.1:9224';

// ── Parse CLI args ─────────────────────────────────────────────────────────────
function parseArgs() {
    const args   = process.argv.slice(2);
    let   jobDir = null;
    let   watch  = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--dir'  && args[i + 1]) { jobDir = args[++i]; }
        if (args[i] === '--watch') { watch = true; }
    }
    return { jobDir, watch };
}

// ── Load .env from project root ────────────────────────────────────────────────
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

// ── Read all JSONL records from file ──────────────────────────────────────────
function readRecords(jsonlPath) {
    if (!fs.existsSync(jsonlPath)) return [];
    return fs.readFileSync(jsonlPath, 'utf-8')
        .trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

// ── Write records back to JSONL ───────────────────────────────────────────────
function writeRecords(jsonlPath, records) {
    fs.writeFileSync(jsonlPath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// ── Regenerate CSV + XLSX using the same generateCSV task ────────────────────
async function regenerateCSV(jobDir) {
    const jsonlPath = path.join(jobDir, 'leads.jsonl');
    const csvPath   = path.join(jobDir, 'leads.csv');
    try {
        const { generateCSV } = require('../tasks/generateCSV');
        await generateCSV(jsonlPath, csvPath);
        console.log('📊 [Enricher] CSV + XLSX regenerated');
    } catch (err) {
        console.log(`⚠️ [Enricher] CSV regen error: ${err.message}`);
    }
}

// ── Get records with empty Website that haven't been processed yet ────────────
function getPendingRecords(records, alreadyQueued) {
    return records.filter(r => {
        const website = stripDomain(r.salesqlOrgWebsite);
        if (website) return false;                              // already has a website
        if (!r.companyName || r.companyName.trim() === '') return false; // no company name
        const key = (r.personSalesUrl || r.fullName || '').toLowerCase();
        if (!key || alreadyQueued.has(key)) return false;      // already in flight
        return true;
    });
}

// ── Apply enrichment results back to JSONL ─────────────────────────────────────
function applyResults(records, results) {
    const resultMap = new Map();
    for (const r of results) {
        if (r.domain) resultMap.set(r.companyName?.toLowerCase().trim(), r.domain);
    }

    let changed = 0;
    for (const rec of records) {
        const key = rec.companyName?.toLowerCase().trim();
        if (key && resultMap.has(key)) {
            const domain = resultMap.get(key);
            const existing = stripDomain(rec.salesqlOrgWebsite);
            if (!existing) {
                rec.salesqlOrgWebsite = domain;
                changed++;
            }
        }
    }
    return changed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN enricher loop
// ═══════════════════════════════════════════════════════════════════════════════
async function run() {
    loadEnv();
    const { jobDir, watch } = parseArgs();
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

    if (!jobDir) {
        console.error('Usage: node website-enricher/enricher.js --dir <jobDir>');
        process.exit(1);
    }

    const jsonlPath = path.join(jobDir, 'leads.jsonl');
    const doneFile  = path.join(jobDir, 'job.done'); // sentinel written by job-runner at end

    console.log('══════════════════════════════════════');
    console.log('🔍 Website Enricher starting');
    console.log(`📂 Job dir: ${jobDir}`);
    console.log(`🤖 DeepSeek: ${DEEPSEEK_KEY ? 'enabled' : 'disabled — domains not purified'}`);
    console.log('══════════════════════════════════════');

    // Connect to Gemini Chrome instance
    const gemini = new GeminiScraper(GEMINI_CDP_URL);
    const connected = await gemini.connect();
    if (!connected) {
        console.error('❌ [Enricher] Cannot connect to Gemini Chrome. Start Chrome with:');
        console.error('   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9224 --user-data-dir="C:\\website_enricher"');
        process.exit(1);
    }

    const alreadyQueued = new Set(); // keys of records we've already submitted
    let   totalEnriched = 0;
    let   idleRounds    = 0;

    // ── Poll loop ─────────────────────────────────────────────────────────────
    while (true) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        // Check if main job finished
        const jobDone = fs.existsSync(doneFile);

        if (!fs.existsSync(jsonlPath)) {
            if (jobDone && !watch) break;
            continue;
        }

        const records = readRecords(jsonlPath);
        const pending = getPendingRecords(records, alreadyQueued);

        if (pending.length === 0) {
            if (jobDone && !watch) {
                console.log(`✅ [Enricher] All done. Total enriched: ${totalEnriched}`);
                break;
            }
            idleRounds++;
            if (idleRounds % 10 === 0) {
                console.log(`🔍 [Enricher] Watching... (${totalEnriched} enriched so far)`);
            }
            continue;
        }

        idleRounds = 0;
        // Take a batch
        const batch = pending.slice(0, GEMINI_BATCH);
        console.log(`🔍 [Enricher] Processing ${batch.length} companies (${totalEnriched} enriched so far)`);

        // Mark as queued immediately to avoid double-processing
        for (const rec of batch) {
            const key = (rec.personSalesUrl || rec.fullName || '').toLowerCase();
            if (key) alreadyQueued.add(key);
        }

        // ── Step 1: Gemini queries ─────────────────────────────────────────
        const geminiResults = [];
        for (const rec of batch) {
            try {
                console.log(`🌐 [Gemini] Searching: "${rec.companyName}"`);
                const domain = await gemini.findWebsite(rec.companyName);
                console.log(`   → ${domain || 'not found'}`);
                geminiResults.push({ companyName: rec.companyName, geminiDomain: domain });
            } catch (err) {
                console.log(`⚠️ [Gemini] Error for "${rec.companyName}": ${err.message}`);
                geminiResults.push({ companyName: rec.companyName, geminiDomain: null });
            }
            if (batch.indexOf(rec) < batch.length - 1) {
                await new Promise(r => setTimeout(r, GEMINI_DELAY_MS));
            }
        }

        // ── Step 2: DeepSeek purification ─────────────────────────────────
        const withDomains = geminiResults.filter(r => r.geminiDomain);
        let purified = geminiResults.map(r => ({ companyName: r.companyName, domain: r.geminiDomain }));

        if (DEEPSEEK_KEY && withDomains.length > 0) {
            console.log(`🤖 [Purifier] Sending ${withDomains.length} domains to DeepSeek...`);
            const purifiedMap = await purifyDomains(withDomains, DEEPSEEK_KEY);
            // Merge purified back (unconfirmed domains become null)
            const pMap = new Map(purifiedMap.map(r => [r.companyName?.toLowerCase(), r.domain]));
            purified = geminiResults.map(r => ({
                companyName: r.companyName,
                domain: pMap.get(r.companyName?.toLowerCase()) || null,
            }));
        }

        // ── Step 3: Apply to JSONL ─────────────────────────────────────────
        const freshRecords = readRecords(jsonlPath); // re-read in case main scraper wrote new rows
        const changed      = applyResults(freshRecords, purified);

        if (changed > 0) {
            writeRecords(jsonlPath, freshRecords);
            await regenerateCSV(jobDir);
            totalEnriched += changed;
            console.log(`💾 [Enricher] Wrote ${changed} new domains (total: ${totalEnriched})`);
        }
    }

    await gemini.close();
    console.log('🔍 [Enricher] Exiting.');
}

run().catch(err => {
    console.error(`❌ [Enricher] Fatal: ${err.message}`);
    process.exit(1);
});