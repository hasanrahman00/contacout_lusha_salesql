// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 DeepSeek Domain Purifier — website-enricher/deepseekPurifier.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// After Gemini returns candidate domains for a batch of companies,
// send them to DeepSeek to confirm each domain actually belongs to
// the correct company. Drops wrong domains, keeps only confirmed ones.
//
// INPUT per record:  { companyName, geminiDomain }
// OUTPUT per record: { companyName, domain }  (domain is null if rejected)
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const https = require('https');

const MODEL      = 'deepseek-chat';
const API_URL    = 'https://api.deepseek.com/v1/chat/completions';
const BATCH_SIZE = 15;
const MAX_RETRY  = 2;

function stripDomain(str) {
    return (str || '').trim().toLowerCase()
        .replace(/^https?:\/\//i, '').replace(/^www\./i, '')
        .split('/')[0].split('?')[0].trim();
}

function deepseekPost(apiKey, messages, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({
            model:           MODEL,
            messages,
            max_tokens:      600,
            temperature:     0,
            response_format: { type: 'json_object' },
        }));
        const url = new URL(API_URL);
        const req = https.request({
            hostname: url.hostname,
            path:     url.pathname,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Authorization':  `Bearer ${apiKey}`,
                'Content-Length': body.length,
            },
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const p = JSON.parse(data);
                    if (p.error) return reject(new Error(p.error.message || 'API error'));
                    resolve(p);
                } catch (e) { reject(new Error(`Parse: ${e.message}`)); }
            });
        });
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Purify a batch of { companyName, geminiDomain } records ─────────────────
async function purifiyBatch(batch, apiKey) {
    const items = batch.map((r, i) =>
        `${i}: company="${r.companyName}" candidate_domain="${r.geminiDomain || ''}"`
    ).join('\n');

    const messages = [
        {
            role: 'system',
            content: `You are a company website domain validator. For each company and candidate domain, decide if the domain is a plausible official website for that company.
Return ONLY JSON: {"results": [{"index": 0, "domain": "confirmed.com"}, ...]}

Rules:
- ACCEPT if the domain clearly relates to the company name (partial match, abbreviation, or known brand is fine)
- ACCEPT if the domain looks like a plausible business website for that company type
- ACCEPT abbreviated domains (e.g. "ddidental.com" for a dental company, "cdillc.com" for "CDI LLC")
- ACCEPT domains extracted from search queries — they are Gemini's best guess, not confirmed
- REJECT only if the domain is clearly unrelated to the company (e.g. a competitor, generic portal, or completely different industry)
- REJECT if domain is empty or null
- Never invent new domains — use only the candidate provided or null`,
        },
        { role: 'user', content: `Validate these company domains:\n${items}` },
    ];

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            const resp    = await deepseekPost(apiKey, messages);
            const content = resp.choices?.[0]?.message?.content || '{}';
            let parsed;
            try { parsed = JSON.parse(content); } catch { parsed = {}; }

            const results = Array.isArray(parsed.results) ? parsed.results : [];
            const out     = batch.map(r => ({ companyName: r.companyName, domain: null }));

            for (const item of results) {
                if (out[item.index] !== undefined) {
                    out[item.index].domain = item.domain ? stripDomain(item.domain) : null;
                }
            }
            return out;
        } catch (err) {
            if (attempt < MAX_RETRY) {
                await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            } else {
                console.log(`⚠️ [Purifier] Batch failed: ${err.message}`);
                return batch.map(r => ({ companyName: r.companyName, domain: null }));
            }
        }
    }
}

// ── PUBLIC: purify array of { companyName, geminiDomain } ───────────────────
async function purifyDomains(records, apiKey) {
    if (!apiKey) return records.map(r => ({ companyName: r.companyName, domain: null }));

    const results = [];
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch     = records.slice(i, i + BATCH_SIZE);
        const batchOut  = await purifiyBatch(batch, apiKey);
        results.push(...batchOut);
    }

    const confirmed = results.filter(r => r.domain).length;
    console.log(`🤖 [Purifier] ${confirmed}/${records.length} domains confirmed by DeepSeek`);
    return results;
}

module.exports = { purifyDomains, stripDomain };