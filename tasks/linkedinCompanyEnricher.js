// ═══════════════════════════════════════════════════════════════════════════════
// TASK: LinkedIn Company Domain Enricher — v1.0.0
// ═══════════════════════════════════════════════════════════════════════════════
// Uses LinkedIn Sales API via existing Playwright page session to fetch
// company website domain for records missing Website / Website_one.
//
// Integration: job-runner.js — after mergePageData(), before generateCSV()
//
//   const merged = mergePageData(pageData);
//   await enrichCompanyDomains(merged, page);         ← add this line
//   const totalLeads = await generateCSV(...);
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// Extract numeric company ID from companyLinkedin URL
// "https://www.linkedin.com/sales/company/2757798" → "2757798"
function extractCompanyId(companyLinkedin) {
    if (!companyLinkedin) return null;
    const m = companyLinkedin.match(/\/company\/(\d+)/);
    return m ? m[1] : null;
}

// Clean domain from full URL
function cleanDomain(url) {
    return (url || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split('/')[0]
        .split('?')[0]
        .trim()
        .toLowerCase();
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
 * Enrich merged records with company website from LinkedIn Sales API.
 *
 * @param {Array}  records        - merged records from mergePageData()
 * @param {Object} page           - Playwright page object
 * @param {Object} [options]
 *   @param {number}  delayMs       - delay between API calls (default: 300ms)
 *   @param {boolean} onlyIfMissing - only enrich records without website data (default: true)
 */
async function enrichCompanyDomains(records, page, options = {}) {
    const { delayMs = 300, onlyIfMissing = true } = options;

    if (!records || records.length === 0) return records;

    const companyCache = new Map(); // companyId → data | null
    let enriched = 0;
    let skipped  = 0;
    let noId     = 0;

    for (const rec of records) {
        // Skip if already has website data
        if (onlyIfMissing && (rec.salesqlOrgWebsite || rec.emailDomain || rec.salesqlEmail)) {
            skipped++;
            continue;
        }

        const companyId = extractCompanyId(rec.companyLinkedin);
        if (!companyId) { noId++; continue; }

        // Use cache to avoid duplicate API calls for same company
        if (!companyCache.has(companyId)) {
            const data = await fetchCompanyFromLinkedIn(page, companyId);
            companyCache.set(companyId, data);
            await new Promise(r => setTimeout(r, delayMs));
        }

        const companyData = companyCache.get(companyId);
        if (!companyData) continue;

        // Fill Website (salesqlOrgWebsite) if empty
        if (!rec.salesqlOrgWebsite && companyData.website) {
            rec.salesqlOrgWebsite = companyData.website;
        }
        // Fill Website_one (emailDomain) if empty — clean domain only
        if (!rec.emailDomain && companyData.website) {
            rec.emailDomain = cleanDomain(companyData.website);
        }
        // Fill employee count if empty
        if (!rec.salesqlOrgEmployees && companyData.employeeCount) {
            rec.salesqlOrgEmployees = String(companyData.employeeCount);
        }
        // Fill industry if empty
        if (!rec.industry && companyData.industry) {
            rec.industry = companyData.industry;
        }

        enriched++;
    }

    console.log(`✅ [CompanyEnricher] Enriched:${enriched} | Already had data:${skipped} | No companyId:${noId} | Unique API calls:${companyCache.size}`);
    return records;
}

module.exports = { enrichCompanyDomains };