// ═══════════════════════════════════════════════════════════════════════════════
// TASK: Merge Data — Sales Nav (BASE) + ContactOut + Lusha + SalesQL (v3.3.0)
// ═══════════════════════════════════════════════════════════════════════════════
//
// FLOW:
//   Sales Nav    → BASE: clean names, title, company, location, about, tenure
//   ContactOut   → ENRICH: business email domain → Website_one (+ LinkedIn URL fallback)
//   Lusha        → ENRICH: domain + personLinkedinUrl (Lusha OVERWRITES ContactOut domain)
//
// DOMAIN PRIORITY for Website_one:
//   ContactOut domain first → Lusha overwrites if it also has a domain
//   → Final priority: Lusha > ContactOut
//
// NAME MATCHING:
//   1. firstName match (unique → done; multiple → disambiguate by lastName)
//   2. lastName match  (unique → done; multiple → disambiguate by firstName)
//   3. fullName exact match (cleaned) — fallback
//
// CRITICAL: Only match page-to-page data. Never cross-page.
// ═══════════════════════════════════════════════════════════════════════════════

const { cleanName } = require('./nameCleaner');

// Strip protocol, www, and path — return bare domain: "https://www.company.com/path" → "company.com"
function cleanDomain(str) {
    return (str || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split('/')[0]
        .split('?')[0]
        .trim();
}

/**
 * @param {Object} pageData
 *   lusha:             [{ firstName, lastName, fullName, domain, personLinkedinUrl }]
 *   contactout:        [{ firstName, lastName, fullName, domain, personLinkedinUrl }]
 *   salesql:           [{ firstName, lastName, fullName, linkedinUrl, salesqlEmail, salesqlEmailDomain, salesqlPhone, orgEmployeeCount, orgFoundedYear, orgWebsite }]
 *   salesNavRecords:   [{ firstName, lastName, fullName, title, companyName, ... }]
 *   salesNavLocations: [{ name, location, personSalesUrl, companyLinkedin, ... }]
 */
function mergePageData(pageData) {
    const {
        lusha = [],
        contactout = [],
        salesql = [],
        salesNavRecords = [],
        salesNavLocations = [],
    } = pageData;

    if (salesNavRecords.length === 0) {
        console.log('⚠️ [Merge] No Sales Nav data — skipping');
        return [];
    }

    console.log(`🔗 [Merge] SN:${salesNavRecords.length} CO:${contactout.length} LU:${lusha.length} SQL:${salesql.length}`);

    const lushaMatched      = new Set();
    const contactoutMatched = new Set();
    const salesqlMatched    = new Set();
    const coEmailDomainSet  = new Set();

    const merged = salesNavRecords.map(sn => {
        const record = { ...sn };

        // ── Step 1: Match ContactOut → business email domain + LinkedIn URL ──
        const coMatch = matchContactOutRecord(record, contactout, contactoutMatched);
        if (coMatch.domain) {
            record.emailDomain = coMatch.domain;
            coEmailDomainSet.add(record.personSalesUrl || record.fullName);
        }
        if (coMatch.personLinkedinUrl && !record.personLinkedinUrl) {
            record.personLinkedinUrl = coMatch.personLinkedinUrl;
        }

        // ── Step 2: Match Lusha → domain overwrites ContactOut; LinkedIn URL ──
        const lushaMatch = matchLushaRecord(record, lusha, lushaMatched);
        if (lushaMatch.domain) {
            record.emailDomain = lushaMatch.domain;
        } else if (!record.emailDomain) {
            record.emailDomain = '';
        }

        // Set personLinkedinUrl — Lusha > ContactOut > Sales Nav conversion
        // Track if Lusha provided a real LinkedIn URL so SalesQL won't overwrite it
        if (record.personSalesUrl) {
            if (lushaMatch.personLinkedinUrl) {
                record.personLinkedinUrl = lushaMatch.personLinkedinUrl;
                record._lushaLinkedin = true;   // flag: Lusha gave us a real URL
            } else if (!record.personLinkedinUrl) {
                // Converted from Sales Nav — lower priority, SalesQL can replace
                record.personLinkedinUrl = record.personSalesUrl.replace('/sales/lead/', '/in/');
                record._lushaLinkedin = false;
            }
        }

        // ── Step 3: Match SalesQL → email, phone, LinkedIn, org data ───────────
        const sqlMatch = matchSalesQLRecord(record, salesql, salesqlMatched);

        // Pre-compute clean versions of all domains for dedup comparison
        const existingWebsiteOne = cleanDomain(record.emailDomain);
        const sqlEmailDomain     = cleanDomain(sqlMatch.salesqlEmailDomain || sqlMatch.salesqlEmail);
        const orgWebsiteDomain   = cleanDomain(sqlMatch.orgWebsite);

        // ── Website_one domain logic ──────────────────────────────────────────
        // Priority: Lusha > ContactOut > SalesQL email domain > SalesQL org website
        // SalesQL email domain fills Website_one only if currently empty
        if (!existingWebsiteOne && sqlEmailDomain) {
            record.emailDomain = sqlEmailDomain;
        }
        // SalesQL org website domain fills Website_one only if still empty
        if (!cleanDomain(record.emailDomain) && orgWebsiteDomain) {
            record.emailDomain = orgWebsiteDomain;
        }

        // ── SalesQL Email column — dedup rule ─────────────────────────────────
        // Don't fill SalesQL Email if its domain is already present in:
        //   - Website_one (emailDomain)     — would be a duplicate
        //   - SalesQL Org Website domain    — same source, redundant
        const finalWebsiteOne  = cleanDomain(record.emailDomain);
        const sqlEmailVal      = sqlMatch.salesqlEmail || '';
        const sqlEmailValClean = cleanDomain(sqlEmailVal);

        if (sqlEmailVal && sqlEmailValClean
            && sqlEmailValClean !== finalWebsiteOne
            && sqlEmailValClean !== orgWebsiteDomain) {
            // Domain is genuinely new info — show it
            record.salesqlEmail = sqlEmailVal;
        } else {
            // Domain already covered by Website_one or SalesQL Org Website — omit
            record.salesqlEmail = '';
        }

        // ── Website_one vs SalesQL Org Website dedup ─────────────────────────
        // If Website_one's clean domain equals the org website domain, they are the same.
        // Keep Website_one as the authoritative domain field (it's already correct).
        // No further action needed — SalesQL Org Website column still shows the full URL.

        // Phone
        record.salesqlPhone = sqlMatch.salesqlPhone || '';

        // LinkedIn URL priority:
        //   Lusha real URL     → never overwrite (_lushaLinkedin = true)
        //   Converted SalesNav → SalesQL can replace (better vanity URL)
        //   ContactOut URL     → SalesQL can replace (SalesQL is more accurate)
        if (sqlMatch.linkedinUrl) {
            if (!record._lushaLinkedin) {
                record.personLinkedinUrl = sqlMatch.linkedinUrl;
            }
            // If Lusha provided a real URL, keep it — SalesQL is secondary
        }

        // Organisation enrichment from primary_organization
        record.salesqlOrgEmployees = sqlMatch.orgEmployeeCount || '';
        record.salesqlOrgFounded   = sqlMatch.orgFoundedYear   || '';
        record.salesqlOrgWebsite   = sqlMatch.orgWebsite       || '';

        // Availability flags (for backwards compat with DOM-only data)
        record.salesqlHasEmail = (record.salesqlEmail || record.emailDomain) ? 'Yes' : '';
        record.salesqlHasPhone = record.salesqlPhone ? 'Yes' : '';

        return record;
    }).filter(r => r.personSalesUrl || r.personLinkedinUrl);

    // ── Stats ──────────────────────────────────────────────────────────────
    const domainHits   = merged.filter(r => r.emailDomain).length;
    const linkedHits   = merged.filter(r => r.personLinkedinUrl).length;
    const sqlEmailHits    = merged.filter(r => r.salesqlEmail || r.emailDomain).length;
    const sqlPhoneHits    = merged.filter(r => r.salesqlPhone).length;
    const sqlOrgHits      = merged.filter(r => r.salesqlOrgWebsite).length;

    console.log(`✅ [Merge] SalesNav base: ${salesNavRecords.length}`);
    console.log(`✅ [Merge] ContactOut matched: ${contactoutMatched.size}/${contactout.length}`);
    console.log(`✅ [Merge] Lusha matched: ${lushaMatched.size}/${lusha.length}`);
    console.log(`✅ [Merge] SalesQL matched: ${salesqlMatched.size}/${salesql.length} | emails:${sqlEmailHits} phones:${sqlPhoneHits} org-sites:${sqlOrgHits}`);
    console.log(`✅ [Merge] Website_one filled: ${domainHits}  LinkedIn URL: ${linkedHits}`);
    console.log(`✅ [Merge] Total records: ${merged.length}`);

    return merged;
}


// ═══════════════════════════════════════════════════════════════════════════════
// LUSHA MATCHING
// ═══════════════════════════════════════════════════════════════════════════════
function matchLushaRecord(record, lushaRecords, matchedSet) {
    const empty = { domain: '', personLinkedinUrl: '' };
    if (lushaRecords.length === 0) return empty;

    const recFirst = norm(record.firstName);
    const recLast  = norm(record.lastName);
    const recFull  = normFull(record.fullName);

    if (!recFirst && !recLast) return empty;

    if (recFirst) {
        const hits = [];
        for (let i = 0; i < lushaRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (norm(lushaRecords[i].firstName) === recFirst) hits.push(i);
        }
        if (hits.length === 1) { matchedSet.add(hits[0]); return extractLushaFields(lushaRecords[hits[0]]); }
        if (hits.length > 1 && recLast) {
            const refined = hits.filter(i => norm(lushaRecords[i].lastName) === recLast);
            if (refined.length === 1) { matchedSet.add(refined[0]); return extractLushaFields(lushaRecords[refined[0]]); }
        }
    }

    if (recLast) {
        const hits = [];
        for (let i = 0; i < lushaRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (norm(lushaRecords[i].lastName) === recLast) hits.push(i);
        }
        if (hits.length === 1) { matchedSet.add(hits[0]); return extractLushaFields(lushaRecords[hits[0]]); }
        if (hits.length > 1 && recFirst) {
            const refined = hits.filter(i => norm(lushaRecords[i].firstName) === recFirst);
            if (refined.length === 1) { matchedSet.add(refined[0]); return extractLushaFields(lushaRecords[refined[0]]); }
        }
    }

    if (recFull) {
        for (let i = 0; i < lushaRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (normFull(lushaRecords[i].fullName) === recFull) {
                matchedSet.add(i);
                return extractLushaFields(lushaRecords[i]);
            }
        }
    }

    return empty;
}

function extractLushaFields(record) {
    return {
        domain:            record.domain || '',
        personLinkedinUrl: record.personLinkedinUrl || '',
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONTACTOUT MATCHING
// ═══════════════════════════════════════════════════════════════════════════════
function matchContactOutRecord(record, contactoutRecords, matchedSet) {
    const empty = { domain: '', personLinkedinUrl: '' };
    if (contactoutRecords.length === 0) return empty;

    const recFirst = norm(record.firstName);
    const recLast  = norm(record.lastName);
    const recFull  = normFull(record.fullName);

    if (!recFirst && !recLast) return empty;

    if (recFirst) {
        const hits = [];
        for (let i = 0; i < contactoutRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (norm(contactoutRecords[i].firstName) === recFirst) hits.push(i);
        }
        if (hits.length === 1) { matchedSet.add(hits[0]); return extractContactOutFields(contactoutRecords[hits[0]]); }
        if (hits.length > 1 && recLast) {
            const refined = hits.filter(i => norm(contactoutRecords[i].lastName) === recLast);
            if (refined.length === 1) { matchedSet.add(refined[0]); return extractContactOutFields(contactoutRecords[refined[0]]); }
        }
    }

    if (recLast) {
        const hits = [];
        for (let i = 0; i < contactoutRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (norm(contactoutRecords[i].lastName) === recLast) hits.push(i);
        }
        if (hits.length === 1) { matchedSet.add(hits[0]); return extractContactOutFields(contactoutRecords[hits[0]]); }
        if (hits.length > 1 && recFirst) {
            const refined = hits.filter(i => norm(contactoutRecords[i].firstName) === recFirst);
            if (refined.length === 1) { matchedSet.add(refined[0]); return extractContactOutFields(contactoutRecords[refined[0]]); }
        }
    }

    if (recFull) {
        for (let i = 0; i < contactoutRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (normFull(contactoutRecords[i].fullName) === recFull) {
                matchedSet.add(i);
                return extractContactOutFields(contactoutRecords[i]);
            }
        }
    }

    return empty;
}

function extractContactOutFields(record) {
    return {
        domain:            record.domain || '',
        personLinkedinUrl: record.personLinkedinUrl || '',
    };
}


// ── Normalization helpers ──────────────────────────────────────────────────────
function norm(str) {
    return (str || '').trim().toLowerCase().replace(/[^a-z]/g, '');
}

function normFull(str) {
    const cleaned = cleanName(str || '');
    return cleaned.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}




// ═══════════════════════════════════════════════════════════════════════════════
// SALESQL MATCHING — v3.1.0
// ═══════════════════════════════════════════════════════════════════════════════
// Same name-matching strategy as Lusha/ContactOut.
// Returns { salesqlEmail, salesqlPhone, domain }.
// Domain is only used if Lusha and ContactOut both returned empty.
// ═══════════════════════════════════════════════════════════════════════════════
function matchSalesQLRecord(record, salesqlRecords, matchedSet) {
    const empty = { salesqlEmail: '', salesqlPhone: '', domain: '' };
    if (salesqlRecords.length === 0) return empty;

    const recFirst = norm(record.firstName);
    const recLast  = norm(record.lastName);
    const recFull  = normFull(record.fullName);

    if (!recFirst && !recLast) return empty;

    // Strategy 1: firstName match
    if (recFirst) {
        const hits = [];
        for (let i = 0; i < salesqlRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (norm(salesqlRecords[i].firstName) === recFirst) hits.push(i);
        }
        if (hits.length === 1) {
            matchedSet.add(hits[0]);
            return extractSalesQLFields(salesqlRecords[hits[0]]);
        }
        if (hits.length > 1 && recLast) {
            const refined = hits.filter(i => norm(salesqlRecords[i].lastName) === recLast);
            if (refined.length === 1) {
                matchedSet.add(refined[0]);
                return extractSalesQLFields(salesqlRecords[refined[0]]);
            }
        }
    }

    // Strategy 2: lastName match
    if (recLast) {
        const hits = [];
        for (let i = 0; i < salesqlRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (norm(salesqlRecords[i].lastName) === recLast) hits.push(i);
        }
        if (hits.length === 1) {
            matchedSet.add(hits[0]);
            return extractSalesQLFields(salesqlRecords[hits[0]]);
        }
        if (hits.length > 1 && recFirst) {
            const refined = hits.filter(i => norm(salesqlRecords[i].firstName) === recFirst);
            if (refined.length === 1) {
                matchedSet.add(refined[0]);
                return extractSalesQLFields(salesqlRecords[refined[0]]);
            }
        }
    }

    // Strategy 3: fullName match
    if (recFull) {
        for (let i = 0; i < salesqlRecords.length; i++) {
            if (matchedSet.has(i)) continue;
            if (normFull(salesqlRecords[i].fullName) === recFull) {
                matchedSet.add(i);
                return extractSalesQLFields(salesqlRecords[i]);
            }
        }
    }

    return empty;
}

function extractSalesQLFields(record) {
    return {
        salesqlEmail:       record.salesqlEmail       || '',
        salesqlEmailDomain: record.salesqlEmailDomain || record.domain || '',
        salesqlPhone:       record.salesqlPhone       || '',
        linkedinUrl:        record.linkedinUrl         || '',
        orgEmployeeCount:   record.orgEmployeeCount    || '',
        orgFoundedYear:     record.orgFoundedYear      || '',
        orgWebsite:         record.orgWebsite          || '',
        hasEmail:           record.hasEmail            || false,
        hasPhone:           record.hasPhone            || false,
    };
}

module.exports = { mergePageData };