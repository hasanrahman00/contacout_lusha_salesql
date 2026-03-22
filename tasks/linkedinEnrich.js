// ═══════════════════════════════════════════════════════════════════════════════
// TASK: LinkedIn Company Domain Enricher — v3.2.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// BATCH MODE:
//   enrichBatchFromJSONL() runs every 2-5 pages (random interval).
//   Called AFTER navigating to a new page, BEFORE the scraping flow starts.
//
// TARGET RECORDS (all conditions must be true):
//   1. _purified === 'yes'                → DeepSeek has analyzed this row
//   2. salesqlOrgWebsite is empty         → DeepSeek found no matching domain
//   3. _websiteStatus !== 'not_found'     → not already checked by LinkedIn
//   4. companyLinkedin exists             → has a company URL to query
//
// This ensures LinkedIn NEVER processes rows that DeepSeek hasn't purified.
// With fire-and-forget DeepSeek, some rows may not be purified yet when
// LinkedIn batch runs — those are safely skipped and caught in the next batch
// or the final batch at end of job (after DeepSeek drains).
//
// DOMAIN FILTER:
//   Filters out linkedin.com and its subdomains.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');

const _companyCache = new Map();

const BLOCKED_DOMAINS = new Set([
    'linkedin.com',
    'www.linkedin.com',
]);

function extractCompanyId(companyLinkedin) {
    if (!companyLinkedin) return null;
    const m = companyLinkedin.match(/\/company\/(\d+)/);
    return m ? m[1] : null;
}

function cleanDomain(url) {
    return (url || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split('/')[0]
        .split('?')[0]
        .trim();
}

function isBlockedDomain(domain) {
    if (!domain) return true;
    const clean = cleanDomain(domain);
    if (BLOCKED_DOMAINS.has(clean)) return true;
    if (clean.endsWith('.linkedin.com')) return true;
    return false;
}

async function fetchCompanyFromLinkedIn(page, companyId) {
    try {
        const result = await page.evaluate(async (id) => {
            const csrfToken = (document.cookie.match(/JSESSIONID=.([^;]+)/) || [])[1]?.replace(/"/g, '') || '';
            const url = `https://www.linkedin.com/sales-api/salesApiCompanies/${id}?decoration=%28entityUrn%2Cname%2Cwebsite%2Cindustry%2CemployeeCount%2Clocation%2CflagshipCompanyUrl%2Cheadquarters%29`;
            const resp = await fetch(url, {
                credentials: 'include',
                headers: {
                    'accept': 'application/json',
                    'csrf-token': csrfToken,
                    'x-restli-protocol-version': '2.0.0',
                    'x-li-lang': 'en_US'
                }
            });
            if (!resp.ok) return null;
            return await resp.json();
        }, companyId);
        return result || null;
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Batch enrichment from JSONL
// Only processes purified rows where Website is still empty after DeepSeek.
// ═══════════════════════════════════════════════════════════════════════════════
async function enrichBatchFromJSONL(leadsJsonl, leadsCSV, page, generateCSVFn, options = {}) {
    const { delayMs = 300 } = options;

    if (!fs.existsSync(leadsJsonl)) {
        console.log('⚠️ [LinkedInEnrich] No JSONL file found — skipping');
        return;
    }

    const lines = fs.readFileSync(leadsJsonl, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;

    const records = [];
    for (const line of lines) {
        try { records.push(JSON.parse(line)); } catch { records.push(null); }
    }

    // Only purified rows with empty Website, not already checked, with company URL
    const needEnrich = records.filter(r =>
        r &&
        r._purified === 'yes' &&
        !r.salesqlOrgWebsite &&
        r._websiteStatus !== 'not_found' &&
        r.companyLinkedin
    );

    // Count unpurified for logging
    const unpurified = records.filter(r => r && !r._purified).length;

    if (needEnrich.length === 0) {
        if (unpurified > 0) {
            console.log(`✅ [LinkedInEnrich] No purified empty-Website records — ${unpurified} still awaiting DeepSeek`);
        } else {
            console.log('✅ [LinkedInEnrich] No new records to enrich — skipping');
        }
        return;
    }

    console.log(`🔗 [LinkedInEnrich] Batch: ${needEnrich.length} purified records to enrich...${unpurified > 0 ? ` (${unpurified} still awaiting DeepSeek)` : ''}`);

    let enriched = 0;
    let noWebsite = 0;
    let noData   = 0;
    let cached   = 0;
    let blocked  = 0;
    let noId     = 0;

    for (const rec of needEnrich) {
        const companyId = extractCompanyId(rec.companyLinkedin);
        if (!companyId) {
            rec._websiteStatus = 'not_found';
            noId++;
            continue;
        }

        let fromCache = false;
        if (!_companyCache.has(companyId)) {
            const data = await fetchCompanyFromLinkedIn(page, companyId);
            _companyCache.set(companyId, data);
            await new Promise(r => setTimeout(r, delayMs));
        } else {
            fromCache = true;
            cached++;
        }

        const companyData = _companyCache.get(companyId);
        const companyLabel = `${rec.companyName || '?'} (#${companyId})`;

        if (!companyData) {
            rec._websiteStatus = 'not_found';
            console.log(`   ❌ [LinkedInEnrich] ${companyLabel} — API returned no data${fromCache ? ' (cached)' : ''}`);
            noData++;
            continue;
        }

        if (!companyData.website) {
            rec._websiteStatus = 'not_found';
            console.log(`   ⚠️ [LinkedInEnrich] ${companyLabel} — no website on LinkedIn${fromCache ? ' (cached)' : ''}`);
            noWebsite++;
            continue;
        }

        const domain = cleanDomain(companyData.website);

        if (isBlockedDomain(domain)) {
            rec._websiteStatus = 'not_found';
            console.log(`   🚫 [LinkedInEnrich] ${companyLabel} — blocked domain: ${domain}${fromCache ? ' (cached)' : ''}`);
            blocked++;
            continue;
        }

        // Success — fill Website, clear status
        rec.salesqlOrgWebsite = domain;
        rec._websiteStatus = '';

        // Only clear W1/W2 if exact duplicate of new Website
        if (rec.emailDomain === domain)  rec.emailDomain  = '';
        if (rec.salesqlEmail === domain) rec.salesqlEmail = '';

        if (!rec.salesqlOrgEmployees && companyData.employeeCount) {
            rec.salesqlOrgEmployees = String(companyData.employeeCount);
        }
        if (!rec.industry && companyData.industry) {
            rec.industry = companyData.industry;
        }

        console.log(`   ✅ [LinkedInEnrich] ${companyLabel} → ${domain}${fromCache ? ' (cached)' : ''}`);
        enriched++;
    }

    console.log(`✅ [LinkedInEnrich] Enriched:${enriched} | No website:${noWebsite} | No data:${noData} | Blocked:${blocked} | No ID:${noId} | Cached:${cached} | Total API calls:${_companyCache.size}`);

    // Always write back — persists flags
    const updated = records.map(r => r ? JSON.stringify(r) : '').filter(Boolean);
    fs.writeFileSync(leadsJsonl, updated.join('\n') + '\n');

    if (enriched > 0) {
        await generateCSVFn(leadsJsonl, leadsCSV);
        console.log(`✅ [LinkedInEnrich] JSONL + CSV regenerated`);
    } else {
        console.log(`✅ [LinkedInEnrich] JSONL updated (flags saved)`);
    }
}

function randomInterval(min = 2, max = 5) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

module.exports = { enrichBatchFromJSONL, randomInterval };