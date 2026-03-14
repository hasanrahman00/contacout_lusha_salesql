// ═══════════════════════════════════════════════════════════════════════════════
// 🌐 Gemini Website Scraper — website-enricher/geminiScraper.js  v1.1.0
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { chromium } = require('playwright');

const GEMINI_URL       = 'https://gemini.google.com/app';
const CONNECT_TIMEOUT  = 15000;
const RESPONSE_TIMEOUT = 45000;
const SETTLE_MS        = 2000;

class GeminiScraper {
    constructor(cdpUrl = 'http://127.0.0.1:9224') {
        this.cdpUrl  = cdpUrl;
        this.browser = null;
        this.context = null;
        this.page    = null;
        this._ready  = false;
    }

    // ── Connect to Chrome on port 9224 ──────────────────────────────────────
    async connect() {
        try {
            this.browser  = await chromium.connectOverCDP(this.cdpUrl, { timeout: CONNECT_TIMEOUT });
            const contexts = this.browser.contexts();
            this.context  = contexts[0] || await this.browser.newContext();

            // Find existing Gemini tab or open one
            let geminiPage = null;
            for (const p of this.context.pages()) {
                if (p.url().includes('gemini.google.com')) { geminiPage = p; break; }
            }
            if (!geminiPage) {
                geminiPage = await this.context.newPage();
                await geminiPage.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
                // Wait for Gemini to fully load
                await geminiPage.waitForTimeout(3000);
            }

            this.page   = geminiPage;
            this._ready = true;
            console.log('✅ [GeminiScraper] Connected (port 9224)');
            return true;
        } catch (err) {
            console.log(`⚠️ [GeminiScraper] Connect failed: ${err.message}`);
            return false;
        }
    }

    // ── Count current model-response elements (snapshot before sending) ────────
    async _countResponses() {
        return await this.page.evaluate(() =>
            document.querySelectorAll('model-response').length
        ).catch(() => 0);
    }

    // ── Send query + wait for NEW response + return its text ─────────────────
    // Snapshots the response count BEFORE sending so we can detect exactly
    // which element is the new reply — avoids reading previous conversation turns.
    async _query(text) {
        const page = this.page;

        // 1. Snapshot response count before we send
        const countBefore = await this._countResponses();

        // 2. Wait for input area
        await page.waitForFunction(() => {
            const el = document.querySelector('rich-textarea div[contenteditable]')
                    || document.querySelector('div[contenteditable="true"]');
            return el && el.isConnected;
        }, { timeout: 15000 });

        // 3. Focus, clear, fill
        const inputLocator = page.locator('rich-textarea div[contenteditable]').first()
            .or(page.locator('div[contenteditable="true"]').first());
        await inputLocator.click();
        await page.waitForTimeout(150);
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(100);
        await inputLocator.fill(text);
        await page.waitForTimeout(200);

        // 4. Send
        const sent = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const sendBtn = btns.find(b => {
                const label = (b.getAttribute('aria-label') || '').toLowerCase();
                return label.includes('send')
                    || !!b.querySelector('mat-icon[data-mat-icon-name="send"]');
            });
            if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return true; }
            return false;
        });
        if (!sent) await page.keyboard.press('Enter');
        console.log(`   [Gemini] Query sent (responses before: ${countBefore})`);

        // 5. Wait for a NEW model-response element to appear (count increases)
        const deadline = Date.now() + RESPONSE_TIMEOUT;
        let newEl = null;
        while (Date.now() < deadline) {
            await page.waitForTimeout(400);
            const countNow = await this._countResponses();
            if (countNow > countBefore) {
                // New response appeared — now wait for streaming to finish
                const stillStreaming = await page.evaluate(() => {
                    return !!document.querySelector(
                        'button[aria-label*="Stop"], button[aria-label*="stop"], .stop-button'
                    );
                }).catch(() => false);
                if (!stillStreaming) break;
            }
        }

        // 6. Extra settle
        await page.waitForTimeout(SETTLE_MS);

        // 7. Read ONLY the newly added response (index = countBefore)
        const text_out = await page.evaluate((idx) => {
            const all = document.querySelectorAll('model-response');
            // Take every response from idx onwards (should be just one new one)
            const newOnes = Array.from(all).slice(idx);
            if (newOnes.length === 0) return '';
            const el = newOnes[newOnes.length - 1];
            // Prefer .markdown child for clean text
            const md = el.querySelector('.markdown, [class*="markdown"]');
            return ((md || el).innerText || (md || el).textContent || '').trim();
        }, countBefore);

        return text_out;
    }

    // ── Extract a bare domain from Gemini's text ────────────────────────────
    _parseDomain(text) {
        if (!text) return null;

        // Match bare domains and URLs
        const re = /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.(?:com|org|net|io|co|ai|app|tech|health|care|inc|biz|us|uk|ca|de|fr|au|info|edu|gov|co\.[a-z]{2}|[a-z]{2,4}))\b/gi;
        const matches = [...text.matchAll(re)];
        if (matches.length === 0) return null;

        // Prefer domains mentioned after "is", ":", "website", "domain", "at"
        for (const m of matches) {
            const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
            if (/website|domain|is\s*:?$|at\s*:?$|url|official|visit/.test(before)) {
                return this._strip(m[1] || m[0]);
            }
        }
        // Otherwise return first match
        return this._strip(matches[0][1] || matches[0][0]);
    }

    _strip(s) {
        return (s || '').trim().toLowerCase()
            .replace(/^https?:\/\//i, '').replace(/^www\./i, '')
            .split('/')[0].split('?')[0].trim();
    }

    // ── Save a debug screenshot ──────────────────────────────────────────────
    async _screenshot(debugDir, name) {
        if (!debugDir || !this.page) return;
        try {
            const fs   = require('fs');
            const path = require('path');
            fs.mkdirSync(debugDir, { recursive: true });
            await this.page.screenshot({
                path: path.join(debugDir, `${Date.now()}-${name}.png`),
                fullPage: false,
            });
        } catch {}
    }

    // ── PUBLIC: find official website domain for a company ──────────────────
    // ── PUBLIC: find domains for a BATCH of company names ──────────────────
    // Sends all companies in one Gemini message. Returns array of
    // { companyName, geminiDomain } — same order as input.
    async findWebsitesBatch(companyNames, debugDir = null) {
        if (!this._ready) throw new Error('Not connected');
        if (!companyNames.length) return [];

        // Build numbered list prompt — forces structured output Gemini can't turn into a search
        const numbered = companyNames.map((n, i) => `${i + 1}. ${n}`).join('\n');
        const query = `For each company below, reply with ONLY its official website domain (like company.com). Use this exact format for every line — number, dot, space, domain. If unknown write "unknown". Do not include http or www. Do not search. Do not explain.\n\n${numbered}`;

        console.log(`   🌐 [Gemini] Batch query: ${companyNames.length} companies`);
        const text = await this._query(query);
        await this._screenshot(debugDir, `batch-response`);
        console.log(`   🌐 [Gemini] Raw response (first 200 chars): "${text.slice(0, 200)}"`);

        // Split response into lines for parsing
        const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

        // Parse each result — try numbered format first, then fallback strategies
        const results = companyNames.map((name, i) => {
            const n = i + 1;

            // Strategy A: "N. domain.com" or "N) domain.com"
            const numberedRe = new RegExp(`^${n}[.)\s]+(.+)$`, 'i');
            let raw = null;
            for (const line of lines) {
                const m = line.match(numberedRe);
                if (m) { raw = m[1].trim(); break; }
            }

            // Strategy B: single-item response with no number — use the whole response text
            if (!raw && companyNames.length === 1) {
                // Take first line that looks like a domain (no spaces, has a dot)
                for (const line of lines) {
                    const stripped = this._strip(line);
                    if (stripped && stripped.includes('.') && !stripped.includes(' ')) {
                        raw = stripped;
                        break;
                    }
                }
            }

            // Strategy C: find the Nth non-empty line (Gemini sometimes omits numbers)
            if (!raw && lines.length >= n) {
                const candidate = lines[i];
                // Strip any leading "N." prefix if present, otherwise use as-is
                raw = candidate.replace(/^\d+[.)\s]+/, '').trim();
            }

            if (!raw || raw.toLowerCase() === 'unknown' || raw.toLowerCase().includes('not available')) {
                return { companyName: name, geminiDomain: null };
            }

            let domain = this._strip(raw);

            // When Gemini doesn't know the domain it returns a Google search URL
            // like "https://www.google.com/search?q=cdillc.com"
            // Extract the q= parameter as a candidate domain — DeepSeek will validate it.
            if (domain === 'google.com' || raw.toLowerCase().includes('google.com/search')) {
                try {
                    const qMatch = raw.match(/[?&]q=([^&\s]+)/i);
                    if (qMatch) {
                        const candidate = this._strip(decodeURIComponent(qMatch[1]));
                        // Only use if it looks like a real domain (has a dot, no spaces)
                        if (candidate && candidate.includes('.') && !candidate.includes(' ')
                            && !candidate.includes('google')) {
                            domain = candidate;
                        } else {
                            return { companyName: name, geminiDomain: null };
                        }
                    } else {
                        return { companyName: name, geminiDomain: null };
                    }
                } catch {
                    return { companyName: name, geminiDomain: null };
                }
            }

            if (!domain) return { companyName: name, geminiDomain: null };

            return { companyName: name, geminiDomain: domain };
        });

        const found = results.filter(r => r.geminiDomain).length;
        console.log(`   🌐 [Gemini] Batch result: ${found}/${companyNames.length} domains found`);
        results.forEach(r => console.log(`      ${r.companyName} → ${r.geminiDomain || 'not found'}`));
        return results;
    }

    // ── PUBLIC: find domain for a single company (used only by selfTest) ────
    async findWebsite(companyName, debugDir = null) {
        if (!this._ready) throw new Error('Not connected');

        // Use numbered format even for single — prevents Gemini returning a Google search URL
        const results = await this.findWebsitesBatch([companyName], debugDir);
        return results[0]?.geminiDomain || null;
    }

    // ── PUBLIC: self-test — query Gemini directly, verify it responds ─────────
    // Uses a raw _query call (not findWebsitesBatch) to avoid the number-format
    // parser failing when Gemini omits the "1." prefix on single-item responses.
    async selfTest(debugDir = null) {
        try {
            console.log('   🧪 [Gemini] Self-test: asking about "Microsoft"...');
            const text = await this._query(
                'What is the official website domain of Microsoft? Reply with ONLY the bare domain like microsoft.com — nothing else, no http, no www.'
            );
            console.log(`   🧪 [Gemini] Raw reply: "${text.slice(0, 80)}"`);
            const domain = this._strip(text.split(/\n/)[0]);
            const ok = !!domain && domain.includes('microsoft') && !domain.includes('google');
            if (ok) console.log(`   🧪 [Gemini] Self-test passed: ${domain}`);
            return { ok, domain };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    async close() {
        try { if (this.browser) await this.browser.close(); } catch {}
        this._ready = false;
    }
}

module.exports = { GeminiScraper };