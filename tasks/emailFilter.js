// ═══════════════════════════════════════════════════════════════════════════════
// 📧 UTIL: Business Email Domain Filter — v2.7.0
// ═══════════════════════════════════════════════════════════════════════════════
// Uses `free-email-domains` npm package to filter out personal/free email
// domains (gmail.com, yahoo.com, hotmail.com, etc.) and keep only
// business/corporate domains.
//
// Usage:
//   const { isBusinessDomain, filterBusinessDomains } = require('./emailFilter');
//   isBusinessDomain('company.com')     → true
//   isBusinessDomain('gmail.com')       → false
//   filterBusinessDomains(['company.com', 'gmail.com']) → ['company.com']
// ═══════════════════════════════════════════════════════════════════════════════

let freeDomainsSet;

try {
    const freeDomains = require('free-email-domains');
    freeDomainsSet = new Set(Array.isArray(freeDomains) ? freeDomains : []);
    console.log(`📧 [EmailFilter] Loaded ${freeDomainsSet.size} free email domains from npm`);
} catch {
    // Fallback: comprehensive list of common free/personal email providers
    console.log('📧 [EmailFilter] npm package unavailable — using built-in list');
    freeDomainsSet = new Set([
        // Google
        'gmail.com', 'googlemail.com', 'google.com',
        // Microsoft
        'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk',
        'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es',
        'outlook.co.uk', 'outlook.fr', 'outlook.de',
        // Yahoo
        'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.it',
        'yahoo.es', 'yahoo.ca', 'yahoo.com.au', 'yahoo.com.br',
        'yahoo.co.in', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com',
        // AOL / Verizon
        'aol.com', 'aol.co.uk', 'aim.com', 'verizon.net',
        // Apple
        'icloud.com', 'me.com', 'mac.com',
        // Proton
        'protonmail.com', 'proton.me', 'pm.me', 'protonmail.ch',
        // Zoho
        'zoho.com', 'zohomail.com',
        // Misc providers
        'mail.com', 'email.com', 'inbox.com', 'gmx.com', 'gmx.net',
        'gmx.de', 'gmx.at', 'gmx.ch', 'web.de', 'freenet.de',
        'mail.ru', 'yandex.com', 'yandex.ru', 'rambler.ru',
        'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
        'naver.com', 'daum.net', 'hanmail.net',
        'tutanota.com', 'tuta.io', 'fastmail.com', 'fastmail.fm',
        'hushmail.com', 'mailbox.org', 'posteo.de', 'startmail.com',
        'sbcglobal.net', 'att.net', 'bellsouth.net', 'comcast.net',
        'cox.net', 'charter.net', 'earthlink.net', 'juno.com',
        'netzero.com', 'optonline.net', 'roadrunner.com', 'frontier.com',
        'windstream.net', 'centurytel.net', 'embarqmail.com',
        'angelfire.com', 'lycos.com', 'excite.com',
        // Temp / disposable
        'guerrillamail.com', 'mailinator.com', 'tempmail.com', 'throwaway.email',
        'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
        'dispostable.com', 'yopmail.com', 'trashmail.com',
    ]);
}


/**
 * Check if a domain is a business (non-free/non-personal) email domain.
 * @param {string} domain - e.g. 'company.com'
 * @returns {boolean}
 */
function isBusinessDomain(domain) {
    if (!domain) return false;
    const d = domain.toLowerCase().trim();
    if (!d || !d.includes('.')) return false;
    return !freeDomainsSet.has(d);
}


/**
 * Filter an array of domains → keep only business domains.
 * @param {string[]} domains
 * @returns {string[]}
 */
function filterBusinessDomains(domains) {
    if (!Array.isArray(domains)) return [];
    return domains.filter(isBusinessDomain);
}


/**
 * From a list of ContactOut emails, extract the best business domain.
 * Prioritizes: high confidence → non-guessed → type 1 (work) over type 2 (personal)
 *
 * @param {Array} emails - ContactOut email objects with { value, confidence_level, is_guess, type }
 * @returns {string} best business domain or ''
 */
function extractBestBusinessDomain(emails) {
    if (!Array.isArray(emails) || emails.length === 0) return '';

    // Collect all business domains with their scoring
    const candidates = [];

    for (const email of emails) {
        const addr = (email.value || '').trim();
        if (!addr) continue;

        const atMatch = addr.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
        if (!atMatch) continue;

        const domain = atMatch[1].toLowerCase();
        if (!isBusinessDomain(domain)) continue;

        // Score: higher = better
        let score = 0;
        if (email.type === 1) score += 100;            // work email
        if (!email.is_guess) score += 50;               // verified, not guessed
        if (email.confidence_level === 'high') score += 25;
        if (email.display_priority === 0) score += 10;  // high display priority

        candidates.push({ domain, score });
    }

    if (candidates.length === 0) return '';

    // Sort by score descending, return best
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].domain;
}


module.exports = { isBusinessDomain, filterBusinessDomains, extractBestBusinessDomain };