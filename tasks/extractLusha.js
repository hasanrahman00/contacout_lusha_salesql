// ═══════════════════════════════════════════════════════════════════════════════
// 🔵 TASK: Extract Lusha Contacts from Sidebar DOM (with retry)
// ═══════════════════════════════════════════════════════════════════════════════
// RETRY: If 0 contacts, re-clicks Lusha badge and retries (up to 3x).
// ═══════════════════════════════════════════════════════════════════════════════

const { cleanName } = require('./nameCleaner');
const { activateLusha, minimizeLusha } = require('./activateLusha');

function splitName(fullName) {
    const cleaned = cleanName(fullName || '');
    if (!cleaned) return { firstName: '', lastName: '' };
    const parts = cleaned.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function extractDomains(text) {
    if (!text) return [];
    const matches = String(text).match(/@([a-z0-9.-]+\.[a-z]{2,})/gi) || [];
    return Array.from(new Set(matches.map(m => m.replace(/^@/, '').toLowerCase())));
}

async function getLushaFrame(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const url = frame.url();
            const name = frame.name();
            if (url.includes('LU__extension_iframe') || name === 'LU__extension_iframe' || url.includes('lusha.com')) {
                return frame;
            }
        } catch {}
    }
    try {
        const el = await page.$('iframe#LU__extension_iframe');
        if (el) { const frame = await el.contentFrame(); if (frame) return frame; }
    } catch {}
    return null;
}

async function expandAllCards(frame) {
    try {
        await frame.evaluate(() => {
            const arrows = Array.from(document.querySelectorAll(
                '.divider-and-arrow-container img[alt="Arrow Down"], .divider-and-arrow-container'
            ));
            arrows.forEach(el => {
                const clickable = el.closest('.divider-and-arrow-container') || el;
                if (clickable) clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
        });
    } catch {}
}

/**
 * Single extraction attempt from Lusha iframe.
 * Returns null if frame not found, [] if frame found but no data.
 */
async function extractFromFrame(page, maxCards) {
    const lushaFrame = await getLushaFrame(page);
    if (!lushaFrame) return null;

    const containerSelectors = [
        "[data-test-id='bulk-contact-container-with-data']",
        '.bulk-contact-profile-container',
    ];
    let hasContainer = false;
    for (const sel of containerSelectors) {
        try {
            const count = await lushaFrame.evaluate(s => document.querySelectorAll(s).length, sel);
            if (count > 0) { hasContainer = true; break; }
        } catch {}
    }
    if (!hasContainer) return [];

    await expandAllCards(lushaFrame);
    await page.waitForTimeout(200);

    return lushaFrame.evaluate((max) => {
        const cards = Array.from(document.querySelectorAll('.bulk-contact-profile-container'));
        return cards.slice(0, max).map(card => {
            const fullNameEl = card.querySelector('.bulk-contact-full-name');
            const companyEl = card.querySelector('.bulk-contact-company-name');
            const fullName = fullNameEl ? fullNameEl.textContent.trim() : '';
            const companyName = companyEl ? companyEl.textContent.trim() : '';
            const spans = Array.from(card.querySelectorAll('.bulk-contact-value-text .user-base.overflow-span'));
            const domainTexts = spans.map(s => (s.textContent || '').trim()).filter(Boolean);
            return { fullName, companyName, domainTexts };
        });
    }, maxCards).catch(() => []);
}

function processContacts(rawRecords) {
    const contacts = [];
    const seen = new Set();
    for (const record of rawRecords) {
        const cleanedName = cleanName(record.fullName || '');
        if (!cleanedName) continue;
        const key = cleanedName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const { firstName, lastName } = splitName(record.fullName);
        const domains = [];
        for (const text of record.domainTexts || []) {
            for (const d of extractDomains(text)) { if (!domains.includes(d)) domains.push(d); }
        }
        contacts.push({ fullName: cleanedName, firstName, lastName, domain: domains[0] || '', companyName: record.companyName || '' });
    }
    return contacts;
}

/**
 * Extract Lusha contacts with retry (up to 3 attempts).
 * On failure: minimize → re-click badge → wait → re-extract.
 */
async function extractLushaContacts(page, options = {}) {
    const maxWaitSec = options.maxWaitSec || 5;
    const maxCards = options.maxCards || 25;
    const maxRetries = options.maxRetries || 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`🔵 [Lusha] Extraction attempt ${attempt}/${maxRetries}...`);

        let raw = null;
        for (let waited = 0; waited < maxWaitSec; waited++) {
            raw = await extractFromFrame(page, maxCards);
            if (raw === null) { await page.waitForTimeout(1000); continue; }
            if (raw.length > 0) break;
            await page.waitForTimeout(1000);
        }

        if (raw && raw.length > 0) {
            const contacts = processContacts(raw);
            const withDomain = contacts.filter(c => c.domain);
            console.log(`✅ [Lusha] Extracted ${contacts.length} contacts (${withDomain.length} with domains) — attempt ${attempt}`);
            return contacts;
        }

        if (attempt < maxRetries) {
            console.log(`⚠️ [Lusha] 0 contacts — re-activating badge (attempt ${attempt}/${maxRetries})...`);
            await minimizeLusha(page);
            await page.waitForTimeout(500);
            await activateLusha(page);
            await page.waitForTimeout(1500);
        }
    }

    console.log('⚠️ [Lusha] 0 contacts after all retries');
    return [];
}

module.exports = { extractLushaContacts, getLushaFrame, splitName, extractDomains };
