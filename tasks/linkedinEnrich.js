// ═══════════════════════════════════════════════════════════════════════════════
// TASK: LinkedIn Company Domain Enricher — v3.1.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// BATCH MODE:
//   enrichBatchFromJSONL() runs every 2-5 pages (random interval).
//   Called AFTER navigating to a new page, BEFORE the scraping flow starts.
//
// STATUS TRACKING:
//   Records that are checked and have NO website get:
//     _websiteStatus = 'not_found'
//   This persists in JSONL so future scans skip them.
//
//   Enricher targets:  empty salesqlOrgWebsite AND _websiteStatus !== 'not_found'
//   Enricher skips:    has salesqlOrgWebsite (filled) OR _websiteStatus === 'not_found'
//   Result:            every batch processes only genuinely new unchecked records.
//
//   _websiteStatus does NOT appear in CSV (not in COLUMNS list in generateCSV).
//
// DOMAIN FILTER:
//   Filters out linkedin.com and its subdomains.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');

// ── Module-level company cache — shared across all batch calls ───────────────
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
// Targets: empty Website + no not_found status + has companyLinkedin
// Marks misses as _websiteStatus='not_found' so they're never rechecked.
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

    // Target: empty Website + not already marked not_found + has company URL
    const needEnrich = records.filter(r =>
        r && !r.salesqlOrgWebsite && r._websiteStatus !== 'not_found' && r.companyLinkedin
    );

    if (needEnrich.length === 0) {
        console.log('✅ [LinkedInEnrich] No new unchecked records — skipping');
        return;
    }

    console.log(`🔗 [LinkedInEnrich] Batch: ${needEnrich.length} unchecked records to enrich...`);

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

        // Dedup: clear Website_one/two if they match the new Website
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

    // Always write back — persists _websiteStatus='not_found' flags + any new Website fills
    const updated = records.map(r => r ? JSON.stringify(r) : '').filter(Boolean);
    fs.writeFileSync(leadsJsonl, updated.join('\n') + '\n');

    if (enriched > 0) {
        await generateCSVFn(leadsJsonl, leadsCSV);
        console.log(`✅ [LinkedInEnrich] JSONL + CSV regenerated`);
    } else {
        console.log(`✅ [LinkedInEnrich] JSONL updated (not_found flags saved)`);
    }
}

function randomInterval(min = 2, max = 5) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

module.exports = { enrichBatchFromJSONL, randomInterval };