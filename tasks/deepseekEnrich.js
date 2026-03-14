// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 TASK: DeepSeek Company Domain Enricher — v1.0.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   After each page is scraped and merged, send each lead's company + domains
//   to DeepSeek to validate which domain actually belongs to the company.
//   Result is written back into the JSONL and regenerated into CSV/XLSX.
//
// PARALLEL DESIGN:
//   - Job runner calls enrichPageAsync(records, ...) and does NOT await it.
//   - Each page's enrichment runs concurrently with the scraper's next page.
//   - Records are processed in parallel batches (BATCH_SIZE per API call).
//   - Results are written to a separate enriched JSONL, then CSV/XLSX is
//     regenerated once all pending work drains (or at job end).
//
// DEEPSEEK PROMPT per batch:
//   Given company name and up to 3 candidate domains, pick the one that
//   belongs to the company. If none match, return null.
//
// API: https://api.deepseek.com/v1/chat/completions
//   Model: deepseek-chat
//   API key: from settings.json → DEEPSEEK_API_KEY
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs      = require('fs');
const https   = require('https');
const path    = require('path');

// Batch size: how many leads to send in one DeepSeek call (cost vs latency tradeoff)
const BATCH_SIZE    = 10;
const MODEL         = 'deepseek-chat';
const API_URL       = 'https://api.deepseek.com/v1/chat/completions';
const MAX_RETRIES   = 2;
const RETRY_DELAY   = 2000;

// ── Active pending enrichment promises (fire-and-forget tracker) ─────────────
const _pendingEnrichments = [];

// ── Strip domain to bare form: "https://www.foo.com/path" → "foo.com" ─────────
function stripDomain(str) {
    return (str || '').trim().toLowerCase()
        .replace(/^https?:\/\//i, '').replace(/^www\./i, '')
        .split('/')[0].split('?')[0].trim();
}

// ── POST to DeepSeek via Node https (no external deps) ───────────────────────
function deepseekPost(apiKey, messages, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({
            model: MODEL,
            messages,
            max_tokens: 800,
            temperature: 0,
            response_format: { type: 'json_object' },
        }));

        const url = new URL(API_URL);
        const req = https.request({
            hostname: url.hostname,
            path:     url.pathname,
            method:   'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': body.length,
            },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) return reject(new Error(parsed.error.message || 'DeepSeek API error'));
                    resolve(parsed);
                } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
            });
        });

        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('DeepSeek timeout')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Build prompt for a batch of leads ─────────────────────────────────────────
function buildPrompt(batch) {
    const items = batch.map((r, i) => {
        const d1 = stripDomain(r.salesqlOrgWebsite);
        const d2 = stripDomain(r.emailDomain);
        const d3 = stripDomain(r.salesqlEmail);
        // Deduplicate candidates
        const candidates = [...new Set([d1, d2, d3].filter(Boolean))];
        return `${i}: company="${r.companyName}" candidates=[${candidates.join(', ')}]`;
    }).join('\n');

    return [
        {
            role: 'system',
            content: `You are a company domain validator. For each company, pick which domain belongs to that company.
Rules:
- Return ONLY valid JSON: {"results": [{"index": 0, "domain": "chosen.com"}, ...]}
- domain must be one of the candidates (bare domain, no http/www)
- If no candidate matches the company, use domain: null
- Never invent domains not in the candidates list`,
        },
        {
            role: 'user',
            content: `Validate these company domains:\n${items}\n\nReturn JSON only.`,
        },
    ];
}

// ── Process one batch through DeepSeek ───────────────────────────────────────
async function processBatch(batch, apiKey, pageNum) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await deepseekPost(apiKey, buildPrompt(batch));
            const content  = response.choices?.[0]?.message?.content || '{}';

            let parsed;
            try { parsed = JSON.parse(content); } catch { parsed = {}; }

            const results = Array.isArray(parsed.results) ? parsed.results : [];

            // Apply results back to batch records
            for (const item of results) {
                const rec = batch[item.index];
                if (!rec) continue;

                const chosen = (item.domain || '').toLowerCase().trim();
                const d1 = stripDomain(rec.salesqlOrgWebsite);
                const d2 = stripDomain(rec.emailDomain);
                const d3 = stripDomain(rec.salesqlEmail);

                if (chosen && [d1, d2, d3].includes(chosen)) {
                    // DeepSeek picked a winner — set Website to the full URL from the matching source
                    if (chosen === d1) rec._dsWebsite = rec.salesqlOrgWebsite || chosen;
                    else if (chosen === d2) rec._dsWebsite = rec.emailDomain || chosen;
                    else rec._dsWebsite = rec.salesqlEmail || chosen;
                } else {
                    // No match found
                    rec._dsWebsite = null;
                }
                rec._dsValidated = true;
            }

            const matched = results.filter(r => r.domain).length;
            console.log(`🤖 [DeepSeek] Page ${pageNum} batch: ${matched}/${batch.length} domains validated`);
            return true;

        } catch (err) {
            if (attempt < MAX_RETRIES) {
                console.log(`⚠️ [DeepSeek] Batch error (attempt ${attempt + 1}): ${err.message} — retrying...`);
                await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
            } else {
                console.log(`⚠️ [DeepSeek] Batch failed after ${MAX_RETRIES + 1} attempts: ${err.message}`);
            }
        }
    }
    return false;
}

// ── Apply validated domains back to the JSONL and regenerate CSV ──────────────
async function applyToJSONL(validatedRecords, leadsJsonl, generateCSVFn, leadsCSV, pageNum) {
    try {
        if (!fs.existsSync(leadsJsonl)) return;

        const lines    = fs.readFileSync(leadsJsonl, 'utf-8').trim().split('\n').filter(Boolean);
        const urlIndex = new Map(); // personSalesUrl → validated record
        const nameIdx  = new Map(); // fullName       → validated record

        for (const rec of validatedRecords) {
            if (!rec._dsValidated) continue;
            if (rec.personSalesUrl) urlIndex.set(rec.personSalesUrl.toLowerCase(), rec);
            else if (rec.fullName)  nameIdx.set(rec.fullName.toLowerCase(), rec);
        }

        let changed = 0;
        const updated = lines.map(line => {
            let obj;
            try { obj = JSON.parse(line); } catch { return line; }

            const key  = (obj.personSalesUrl || '').toLowerCase();
            const kname = (obj.fullName || '').toLowerCase();
            const match = (key && urlIndex.get(key)) || (kname && nameIdx.get(kname));

            if (match && match._dsValidated) {
                const newSite    = match._dsWebsite || '';
                const newDomain  = stripDomain(newSite);

                // Write validated domain into Website column
                obj.salesqlOrgWebsite = newSite;

                // ── Dedup: remove Website_one / Website_two if they carry the same
                //    domain as the validated Website. After DeepSeek picks the winner,
                //    keeping duplicates in the other columns adds no information.
                const w1 = stripDomain(obj.emailDomain);
                const w2 = stripDomain(obj.salesqlEmail);

                if (newDomain) {
                    // Clear Website_one if it's the same bare domain as Website
                    if (w1 && w1 === newDomain) obj.emailDomain  = '';
                    // Clear Website_two if it's the same bare domain as Website
                    if (w2 && w2 === newDomain) obj.salesqlEmail = '';
                    // Also clear Website_two if it duplicates Website_one (after above)
                    const w1After = stripDomain(obj.emailDomain);
                    const w2After = stripDomain(obj.salesqlEmail);
                    if (w1After && w2After && w1After === w2After) obj.salesqlEmail = '';
                } else {
                    // DeepSeek found no match — clear Website, leave Website_one/two as-is
                    obj.salesqlOrgWebsite = '';
                }

                changed++;
            }
            return JSON.stringify(obj);
        });

        fs.writeFileSync(leadsJsonl, updated.join('\n') + '\n');

        if (changed > 0) {
            await generateCSVFn(leadsJsonl, leadsCSV);
            console.log(`✅ [DeepSeek] Page ${pageNum}: updated ${changed} records → CSV regenerated`);
        }
    } catch (err) {
        console.log(`⚠️ [DeepSeek] JSONL update error: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Fire-and-forget enrichment for one page's merged records
// Call from job-runner WITHOUT await — runs in background while scraper continues
// ═══════════════════════════════════════════════════════════════════════════════
function enrichPageAsync(mergedRecords, { apiKey, leadsJsonl, leadsCSV, generateCSVFn, pageNum }) {
    if (!apiKey) {
        console.log('⚠️ [DeepSeek] No API key configured — skipping enrichment');
        return;
    }

    // Only process records that have at least one candidate domain
    const eligible = mergedRecords.filter(r =>
        r.companyName && (r.salesqlOrgWebsite || r.emailDomain || r.salesqlEmail)
    );

    if (eligible.length === 0) {
        console.log(`🤖 [DeepSeek] Page ${pageNum}: no eligible records`);
        return;
    }

    const promise = (async () => {
        console.log(`🤖 [DeepSeek] Page ${pageNum}: enriching ${eligible.length} records (background)...`);

        // Split into batches and process all in parallel
        const batches = [];
        for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
            batches.push(eligible.slice(i, i + BATCH_SIZE));
        }

        await Promise.all(
            batches.map((batch, bi) => processBatch(batch, apiKey, `${pageNum}.${bi + 1}`))
        );

        // Write results back
        await applyToJSONL(eligible, leadsJsonl, generateCSVFn, leadsCSV, pageNum);
    })();

    // Track promise so waitForAll() can drain at job end
    _pendingEnrichments.push(promise.catch(err =>
        console.log(`⚠️ [DeepSeek] Page ${pageNum} enrichment error: ${err.message}`)
    ));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Wait for all background enrichments to finish (call at job end)
// ═══════════════════════════════════════════════════════════════════════════════
async function waitForAllEnrichments() {
    if (_pendingEnrichments.length === 0) return;
    console.log(`🤖 [DeepSeek] Waiting for ${_pendingEnrichments.length} pending enrichment(s)...`);
    await Promise.all(_pendingEnrichments);
    console.log('✅ [DeepSeek] All enrichments complete');
}

module.exports = { enrichPageAsync, waitForAllEnrichments };