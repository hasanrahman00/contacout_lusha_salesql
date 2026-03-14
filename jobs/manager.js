/**
 * Job Manager — v2.4.0
 * ---------------------
 * Scraping  → spawns job-runner.js
 */

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ROOT_DIR  = path.join(__dirname, '..');
const DATA_DIR  = path.join(ROOT_DIR, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

class JobManager extends EventEmitter {

    constructor() {
        super();
        this.jobs     = this._load();
        this.procs         = {};   // active scrape child processes
        this.enricherProcs = {};   // active enricher child processes
    }

    _load() {
        try {
            if (fs.existsSync(JOBS_FILE)) {
                const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
                for (const j of data) {
                    if (j.status === 'running' || j.status === 'stopping') j.status = 'stopped';
                }
                return data;
            }
        } catch {}
        return [];
    }

    _save() {
        fs.writeFileSync(JOBS_FILE, JSON.stringify(this.jobs, null, 2), 'utf-8');
    }

    list()  { return this.jobs.map(j => this._safe(j)); }
    get(id) { return this.jobs.find(j => j.id === id); }

    // ────────────────────────────────────────────────────────────────────────
    // CREATE / DELETE
    // ────────────────────────────────────────────────────────────────────────
    create({ name, url, urls }) {
        const id     = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const jobDir = path.join(DATA_DIR, id);
        fs.mkdirSync(jobDir, { recursive: true });

        const job = {
            id,
            name: name || `Job ${this.jobs.length + 1}`,
            url:  url  || '',
            urls: urls || [],
            status: 'idle', progress: 0, currentPage: 0, totalLeads: 0,
            createdAt: new Date().toISOString(),
            dir: jobDir, logs: [],
        };
        this.jobs.push(job);
        this._save();
        this.emit('update', job);
        return this._safe(job);
    }

    delete(id) {
        const idx = this.jobs.findIndex(j => j.id === id);
        if (idx === -1) return false;
        this.stop(id);
        const job = this.jobs[idx];
        try { if (job.dir && fs.existsSync(job.dir)) fs.rmSync(job.dir, { recursive: true, force: true }); } catch {}
        this.jobs.splice(idx, 1);
        this._save();
        this.emit('delete', id);
        return true;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCRAPE: start / stop
    // ────────────────────────────────────────────────────────────────────────
    start(id) {
        const job = this.get(id);
        if (!job) return null;
        if (job.status === 'running') return this._safe(job);

        // ── Determine resume point ────────────────────────────────────────
        const isResume = (job.status === 'stopped' || job.status === 'failed' || job.status === 'done') && job.currentPage > 0;
        const resumePage = isResume ? job.currentPage : 0;

        job.status = 'running';
        if (isResume) {
            job.logs.push(`\n══ RESUMED from URL index ${job.currentUrlIndex || 0}, page ${resumePage} ══`);
        } else {
            job.progress = 0; job.currentPage = 0; job.totalLeads = 0;
            job.currentUrlIndex = 0;
            job.logs = [];
            // Fresh start: clear old data files so previous run doesn't bleed in
            try {
                const jsonl = path.join(job.dir, 'leads.jsonl');
                const csv   = path.join(job.dir, 'leads.csv');
                const xlsx  = path.join(job.dir, 'leads.xlsx');
                if (fs.existsSync(jsonl)) fs.unlinkSync(jsonl);
                if (fs.existsSync(csv))   fs.unlinkSync(csv);
                if (fs.existsSync(xlsx))  fs.unlinkSync(xlsx);
            } catch {}
        }
        this._save();

        // ── Single-URL job (from URL Input tab) ───────────────────────────
        if (job.url && job.urls.length === 0) {
            this._spawnRunner(job, job.url, '', resumePage);
            this.emit('update', job);
            return this._safe(job);
        }

        // ── Multi-URL job (from CSV Upload) ───────────────────────────────
        if (job.urls.length === 0) {
            job.status = 'failed'; job.logs.push('No URL to scrape');
            this._save(); this.emit('update', job);
            return this._safe(job);
        }

        const startIndex = job.currentUrlIndex || 0;
        const startPage  = isResume ? resumePage : 0;
        this._runUrlSequence(job, startIndex, startPage);

        this.emit('update', job);
        return this._safe(job);
    }

    // ── Run URLs one after another (CSV multi-URL jobs) ───────────────────
    _runUrlSequence(job, urlIndex, startPage) {
        if (urlIndex >= job.urls.length) {
            // All URLs done
            this._countLeads(job);
            job.status = 'done';
            job.progress = 100;
            job.logs.push(`\n🏁 All ${job.urls.length} URLs completed! Total: ${job.totalLeads} leads`);
            this._save();
            this.emit('update', job);
            return;
        }

        if (job.status === 'stopping' || job.status === 'stopped') return;

        const entry = job.urls[urlIndex];
        const urlNumber = entry.url_number || String(urlIndex + 1);
        job.currentUrlIndex = urlIndex;
        job.logs.push(`\n══════════════════════════════════════════`);
        job.logs.push(`🔗 URL ${urlIndex + 1}/${job.urls.length} — #${urlNumber}`);
        job.logs.push(`📎 ${(entry.url || '').slice(0, 80)}...`);
        job.logs.push(`══════════════════════════════════════════`);
        this._save();
        this.emit('log', { id: job.id, line: `🔗 Starting URL ${urlIndex + 1}/${job.urls.length} (#${urlNumber})` });

        // Progress: distribute across all URLs
        const baseProgress = Math.floor((urlIndex / job.urls.length) * 95);
        job.progress = baseProgress;

        this._spawnRunner(job, entry.url, urlNumber, startPage, (code) => {
            // On runner exit for this URL
            if (job.status === 'stopping' || job.status === 'stopped') {
                job.status = 'stopped';
                this._countLeads(job);
                this._save();
                this.emit('update', job);
                return;
            }

            if (code !== 0) {
                job.status = 'failed';
                job.logs.push(`❌ URL #${urlNumber} failed (exit code ${code})`);
                this._countLeads(job);
                this._save();
                this.emit('update', job);
                return;
            }

            job.logs.push(`✅ URL #${urlNumber} completed`);
            this._countLeads(job);
            job.logs.push(`📊 Accumulated total: ${job.totalLeads} leads`);
            this._save();
            this.emit('update', job);

            // ── Auto-advance to next URL (page 0 = fresh start) ──────
            this._runUrlSequence(job, urlIndex + 1, 0);
        });
    }

    // ── Spawn a single job-runner.js process ──────────────────────────────
    _spawnRunner(job, url, urlNumber, startPage, onExit) {
        const id = job.id;
        const runner = path.join(ROOT_DIR, 'job-runner.js');
        const child  = spawn(process.execPath, [runner], {
            cwd: ROOT_DIR,
            env: {
                ...process.env,
                JOB_ID: id,
                JOB_URL: url,
                JOB_DIR: job.dir,
                JOB_URL_NUMBER: urlNumber || '',
                JOB_MAX_PAGES: '100',
                JOB_START_PAGE: String(startPage || 0),
                PW_CHROMIUM_ATTACH_TO_OTHER: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });

        this.procs[id] = child;

        const handle = (line) => {
            if (!line) return;
            job.logs.push(line);
            if (job.logs.length > 500) job.logs.shift();
            this._parseProgress(job, line);
            this.emit('log', { id, line });
        };

        let buf = '';
        child.stdout.on('data', chunk => {
            buf += chunk.toString();
            const lines = buf.split('\n'); buf = lines.pop();
            lines.forEach(l => handle(l.trim()));
        });
        child.stderr.on('data', chunk => {
            chunk.toString().split('\n').forEach(l => handle(('[ERR] ' + l).trim()));
        });

        child.on('exit', (code) => {
            delete this.procs[id];
            if (onExit) {
                // Multi-URL mode: let _runUrlSequence handle status
                onExit(code);
            } else {
                // Single-URL mode: set final status directly
                if (job.status === 'running' || job.status === 'stopping') {
                    job.status = code === 0 ? 'done' : 'failed';
                    if (code === 0) job.progress = 100;
                }
                this._countLeads(job);
                this._save();
                this.emit('update', job);
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // ENRICHER: start / stop / logs
    // ─────────────────────────────────────────────────────────────────────
    startEnricher(id) {
        const job = this.get(id);
        if (!job) return { error: 'Job not found' };
        if (this.enricherProcs[id]) return { error: 'Enricher already running' };

        const script = path.join(ROOT_DIR, 'website-enricher', 'enricher.js');
        if (!fs.existsSync(script)) return { error: 'website-enricher/enricher.js not found' };

        job.enricherStatus = 'running';
        job.enricherLog    = [];
        this._save();
        this.emit('update', job);

        const child = spawn(process.execPath, [script], {
            cwd: ROOT_DIR,
            env: { ...process.env, JOB_DIR: job.dir },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.enricherProcs[id] = child;

        const onLine = (raw) => {
            const line = raw.toString().trim();
            if (!line) return;
            job.enricherLog = job.enricherLog || [];
            job.enricherLog.push(line);
            if (job.enricherLog.length > 300) job.enricherLog.shift();
            this.emit('log', { id, line, source: 'enricher' });
            if (/CSV regenerated|Wrote.*domain|domains confirmed/i.test(line)) this._countLeads(job);
            this._save();
            this.emit('update', job);
        };

        child.stdout.on('data', d => d.toString().split('\n').forEach(onLine));
        child.stderr.on('data', d => d.toString().split('\n').forEach(onLine));

        child.on('exit', (code) => {
            delete this.enricherProcs[id];
            job.enricherStatus = code === 0 ? 'done' : 'stopped';
            this._save();
            this.emit('update', job);
        });

        this._save();
        return this._safe(job);
    }

    stopEnricher(id) {
        const job = this.get(id);
        if (!job) return { error: 'Job not found' };
        const child = this.enricherProcs[id];
        if (child) {
            try { child.kill('SIGTERM'); } catch {}
            delete this.enricherProcs[id];
        }
        job.enricherStatus = 'stopped';
        this._save();
        this.emit('update', job);
        return this._safe(job);
    }

    getEnricherLogs(id) { return this.get(id)?.enricherLog || []; }

    stop(id) {
        const job = this.get(id);
        if (!job) return null;
        const child = this.procs[id];
        if (child) {
            try { child.send({ action: 'stop' }); } catch {}
            const kill = setTimeout(() => {
                try { child.kill('SIGTERM'); } catch {}
                delete this.procs[id];
            }, 5 * 60 * 1000);
            child.once('exit', () => clearTimeout(kill));
        }
        if (job.status === 'running') {
            job.status = 'stopping';
            this._countLeads(job);
            this._save();
            this.emit('update', job);
        }
        return this._safe(job);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────────────
    _parseProgress(job, line) {
        const pm = line.match(/Page\s+(\d+)/i);
        if (pm) {
            job.currentPage = parseInt(pm[1]);
            // For multi-URL: scale progress across all URLs
            if (job.urls && job.urls.length > 1) {
                const urlIdx = job.currentUrlIndex || 0;
                const perUrl = 95 / job.urls.length;
                job.progress = Math.min(95, Math.floor(urlIdx * perUrl + (job.currentPage / 100) * perUrl));
            } else {
                job.progress = Math.min(95, job.currentPage * 4);
            }
        }
        if (/completed/i.test(line)) job.progress = 100;

        // Always count leads from actual CSV file (not from log regex)
        // This ensures cumulative count across multiple URLs
        if (/leads|CSV|XLSX/i.test(line)) {
            this._countLeads(job);
        }

        this._save();
        this.emit('update', job);
    }

    _countLeads(job) {
        try {
            const csv = path.join(job.dir, 'leads.csv');
            if (fs.existsSync(csv)) {
                job.totalLeads = Math.max(0, fs.readFileSync(csv, 'utf-8').split('\n').filter(l => l.trim()).length - 1);
                return;
            }
            // Fallback: count JSONL lines if CSV not yet generated
            const jsonl = path.join(job.dir, 'leads.jsonl');
            if (fs.existsSync(jsonl)) {
                job.totalLeads = Math.max(0, fs.readFileSync(jsonl, 'utf-8').split('\n').filter(l => l.trim()).length);
            }
        } catch {}
    }

    _safe(j) {
        let hasData = false;
        try {
            hasData = j.dir && fs.existsSync(path.join(j.dir, 'leads.jsonl'));
        } catch {}
        return {
            id: j.id, name: j.name, url: j.url, urls: j.urls,
            status: j.status, progress: j.progress,
            currentPage: j.currentPage, totalLeads: j.totalLeads,
            currentUrlIndex: j.currentUrlIndex || 0,
            createdAt: j.createdAt, logCount: j.logs?.length || 0,
            hasData,
            enricherStatus: j.enricherStatus || 'idle',
        };
    }

    getCsvPath(id) {
        const j = this.get(id); if (!j) return null;
        const p = path.join(j.dir, 'leads.csv');
        return fs.existsSync(p) ? p : null;
    }

    getLogs(id) { return this.get(id)?.logs || []; }
}

module.exports = new JobManager();