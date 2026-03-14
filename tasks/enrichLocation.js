// ═══════════════════════════════════════════════════════════════════════════════
// TASK: Enrich Missing Location Data from Sales Nav
// ═══════════════════════════════════════════════════════════════════════════════
// Fills person and company location fields from Sales Nav geoRegion data:
//
// GROUP 1 — Person location (city/state/country) from geoRegion
//   3 parts → city, state, country
//   2 parts → check countries.js: match → state+country, no match → city+state
//   1 part  → check countries.js: match → country, no match → city
//
// GROUP 2 — Company location (companyFullAddress + split fields) from
//   currentPositions[0].companyUrnResolutionResult.location  (companyLocationRaw)
//   Same parsing rules applied to company location columns.
//   Only fills when ALL of companyFullAddress/companyCity/companyState/
//   companyCountry are empty — never overwrites existing data.
//
// Also fills personSalesUrl + companyLinkedin (from v2.3.0)
// ═══════════════════════════════════════════════════════════════════════════════

const { cleanName } = require('./nameCleaner');
const { isCountry } = require('./countries');

/**
 * Parse a raw location string into { city, state, country }.
 * Rules per the spec:
 *   3 parts            → city, state, country
 *   2 parts, p2=country → state, country  (no city)
 *   2 parts, p2≠country → city, state     (no country)
 *   1 part,  =country   → country
 *   1 part,  ≠country   → city
 */
function parseLocation(locationRaw) {
    if (!locationRaw) return { city: '', state: '', country: '' };

    const parts = locationRaw.split(',').map(p => p.trim()).filter(Boolean);

    if (parts.length >= 3) {
        return { city: parts[0], state: parts[1], country: parts[2] };
    }
    if (parts.length === 2) {
        if (isCountry(parts[1])) return { city: '', state: parts[0], country: parts[1] };
        return { city: parts[0], state: parts[1], country: '' };
    }
    if (parts.length === 1) {
        if (isCountry(parts[0])) return { city: '', state: '', country: parts[0] };
        return { city: parts[0], state: '', country: '' };
    }
    return { city: '', state: '', country: '' };
}

/**
 * Build a lookup map from Sales Nav locations, keyed by cleaned name.
 */
function buildLocationMap(salesNavLocations) {
    const map = new Map();
    for (const entry of salesNavLocations) {
        const key = (entry.name || '').toLowerCase();
        if (!key) continue;
        if (map.has(key)) continue;
        const parsed = parseLocation(entry.location);
        // Also parse the company location (new in v2.3.1)
        const compLoc = parseLocation(entry.companyLocationRaw || '');
        map.set(key, {
            // person location
            city:    parsed.city,
            state:   parsed.state,
            country: parsed.country,
            // URLs
            personSalesUrl:  entry.personSalesUrl  || '',
            companyLinkedin: entry.companyLinkedin || '',
            // company location (raw string + parsed parts)
            companyLocationRaw: entry.companyLocationRaw || '',
            companyCity:    compLoc.city,
            companyState:   compLoc.state,
            companyCountry: compLoc.country,
        });
    }
    return map;
}

/**
 * Check if ALL company location fields on a record are empty.
 */
function hasNoCompanyLocation(record) {
    return !record.companyFullAddress && !record.companyCity &&
           !record.companyState && !record.companyCountry && !record.companyStreet;
}

/**
 * Enrich merged records with Sales Nav data.
 * Only fills blank fields — never overwrites existing values.
 */
function enrichLocations(merged, salesNavLocations) {
    if (!salesNavLocations || salesNavLocations.length === 0) return merged;

    const locMap = buildLocationMap(salesNavLocations);
    let enriched = 0;

    for (const record of merged) {
        const hasCity      = !!(record.city    && record.city.trim());
        const hasState     = !!(record.state   && record.state.trim());
        const hasCountry   = !!(record.country && record.country.trim());
        const hasSalesUrl  = !!(record.personSalesUrl  && record.personSalesUrl.trim());
        const hasCompanyLI = !!(record.companyLinkedin && record.companyLinkedin.trim());
        const noCompanyLoc = hasNoCompanyLocation(record);

        // Nothing to fill — skip
        if (hasCity && hasState && hasCountry && hasSalesUrl && hasCompanyLI && !noCompanyLoc) continue;

        const cleaned = cleanName(record.fullName || '');
        if (!cleaned) continue;
        const loc = locMap.get(cleaned.toLowerCase());
        if (!loc) continue;

        let changed = false;

        // ── Person location ──────────────────────────────────────────────
        if (!hasCity    && loc.city)    { record.city    = loc.city;    changed = true; }
        if (!hasState   && loc.state)   { record.state   = loc.state;   changed = true; }
        if (!hasCountry && loc.country) { record.country = loc.country; changed = true; }

        // ── Sales Nav URLs ────────────────────────────────────────────────
        if (!hasSalesUrl  && loc.personSalesUrl)  { record.personSalesUrl  = loc.personSalesUrl;  changed = true; }
        if (!hasCompanyLI && loc.companyLinkedin) { record.companyLinkedin = loc.companyLinkedin; changed = true; }

        // ── Company location — only fill when ALL company location cols empty ──
        if (noCompanyLoc && loc.companyLocationRaw) {
            record.companyFullAddress = loc.companyLocationRaw;
            if (loc.companyCity)    record.companyCity    = loc.companyCity;
            if (loc.companyState)   record.companyState   = loc.companyState;
            if (loc.companyCountry) record.companyCountry = loc.companyCountry;
            changed = true;
        }

        if (changed) enriched++;
    }

    if (enriched > 0) {
        console.log(`✅ [Location] Enriched ${enriched}/${merged.length} records from Sales Nav`);
    } else {
        console.log('ℹ️ [Location] No gaps filled');
    }

    return merged;
}

module.exports = { enrichLocations, parseLocation, buildLocationMap };
