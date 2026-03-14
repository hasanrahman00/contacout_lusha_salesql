/**
 * API Routes — v2.4.0
 * --------------------
 * REST + SSE endpoints for the dashboard.
 */

const fs   = require('fs');
const path = require('path');
const jobs = require('../jobs/manager');
const config = require('../config');

const sseClients = [];

function broadcast(event, data) {
    for (let i = sseClients.length - 1; i >= 0; i--) {
        try { sseClients[i].send(event, data); }
        catch { sseClients.splice(i, 1); }
    }
}

// Forward all job events → SSE
jobs.on('update',    (job) => broadcast('job:update',   jobs._safe ? jobs._safe(job) : job));
jobs.on('delete',    (id)  => broadcast('job:delete',   { id }));
jobs.on('log',       (d)   => broadcast('job:log',      d));

function register(router) {

    // ── SSE stream ────────────────────────────────────────────────────────
    router.get('/api/events', (req, res) => {
        const sse = res.sse();
        sseClients.push(sse);
        sse.send('init', jobs.list());
        req.on('close', () => {
            const i = sseClients.indexOf(sse);
            if (i !== -1) sseClients.splice(i, 1);
        });
    });

    // ── Jobs CRUD ─────────────────────────────────────────────────────────
    router.get('/api/jobs', (req, res) => res.json(jobs.list()));

    router.post('/api/jobs', (req, res) => {
        const csvPart = req.parts?.find(p => p.filename && p.filename.endsWith('.csv'));
        if (csvPart) {
            const lines = csvPart.data.toString('utf-8').split(/\r?\n/).filter(l => l.trim());
            const urls  = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
                if (cols.length >= 2 && cols[1])
                    urls.push({ url_number: cols[0] || String(i), url: cols[1], name: cols[2] || '' });
            }
            if (!urls.length) return res.error('No valid URLs found in CSV');
            return res.json(jobs.create({ name: req.body?.name || csvPart.filename, urls }));
        }
        const { name, url } = req.body || {};
        if (!url) return res.error('URL is required');
        res.json(jobs.create({ name: name || 'Untitled', url }));
    });

    router.delete('/api/jobs/:id', (req, res) => {
        res.json({ success: jobs.delete(req.params.id) });
    });

    // ── Scrape: start / stop ──────────────────────────────────────────────
    router.post('/api/jobs/:id/start', (req, res) => {
        const j = jobs.start(req.params.id);
        j ? res.json(j) : res.error('Job not found', 404);
    });

    router.post('/api/jobs/:id/stop', (req, res) => {
        const j = jobs.stop(req.params.id);
        j ? res.json(j) : res.error('Job not found', 404);
    });

    // ── CSV download ──────────────────────────────────────────────────────
    router.get('/api/jobs/:id/csv', (req, res) => {
        const csv = jobs.getCsvPath(req.params.id);
        if (!csv) return res.error('CSV not found', 404);
        const job = jobs.get(req.params.id);
        const filename = (job?.name || 'leads').replace(/[^a-zA-Z0-9_-]/g, '_') + '.csv';
        res.writeHead(200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${filename}"`,
        });
        fs.createReadStream(csv).pipe(res);
    });

    // ── XLSX download ─────────────────────────────────────────────────────
    router.get('/api/jobs/:id/xlsx', (req, res) => {
        const csv = jobs.getCsvPath(req.params.id);
        if (!csv) return res.error('XLSX not found', 404);
        const xlsxPath = csv.replace(/\.csv$/i, '.xlsx');
        if (!fs.existsSync(xlsxPath)) return res.error('XLSX not generated yet', 404);
        const job = jobs.get(req.params.id);
        const filename = (job?.name || 'leads').replace(/[^a-zA-Z0-9_-]/g, '_') + '.xlsx';
        res.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}"`,
        });
        fs.createReadStream(xlsxPath).pipe(res);
    });

    // ── Scrape logs ───────────────────────────────────────────────────────
    router.get('/api/jobs/:id/logs', (req, res) => {
        res.json({ logs: jobs.getLogs(req.params.id) });
    });

    // ── Chrome settings ───────────────────────────────────────────────────
    router.get('/api/settings', (req, res) => {
        let saved = {};
        try {
            if (fs.existsSync(config.SETTINGS_FILE))
                saved = JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8'));
        } catch {}
        res.json({
            CHROME_PATH:   saved.CHROME_PATH   || config.DEFAULTS.CHROME_PATH,
            USER_DATA_DIR: saved.USER_DATA_DIR || config.DEFAULTS.USER_DATA_DIR,
            PORT: saved.PORT || config.DEFAULTS.PORT,
        });
    });

    router.post('/api/settings', (req, res) => {
        const { CHROME_PATH, USER_DATA_DIR, PORT } = req.body || {};
        if (!CHROME_PATH || !USER_DATA_DIR) return res.error('Chrome Path and User Data Dir are required');
        const settings = {
            CHROME_PATH:   CHROME_PATH.trim(),
            USER_DATA_DIR: USER_DATA_DIR.trim(),
            PORT: parseInt(PORT, 10) || 9222,
        };
        const dir = path.dirname(config.SETTINGS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
        res.json({ success: true, message: 'Settings saved. Restart the server to apply.' });
    });
}

module.exports = { register };
