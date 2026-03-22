// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 TASK: DeepSeek Company Domain Enricher — v3.1.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// FIRE-AND-FORGET DESIGN:
//   DeepSeek is pure HTTPS — no Playwright page needed.
//   enrichPageAsync() fires in background, scraper continues to next page.
//   JSONL writes serialized via _writeLock to prevent race conditions.
//   waitForAllEnrichments() drains at end of job before LinkedIn batch runs.
//
// PURIFICATION FLAG:
//   Every record from the page gets _purified='yes' in JSONL — including
//   records with zero candidate domains (nothing to validate, but still "done").
//   LinkedIn enricher only targets rows with _purified='yes'.
//
// PHASE 2 LOGIC (runs after Phase 1 clean+dedup in mergeData.js):
//   - All 3 domain columns are already bare root domains
//   - DeepSeek picks which domain matches the company → Website column
//   - Unmatched domains → Website_one and Website_two (valid email data kept)
//   - If no match → Website cleared, all domains stay in W1/W2
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs    = require('fs');
const https = require('https');

const BATCH_SIZE  = 10;
const MODEL       = 'deepseek-chat';
const API_URL     = 'https://api.deepseek.com/v1/chat/completions';
const MAX_RETRIES = 2;
const RETRY_DELAY = 2000;

const _pendingEnrichments = [];
let _writeLock = Promise.resolve();

function stripDomain(str) {
    return (str || '').trim().toLowerCase()
        .replace(/^https?:\/\//i, '').replace(/^www\./i, '')
        .split('/')[0].split('?')[0].trim();
}

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

async function applyToJSONL(validatedRecords, allPageRecords, leadsJsonl, generateCSVFn, leadsCSV, pageNum) {
    try {
        if (!fs.existsSync(leadsJsonl)) return;

        const lines = fs.readFileSync(leadsJsonl, 'utf-8').trim().split('\n').filter(Boolean);

        // Index for domain reshuffling (only validated records)
        const urlIndex = new Map();
        const nameIdx  = new Map();
        for (const rec of validatedRecords) {
            if (!rec._dsValidated) continue;
            if (rec.personSalesUrl) urlIndex.set(rec.personSalesUrl.toLowerCase(), rec);
            else if (rec.fullName)  nameIdx.set(rec.fullName.toLowerCase(), rec);
        }

        // Index for ALL page records — used to stamp _purified on every row
        const allUrlIdx  = new Map();
        const allNameIdx = new Map();
        for (const rec of allPageRecords) {
            if (rec.personSalesUrl) allUrlIdx.set(rec.personSalesUrl.toLowerCase(), true);
            else if (rec.fullName)  allNameIdx.set(rec.fullName.toLowerCase(), true);
        }

        let changed = 0;
        let purifiedCount = 0;
        const updated = lines.map(line => {
            let obj;
            try { obj = JSON.parse(line); } catch { return line; }

            const key   = (obj.personSalesUrl || '').toLowerCase();
            const kname = (obj.fullName || '').toLowerCase();

            // Domain reshuffling — only for DeepSeek-validated records
            const match = (key && urlIndex.get(key)) || (kname && nameIdx.get(kname));
            if (match && match._dsValidated) {
                const chosenDomain = stripDomain(match._dsWebsite || '');

                const w  = stripDomain(obj.salesqlOrgWebsite);
                const w1 = stripDomain(obj.emailDomain);
                const w2 = stripDomain(obj.salesqlEmail);

                if (chosenDomain) {
                    obj.salesqlOrgWebsite = chosenDomain;
                    const remaining = [...new Set([w, w1, w2].filter(d => d && d !== chosenDomain))];
                    obj.emailDomain  = remaining[0] || '';
                    obj.salesqlEmail = remaining[1] || '';
                } else {
                    const allDomains = [...new Set([w, w1, w2].filter(Boolean))];
                    obj.salesqlOrgWebsite = '';
                    obj.emailDomain       = allDomains[0] || '';
                    obj.salesqlEmail      = allDomains[1] || '';
                }
                changed++;
            }

            // Stamp _purified on ALL records from this page
            // (including those with no domains — DeepSeek had nothing to validate,
            //  but they're still "done" and ready for LinkedIn enrichment)
            const isPageRecord = (key && allUrlIdx.has(key)) || (kname && allNameIdx.has(kname));
            if (isPageRecord && obj._purified !== 'yes') {
                obj._purified = 'yes';
                purifiedCount++;
            }

            return JSON.stringify(obj);
        });

        fs.writeFileSync(leadsJsonl, updated.join('\n') + '\n');

        if (changed > 0 || purifiedCount > 0) {
            await generateCSVFn(leadsJsonl, leadsCSV);
            console.log(`✅ [DeepSeek] Page ${pageNum}: updated ${changed} records, purified ${changed + purifiedCount} total → CSV regenerated`);
        }
    } catch (err) {
        console.log(`⚠️ [DeepSeek] JSONL update error: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Fire-and-forget — does NOT block the scraper
// Stamps _purified='yes' on ALL page records, even those with no domains.
// ═══════════════════════════════════════════════════════════════════════════════
function enrichPageAsync(mergedRecords, { apiKey, leadsJsonl, leadsCSV, generateCSVFn, pageNum }) {
    if (!mergedRecords || mergedRecords.length === 0) return;

    const eligible = mergedRecords.filter(r =>
        r.companyName && (r.salesqlOrgWebsite || r.emailDomain || r.salesqlEmail)
    );

    if (!apiKey) {
        console.log('⚠️ [DeepSeek] No API key configured — stamping purified only');
    }

    const promise = (async () => {
        if (apiKey && eligible.length > 0) {
            console.log(`🤖 [DeepSeek] Page ${pageNum}: enriching ${eligible.length} records (background)...`);

            const batches = [];
            for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
                batches.push(eligible.slice(i, i + BATCH_SIZE));
            }

            await Promise.all(
                batches.map((batch, bi) => processBatch(batch, apiKey, `${pageNum}.${bi + 1}`))
            );
        } else if (apiKey) {
            console.log(`🤖 [DeepSeek] Page ${pageNum}: no eligible records — stamping purified`);
        }

        // Always write back — stamps _purified on ALL page records
        // even those with no domains (nothing to validate but still "done")
        _writeLock = _writeLock.then(() =>
            applyToJSONL(eligible, mergedRecords, leadsJsonl, generateCSVFn, leadsCSV, pageNum)
        ).catch(err => console.log(`⚠️ [DeepSeek] Write lock error: ${err.message}`));
        await _writeLock;
    })();

    _pendingEnrichments.push(promise.catch(err =>
        console.log(`⚠️ [DeepSeek] Page ${pageNum} enrichment error: ${err.message}`)
    ));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Drain all pending enrichments (call at end of job)
// ═══════════════════════════════════════════════════════════════════════════════
async function waitForAllEnrichments() {
    if (_pendingEnrichments.length === 0) return;
    console.log(`🤖 [DeepSeek] Waiting for ${_pendingEnrichments.length} pending enrichment(s)...`);
    await Promise.all(_pendingEnrichments);
    console.log('✅ [DeepSeek] All enrichments complete');
}

module.exports = { enrichPageAsync, waitForAllEnrichments };