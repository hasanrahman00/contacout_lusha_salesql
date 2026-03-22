// ═══════════════════════════════════════════════════════════════════════════════
// TASK: LinkedIn Company Domain Enricher — v1.1.0
// ═══════════════════════════════════════════════════════════════════════════════
//
// Uses LinkedIn Sales API via existing Playwright page session to fetch
// company website domain for records that still have an empty Website column
// after DeepSeek validation.
//
// Two entry points:
//   enrichCompanyDomains(records, page)    — in-memory array (per-page use)
//   enrichFromJSONL(leadsJsonl, leadsCSV, page, generateCSVFn)
//       — reads JSONL, enriches empty-Website records, writes back, regenerates CSV
//       — intended to run ONCE at end of job after waitForAllEnrichments()
//
// Integration in job-runner.js:
//   await waitForAllEnrichments();
//   await enrichFromJSONL(LEADS_JSONL, LEADS_CSV, page, generateCSV);
//   await generateCSV(LEADS_JSONL, LEADS_CSV);
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');

// Extract numeric company ID from companyLinkedin URL
// "https://www.linkedin.com/sales/company/2757798" → "2757798"
function extractCompanyId(companyLinkedin) {
    if (!companyLinkedin) return null;
    const m = companyLinkedin.match(/\/company\/(\d+)/);
    return m ? m[1] : null;
}

// Clean domain from full URL → bare root domain
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

// Fetch company data via Playwright page.evaluate (uses browser cookies automatically)
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

/**
 * Enrich in-memory records with company website from LinkedIn Sales API.
 * Fills only the Website column (salesqlOrgWebsite) with a clean domain.
 *
 * @param {Array}  records  - merged records from mergePageData()
 * @param {Object} page     - Playwright page object
 * @param {Object} [options]
 *   @param {number} delayMs - delay between API calls (default: 300ms)
 */
async function enrichCompanyDomains(records, page, options = {}) {
    const { delayMs = 300 } = options;

    if (!records || records.length === 0) return records;

    const companyCache = new Map();
    let enriched = 0;
    let skipped  = 0;
    let noId     = 0;

    for (const rec of records) {
        // Only enrich records with empty Website
        if (rec.salesqlOrgWebsite) { skipped++; continue; }

        const companyId = extractCompanyId(rec.companyLinkedin);
        if (!companyId) { noId++; continue; }

        // Use cache to avoid duplicate API calls for same company
        let fromCache = false;
        if (!companyCache.has(companyId)) {
            const data = await fetchCompanyFromLinkedIn(page, companyId);
            companyCache.set(companyId, data);
            await new Promise(r => setTimeout(r, delayMs));
        } else {
            fromCache = true;
        }

        const companyData = companyCache.get(companyId);
        const companyLabel = `${rec.companyName || '?'} (#${companyId})`;

        if (!companyData) {
            console.log(`   ❌ [LinkedInEnrich] ${companyLabel} — API returned no data${fromCache ? ' (cached)' : ''}`);
            continue;
        }
        if (!companyData.website) {
            console.log(`   ⚠️ [LinkedInEnrich] ${companyLabel} — no website on LinkedIn${fromCache ? ' (cached)' : ''}`);
            continue;
        }

        const domain = cleanDomain(companyData.website);
        if (!domain) continue;

        // Fill Website only — don't duplicate into Website_one/two
        rec.salesqlOrgWebsite = domain;

        // Fill employee count if empty
        if (!rec.salesqlOrgEmployees && companyData.employeeCount) {
            rec.salesqlOrgEmployees = String(companyData.employeeCount);
        }
        // Fill industry if empty
        if (!rec.industry && companyData.industry) {
            rec.industry = companyData.industry;
        }

        console.log(`   ✅ [LinkedInEnrich] ${companyLabel} → ${domain}${fromCache ? ' (cached)' : ''}`);
        enriched++;
    }

    console.log(`✅ [LinkedInEnrich] Enriched:${enriched} | Already had data:${skipped} | No companyId:${noId} | API calls:${companyCache.size}`);
    return records;
}

/**
 * Read JSONL, find records with empty Website, enrich via LinkedIn API,
 * write back to JSONL, regenerate CSV.
 *
 * Run ONCE at end of job after waitForAllEnrichments().
 *
 * @param {string}   leadsJsonl     - path to leads.jsonl
 * @param {string}   leadsCSV       - path to leads.csv
 * @param {Object}   page           - Playwright page object (still alive)
 * @param {Function} generateCSVFn  - generateCSV(jsonlPath, csvPath)
 * @param {Object}   [options]
 *   @param {number} delayMs - delay between API calls (default: 300ms)
 */
async function enrichFromJSONL(leadsJsonl, leadsCSV, page, generateCSVFn, options = {}) {
    const { delayMs = 300 } = options;

    if (!fs.existsSync(leadsJsonl)) {
        console.log('⚠️ [LinkedInEnrich] No JSONL file found — skipping');
        return;
    }

    const lines = fs.readFileSync(leadsJsonl, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
        console.log('⚠️ [LinkedInEnrich] JSONL is empty — skipping');
        return;
    }

    // Parse all records
    const records = [];
    for (const line of lines) {
        try { records.push(JSON.parse(line)); } catch { records.push(null); }
    }

    // Find records needing enrichment: has companyLinkedin but empty Website
    const needEnrich = records.filter(r =>
        r && !r.salesqlOrgWebsite && r.companyLinkedin
    );

    if (needEnrich.length === 0) {
        console.log('✅ [LinkedInEnrich] All records already have Website — nothing to enrich');
        return;
    }

    console.log(`🔗 [LinkedInEnrich] ${needEnrich.length}/${records.length} records need Website enrichment...`);

    // Enrich in-place (records array shares references with needEnrich)
    await enrichCompanyDomains(needEnrich, page, { delayMs });

    // Dedup: if LinkedIn filled Website with same domain as Website_one or Website_two, clear the duplicate
    for (const rec of needEnrich) {
        if (!rec.salesqlOrgWebsite) continue;
        const w = rec.salesqlOrgWebsite;
        if (rec.emailDomain === w)  rec.emailDomain  = '';
        if (rec.salesqlEmail === w) rec.salesqlEmail = '';
    }

    // Write back
    const updated = records.map(r => r ? JSON.stringify(r) : '').filter(Boolean);
    fs.writeFileSync(leadsJsonl, updated.join('\n') + '\n');

    // Regenerate CSV + XLSX
    await generateCSVFn(leadsJsonl, leadsCSV);
    console.log(`✅ [LinkedInEnrich] JSONL + CSV regenerated`);
}

module.exports = { enrichCompanyDomains, enrichFromJSONL };