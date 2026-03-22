// ═══════════════════════════════════════════════════════════════════════════════
// TASK: LinkedIn Company Domain Enricher — v3.0.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// BATCH MODE:
//   enrichBatchFromJSONL() runs every 2-5 pages (random interval).
//   Called AFTER navigating to a new page, BEFORE the scraping flow starts,
//   so it doesn't interfere with page data capture.
//
//   Records are marked _linkedinChecked=true after being processed (hit or miss)
//   so the enricher never checks the same company twice.
//
//   Module-level company cache persists across calls — same company = 1 API call.
//
// DOMAIN FILTER:
//   Filters out linkedin.com and its subdomains — some companies list LinkedIn
//   as their "website" which is useless data.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');

// ── Module-level company cache — shared across all batch calls ───────────────
const _companyCache = new Map();

// ── Blocked domains — useless results from LinkedIn API ──────────────────────
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
// Reads all records, finds unchecked empty-Website records, enriches them,
// marks all as _linkedinChecked, writes back, regenerates CSV.
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

    // Find unchecked records: empty Website + has companyLinkedin + not yet checked
    const needEnrich = records.filter(r =>
        r && !r.salesqlOrgWebsite && r.companyLinkedin && !r._linkedinChecked
    );

    if (needEnrich.length === 0) {
        console.log('✅ [LinkedInEnrich] No unchecked records — skipping');
        return;
    }

    console.log(`🔗 [LinkedInEnrich] Batch: ${needEnrich.length} unchecked records to enrich...`);

    let enriched = 0;
    let noWebsite = 0;
    let noData   = 0;
    let cached   = 0;
    let blocked  = 0;

    for (const rec of needEnrich) {
        const companyId = extractCompanyId(rec.companyLinkedin);
        if (!companyId) {
            rec._linkedinChecked = true;
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

        // Mark as checked regardless of outcome — never re-check this record
        rec._linkedinChecked = true;

        if (!companyData) {
            console.log(`   ❌ [LinkedInEnrich] ${companyLabel} — API returned no data${fromCache ? ' (cached)' : ''}`);
            noData++;
            continue;
        }

        if (!companyData.website) {
            console.log(`   ⚠️ [LinkedInEnrich] ${companyLabel} — no website on LinkedIn${fromCache ? ' (cached)' : ''}`);
            noWebsite++;
            continue;
        }

        const domain = cleanDomain(companyData.website);

        // Filter out linkedin.com and subdomains
        if (isBlockedDomain(domain)) {
            console.log(`   🚫 [LinkedInEnrich] ${companyLabel} — blocked domain: ${domain}${fromCache ? ' (cached)' : ''}`);
            blocked++;
            continue;
        }

        rec.salesqlOrgWebsite = domain;

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

    console.log(`✅ [LinkedInEnrich] Enriched:${enriched} | No website:${noWebsite} | No data:${noData} | Blocked:${blocked} | Cached:${cached} | Total API calls:${_companyCache.size}`);

    // Always write back — even if 0 enriched, we persist _linkedinChecked flags
    const updated = records.map(r => r ? JSON.stringify(r) : '').filter(Boolean);
    fs.writeFileSync(leadsJsonl, updated.join('\n') + '\n');

    if (enriched > 0) {
        await generateCSVFn(leadsJsonl, leadsCSV);
        console.log(`✅ [LinkedInEnrich] JSONL + CSV regenerated`);
    } else {
        console.log(`✅ [LinkedInEnrich] JSONL updated (checked flags saved)`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Generate random interval between min and max (inclusive)
// ═══════════════════════════════════════════════════════════════════════════════
function randomInterval(min = 2, max = 5) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

module.exports = { enrichBatchFromJSONL, randomInterval };