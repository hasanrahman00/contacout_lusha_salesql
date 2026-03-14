// ═══════════════════════════════════════════════════════════════════════════════
// 📋 PAGE TRACKER — Zero-skip page accounting
// ═══════════════════════════════════════════════════════════════════════════════
// Tracks every page through its lifecycle:
//   started → extracted → merged → saved → navigated
//
// Detects:
//   - Pages entered but never saved (data loss)
//   - Page number jumps (skipped pages)
//   - Double-navigation (same page processed twice)
//
// Used by job-runner to verify every page is accounted for.
// Written to pageTracker.json in the job dir for post-run inspection.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');

class PageTracker {
    /**
     * @param {string} jobDir - Job output directory (where pageTracker.json is written)
     */
    constructor(jobDir) {
        this.jobDir  = jobDir;
        this.logFile = path.join(jobDir, 'pageTracker.json');
        this.pages   = {};          // pageNum → entry
        this.lastSaved = 0;         // last page number confirmed saved
        this.lastNavigated = 0;     // last page number navigation was called for
    }

    // ── Called at start of each page loop iteration ───────────────────────────
    pageStarted(pageNum) {
        if (this.pages[pageNum]) {
            console.log(`⚠️ [PageTracker] Page ${pageNum} started AGAIN — possible double-process`);
        }
        this.pages[pageNum] = {
            pageNum,
            startedAt:   Date.now(),
            extractedAt: null,
            mergedAt:    null,
            savedAt:     null,
            leadsCount:  0,
            skipped:     false,
            notes:       [],
        };
        this._checkJump(pageNum);
        this._flush();
    }

    // ── Called when DOM extraction completes ─────────────────────────────────
    pageExtracted(pageNum, counts) {
        const e = this.pages[pageNum];
        if (!e) { this._warn(pageNum, 'extracted without start'); return; }
        e.extractedAt = Date.now();
        e.extractCounts = counts; // { zi, lusha, sh }
        this._flush();
    }

    // ── Called when merge completes ───────────────────────────────────────────
    pageMerged(pageNum, leadsCount) {
        const e = this.pages[pageNum];
        if (!e) { this._warn(pageNum, 'merged without start'); return; }
        e.mergedAt   = Date.now();
        e.leadsCount = leadsCount;
        if (leadsCount === 0) e.notes.push('merge returned 0 leads');
        this._flush();
    }

    // ── Called when JSONL append + CSV write completes ────────────────────────
    pageSaved(pageNum, totalLeads) {
        const e = this.pages[pageNum];
        if (!e) { this._warn(pageNum, 'saved without start'); return; }
        e.savedAt    = Date.now();
        e.totalLeads = totalLeads;
        this.lastSaved = pageNum;
        this._flush();
    }

    // ── Called when navigation to next page starts ────────────────────────────
    // Returns true if safe to navigate, false if current page wasn't saved
    pageNavigating(pageNum) {
        const e = this.pages[pageNum];
        if (!e || !e.savedAt) {
            console.log(`❌ [PageTracker] Navigating away from page ${pageNum} but it was NEVER SAVED — data loss!`);
            if (e) e.notes.push('navigated without save — DATA LOSS');
            this._flush();
            return false; // caller can decide to abort or continue
        }
        this.lastNavigated = pageNum;
        return true;
    }

    // ── Called when navigation confirms new page number ───────────────────────
    pageNavigated(fromPage, toPage) {
        const expected = fromPage + 1;
        if (toPage !== expected) {
            console.log(`⚠️ [PageTracker] Expected page ${expected}, landed on ${toPage} — possible skip`);
            // Mark the missing pages as skipped
            for (let p = expected; p < toPage; p++) {
                if (!this.pages[p]) {
                    this.pages[p] = {
                        pageNum: p, startedAt: null, savedAt: null,
                        skipped: true, notes: ['skipped — navigation jumped over this page'],
                    };
                }
            }
        }
        this._flush();
    }

    // ── Mark a page as explicitly skipped ─────────────
    pageSkipped(pageNum, reason) {
        const e = this.pages[pageNum];
        if (e) {
            e.skipped = true;
            e.notes.push(`skipped: ${reason}`);
        }
        console.log(`⚠️ [PageTracker] Page ${pageNum} SKIPPED — ${reason}`);
        this._flush();
    }

    // ── Add a note to current page ────────────────────────────────────────────
    note(pageNum, msg) {
        const e = this.pages[pageNum];
        if (e) e.notes.push(msg);
    }

    // ── Summary at end of run ─────────────────────────────────────────────────
    summary() {
        const entries  = Object.values(this.pages).sort((a, b) => a.pageNum - b.pageNum);
        const total    = entries.length;
        const saved    = entries.filter(e => e.savedAt).length;
        const skipped  = entries.filter(e => e.skipped).length;
        const noLeads  = entries.filter(e => e.savedAt && e.leadsCount === 0).length;

        console.log('');
        console.log('📋 ══════════ PAGE TRACKER SUMMARY ══════════');
        console.log(`   Pages attempted : ${total}`);
        console.log(`   Pages saved     : ${saved}`);
        console.log(`   Pages skipped   : ${skipped}`);
        console.log(`   Pages 0 leads   : ${noLeads}`);

        // Find gaps
        if (entries.length > 1) {
            const nums = entries.map(e => e.pageNum).sort((a, b) => a - b);
            const gaps = [];
            for (let i = 1; i < nums.length; i++) {
                if (nums[i] - nums[i - 1] > 1) {
                    for (let p = nums[i - 1] + 1; p < nums[i]; p++) gaps.push(p);
                }
            }
            if (gaps.length > 0) {
                console.log(`   ❌ MISSING PAGES: ${gaps.join(', ')}`);
            } else {
                console.log('   ✅ No gaps in page sequence');
            }
        }
        console.log('📋 ═════════════════════════════════════════');
        this._flush();
    }

    // ── Internal ──────────────────────────────────────────────────────────────
    _checkJump(pageNum) {
        if (this.lastNavigated > 0 && pageNum > this.lastNavigated + 1) {
            console.log(`⚠️ [PageTracker] Gap detected: last navigated=${this.lastNavigated}, now starting page ${pageNum}`);
        }
    }
    _warn(pageNum, msg) {
        console.log(`⚠️ [PageTracker] Page ${pageNum}: ${msg}`);
    }
    _flush() {
        try {
            fs.writeFileSync(this.logFile, JSON.stringify(this.pages, null, 2), 'utf-8');
        } catch {}
    }
}

module.exports = { PageTracker };
