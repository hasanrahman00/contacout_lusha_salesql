// ═══════════════════════════════════════════════════════════════════════════════
// 🌐 Gemini Website Scraper — website-enricher/geminiScraper.js
// ═══════════════════════════════════════════════════════════════════════════════
//
// Connects to a dedicated Chrome instance (port 9224, user-data-dir C:\website_enricher)
// and uses Gemini to find the official website for a company name.
//
// USAGE:
//   const { GeminiScraper } = require('./geminiScraper');
//   const g = new GeminiScraper(cdpUrl);
//   await g.connect();
//   const domain = await g.findWebsite('Tonal');
//   await g.close();
//
// FLOW per query:
//   1. Navigate to Gemini (reuse existing tab)
//   2. Clear the input and type: "What is the official website domain of [Company]? Reply with only the domain like company.com"
//   3. Submit and wait for response to stop streaming
//   4. Extract the first domain pattern from the response text
//   5. Return bare domain (stripped of http/www/path)
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const { chromium } = require('playwright');

const GEMINI_URL   = 'https://gemini.google.com/app';
const CONNECT_TIMEOUT = 15000;
const RESPONSE_TIMEOUT = 30000;
const STREAM_SETTLE_MS = 2500;   // wait after stream stops to confirm it's done

// DOM selectors for Gemini chat interface
const INPUT_SEL    = 'rich-textarea[data-placeholder] p, .ql-editor p, [contenteditable="true"] p';
const SUBMIT_SEL   = 'button[aria-label*="Send"], button.send-button, mat-icon[data-mat-icon-name="send"]';
const RESPONSE_SEL = '.response-container-content, model-response .markdown, .response-text';
const LOADING_SEL  = '.loading-indicator, [aria-label*="Gemini is thinking"], .thinking-indicator';

class GeminiScraper {
    constructor(cdpUrl = 'http://127.0.0.1:9224') {
        this.cdpUrl  = cdpUrl;
        this.browser = null;
        this.context = null;
        this.page    = null;
        this._ready  = false;
    }

    // ── Connect to the dedicated Chrome instance ────────────────────────────
    async connect() {
        try {
            this.browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: CONNECT_TIMEOUT });
            const contexts = this.browser.contexts();
            this.context  = contexts[0] || await this.browser.newContext();

            // Find or create the Gemini tab
            let geminiPage = null;
            for (const p of this.context.pages()) {
                if (p.url().includes('gemini.google.com')) { geminiPage = p; break; }
            }
            if (!geminiPage) {
                geminiPage = await this.context.newPage();
                await geminiPage.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
            }

            this.page   = geminiPage;
            this._ready = true;
            console.log('✅ [GeminiScraper] Connected to Chrome port 9224');
            return true;
        } catch (err) {
            console.log(`⚠️ [GeminiScraper] Connect failed: ${err.message}`);
            this._ready = false;
            return false;
        }
    }

    // ── Type into Gemini input and submit ───────────────────────────────────
    async _sendQuery(text) {
        const page = this.page;

        // Wait for input to be ready
        await page.waitForSelector('rich-textarea, .ql-editor, [contenteditable="true"]', { timeout: 10000 });

        // Click the input area
        const inputEl = await page.$('rich-textarea .ql-editor, .ql-editor, [data-placeholder] [contenteditable]')
            || await page.$('[contenteditable="true"]');

        if (!inputEl) throw new Error('Gemini input not found');

        await inputEl.click();
        await page.waitForTimeout(300);

        // Clear any existing text
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        // Type the query
        await page.keyboard.type(text, { delay: 20 });
        await page.waitForTimeout(400);

        // Submit
        const submitted = await page.evaluate(() => {
            // Try clicking send button
            const sendBtn = document.querySelector('button[aria-label*="Send"], .send-button button, button.send')
                || Array.from(document.querySelectorAll('button')).find(b =>
                    b.getAttribute('aria-label')?.toLowerCase().includes('send') ||
                    b.querySelector('mat-icon[data-mat-icon-name="send"]')
                );
            if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return true; }
            return false;
        });

        if (!submitted) {
            // Fallback: Enter key
            await page.keyboard.press('Enter');
        }
    }

    // ── Wait for Gemini to finish streaming a response ──────────────────────
    async _waitForResponse() {
        const page = this.page;
        const start = Date.now();

        // Wait for loading indicator to appear then disappear
        try {
            await page.waitForSelector(
                '.loading-indicator, [data-test-id="loading"], .thinking-indicator, mat-progress-bar',
                { state: 'attached', timeout: 8000 }
            );
        } catch { /* loading indicator may not appear for fast responses */ }

        // Wait for it to go away
        try {
            await page.waitForSelector(
                '.loading-indicator, [data-test-id="loading"], .thinking-indicator, mat-progress-bar',
                { state: 'detached', timeout: RESPONSE_TIMEOUT }
            );
        } catch { /* timeout — proceed anyway */ }

        // Extra settle time to ensure streaming has fully stopped
        await page.waitForTimeout(STREAM_SETTLE_MS);

        if (Date.now() - start > RESPONSE_TIMEOUT) {
            throw new Error('Gemini response timeout');
        }
    }

    // ── Extract text of the most recent response ────────────────────────────
    async _extractResponse() {
        const page = this.page;

        const text = await page.evaluate(() => {
            // Get all response containers and take the last one
            const responses = document.querySelectorAll(
                '.response-container-content, model-response .markdown, ' +
                '.model-response-text, .response-text, message-content'
            );
            if (responses.length === 0) return '';
            const last = responses[responses.length - 1];
            return (last.textContent || last.innerText || '').trim();
        });

        return text;
    }

    // ── Parse a domain out of Gemini's response text ────────────────────────
    _parseDomain(text) {
        if (!text) return null;

        // Look for explicit domain patterns: word.tld (optionally with www/https)
        const patterns = [
            /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|org|net|io|co|ai|app|tech|health|care|inc|biz|us|uk|ca|de|fr|au|info|edu|gov|co\.[a-z]{2}))\b/gi,
        ];

        for (const re of patterns) {
            const matches = [...text.matchAll(re)];
            if (matches.length > 0) {
                // Prefer the first match after "website", "domain", "is", "at"
                for (const m of matches) {
                    const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
                    if (/website|domain|is\s*:?|at\s*:?|url|official/.test(before)) {
                        return this._stripDomain(m[1] || m[0]);
                    }
                }
                return this._stripDomain(matches[0][1] || matches[0][0]);
            }
        }

        return null;
    }

    _stripDomain(str) {
        return (str || '').trim().toLowerCase()
            .replace(/^https?:\/\//i, '').replace(/^www\./i, '')
            .split('/')[0].split('?')[0].trim();
    }

    // ── PUBLIC: find official website for a company name ───────────────────
    async findWebsite(companyName) {
        if (!this._ready || !this.page) throw new Error('Not connected');

        const query = `What is the official website domain of "${companyName}"? Reply with only the bare domain like company.com — no explanation, no http, no www.`;

        await this._sendQuery(query);
        await this._waitForResponse();
        const responseText = await this._extractResponse();
        const domain = this._parseDomain(responseText);

        return domain;
    }

    // ── Clean disconnect ─────────────────────────────────────────────────────
    async close() {
        try { if (this.browser) await this.browser.close(); } catch {}
        this._ready = false;
    }
}

module.exports = { GeminiScraper };