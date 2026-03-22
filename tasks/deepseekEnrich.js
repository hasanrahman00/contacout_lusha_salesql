// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 TASK: DeepSeek Company Domain Enricher — v2.0.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
//   After each page is scraped, merged, cleaned, deduped, and appended to JSONL,
//   send each lead's company name + clean domains to DeepSeek to validate which
//   domain belongs to the company. Result is written back into JSONL + CSV/XLSX.
//
// PHASE 2 LOGIC (runs after Phase 1 clean+dedup in mergeData.js):
//   - All 3 domain columns are already bare root domains (e.g. "acme.com")
//   - DeepSeek picks which domain matches the company → Website column
//   - Unmatched domains → Website_one and Website_two (max 2, extras dropped)
//   - Duplicates cleared: Website takes priority
//
// PARALLEL DESIGN:
//   - Job runner calls enrichPageAsync() fire-and-forget (does NOT await).
//   - DeepSeek API calls run in parallel batches.
//   - JSONL writes are serialized via _writeLock to prevent race conditions.
//
// API: https://api.deepseek.com/v1/chat/completions  Model: deepseek-chat
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs    = require('fs');
const https = require('https');

const BATCH_SIZE  = 10;
const MODEL       = 'deepseek-chat';
const API_URL     = 'https://api.deepseek.com/v1/chat/completions';
const MAX_RETRIES = 2;
const RETRY_DELAY = 2000;

// ── Active pending enrichment promises (fire-and-forget tracker) ─────────────
const _pendingEnrichments = [];

// ── Serialize JSONL writes — prevents race condition between concurrent pages ─
let _writeLock = Promise.resolve();

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

            for (const item of results) {
                const rec = batch[item.index];
                if (!rec) continue;

                const chosen = (item.domain || '').toLowerCase().trim();
                const d1 = stripDomain(rec.salesqlOrgWebsite);
                const d2 = stripDomain(rec.emailDomain);
                const d3 = stripDomain(rec.salesqlEmail);

                if (chosen && [d1, d2, d3].includes(chosen)) {
                    // DeepSeek matched — store the clean bare domain
                    rec._dsWebsite = chosen;
                } else {
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
        const urlIndex = new Map();
        const nameIdx  = new Map();

        for (const rec of validatedRecords) {
            if (!rec._dsValidated) continue;
            if (rec.personSalesUrl) urlIndex.set(rec.personSalesUrl.toLowerCase(), rec);
            else if (rec.fullName)  nameIdx.set(rec.fullName.toLowerCase(), rec);
        }

        let changed = 0;
        const updated = lines.map(line => {
            let obj;
            try { obj = JSON.parse(line); } catch { return line; }

            const key   = (obj.personSalesUrl || '').toLowerCase();
            const kname = (obj.fullName || '').toLowerCase();
            const match = (key && urlIndex.get(key)) || (kname && nameIdx.get(kname));

            if (match && match._dsValidated) {
                const chosenDomain = stripDomain(match._dsWebsite || '');

                // Collect all current domains from the record
                const w  = stripDomain(obj.salesqlOrgWebsite);
                const w1 = stripDomain(obj.emailDomain);
                const w2 = stripDomain(obj.salesqlEmail);

                if (chosenDomain) {
                    // ── Match found: winner → Website, remaining → one/two ──
                    obj.salesqlOrgWebsite = chosenDomain;

                    // Collect unmatched domains (unique, exclude the winner)
                    // Include w — the original Website value that's being overwritten by the winner
                    const remaining = [...new Set([w, w1, w2].filter(d => d && d !== chosenDomain))];
                    obj.emailDomain  = remaining[0] || '';
                    obj.salesqlEmail = remaining[1] || '';
                } else {
                    // ── No match: clear Website, keep up to 2 in one/two ────
                    const allDomains = [...new Set([w, w1, w2].filter(Boolean))];
                    obj.salesqlOrgWebsite = '';
                    obj.emailDomain       = allDomains[0] || '';
                    obj.salesqlEmail      = allDomains[1] || '';
                    // 3rd domain dropped (2-domain cap)
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

        // Split into batches and process DeepSeek API calls in parallel
        const batches = [];
        for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
            batches.push(eligible.slice(i, i + BATCH_SIZE));
        }

        await Promise.all(
            batches.map((batch, bi) => processBatch(batch, apiKey, `${pageNum}.${bi + 1}`))
        );

        // Serialize JSONL writes — chain onto _writeLock so concurrent pages
        // don't read/write the same file simultaneously
        _writeLock = _writeLock.then(() =>
            applyToJSONL(eligible, leadsJsonl, generateCSVFn, leadsCSV, pageNum)
        ).catch(err => console.log(`⚠️ [DeepSeek] Write lock error: ${err.message}`));
        await _writeLock;
    })();

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