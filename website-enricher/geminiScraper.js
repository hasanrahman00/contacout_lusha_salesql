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

    // ── Clear input and type query ───────────────────────────────────────────
    async _sendQuery(text) {
        const page = this.page;

        // Gemini uses a rich-textarea with a div[contenteditable] inside
        // Wait for the input area to be ready
        await page.waitForFunction(() => {
            const el = document.querySelector('rich-textarea div[contenteditable]')
                    || document.querySelector('div[contenteditable="true"]');
            return el && el.isConnected;
        }, { timeout: 15000 });

        // Click the input to focus
        const inputLocator = page.locator('rich-textarea div[contenteditable]').first()
            .or(page.locator('div[contenteditable="true"]').first());

        await inputLocator.click();
        await page.waitForTimeout(200);

        // Select all + delete to clear
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150);

        // Type the query
        await inputLocator.fill(text);
        await page.waitForTimeout(300);

        // Send: try button first, then Enter
        const sent = await page.evaluate(() => {
            // Look for send / submit button
            const btns = Array.from(document.querySelectorAll('button'));
            const sendBtn = btns.find(b => {
                const label = (b.getAttribute('aria-label') || '').toLowerCase();
                const title = (b.getAttribute('title') || '').toLowerCase();
                return label.includes('send') || title.includes('send')
                    || b.querySelector('mat-icon[data-mat-icon-name="send"]')
                    || b.querySelector('svg[data-icon="send"]');
            });
            if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                return true;
            }
            return false;
        });

        if (!sent) await page.keyboard.press('Enter');
        console.log(`   [Gemini] Query sent`);
    }

    // ── Wait for Gemini to finish generating ────────────────────────────────
    async _waitForResponse() {
        const page  = this.page;
        const start = Date.now();

        // Wait for a response container to appear
        try {
            await page.waitForSelector(
                'model-response, .response-container, .model-response, [data-response-index]',
                { state: 'attached', timeout: 10000 }
            );
        } catch { /* may already be present */ }

        // Poll until the "stop generating" button disappears (streaming done)
        const deadline = start + RESPONSE_TIMEOUT;
        while (Date.now() < deadline) {
            await page.waitForTimeout(500);
            const isGenerating = await page.evaluate(() => {
                // Gemini shows a "stop" button while streaming
                const stopBtn = document.querySelector(
                    'button[aria-label*="Stop"], button[aria-label*="stop"], ' +
                    '.stop-button, [data-test-id="stop-button"]'
                );
                return !!stopBtn;
            });
            if (!isGenerating) break;
        }

        // Extra settle time
        await page.waitForTimeout(SETTLE_MS);
    }

    // ── Extract the last response text ──────────────────────────────────────
    async _extractResponse() {
        return await this.page.evaluate(() => {
            const candidates = [
                ...document.querySelectorAll('model-response .markdown'),
                ...document.querySelectorAll('model-response'),
                ...document.querySelectorAll('.response-container-content'),
                ...document.querySelectorAll('.model-response-text'),
                ...document.querySelectorAll('message-content'),
            ];
            if (candidates.length === 0) return '';
            const last = candidates[candidates.length - 1];
            return (last.innerText || last.textContent || '').trim();
        });
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
    async findWebsite(companyName, debugDir = null) {
        if (!this._ready) throw new Error('Not connected');

        const query = `What is the official website domain of the company "${companyName}"? Reply with only the bare domain like example.com — nothing else.`;

        console.log(`   🌐 [Gemini] Asking about: "${companyName}"`);
        await this._sendQuery(query);
        await this._waitForResponse();
        await this._screenshot(debugDir, `response-${companyName.replace(/[^a-z0-9]/gi,'_').slice(0,30)}`);
        const text   = await this._extractResponse();
        const domain = this._parseDomain(text);
        console.log(`   🌐 [Gemini] Response: "${text.slice(0,80)}" → ${domain || 'not found'}`);
        return domain;
    }

    // ── PUBLIC: self-test — ask about Google, expect google.com ─────────────
    async selfTest(debugDir = null) {
        try {
            console.log('   🧪 [Gemini] Self-test: asking about "Google"...');
            const domain = await this.findWebsite('Google', debugDir);
            const ok = domain && (domain.includes('google.') || domain === 'google.com');
            return { ok: !!ok, domain };
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