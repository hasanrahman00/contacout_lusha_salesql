// ═══════════════════════════════════════════════════════════════════════════════
// TASK: Setup Network Capture — Lusha + ContactOut + Sales Nav (v3.0.0)
// ═══════════════════════════════════════════════════════════════════════════════
//
//   Sources: Sales Nav (base records) + Lusha (domain) + ContactOut (domain fallback)
//
// Lusha       → browser CDP auto-attach  → captures service worker traffic
// ContactOut  → page.on('response')      → POST /api/v5/profiles/encrypted
// Sales Nav   → page.on('response')      → same-page request
// ═══════════════════════════════════════════════════════════════════════════════

const config = require('../config');
const { cleanName } = require('./nameCleaner');
const { parseLocation } = require('./enrichLocation');
const { extractBestBusinessDomain } = require('./emailFilter');

async function setupNetworkCapture(context, browser) {
    const captureStore = {
        pages: {},
        currentPage: 1,
        _latestSalesNav: [],
        _latestSalesNavRecords: [],
        _salesNavForPage: -1,    // page number for which SN data was captured

        getCurrent() {
            if (!this.pages[this.currentPage]) {
                this.pages[this.currentPage] = { lusha: [], contactout: [], salesql: [] };
            }
            return this.pages[this.currentPage];
        },

        setPage(num) {
            this.currentPage = num;
            if (!this.pages[num]) this.pages[num] = { lusha: [], contactout: [], salesql: [] };
        },

        clearCurrent() {
            // Reset Lusha + ContactOut + SalesQL per-page buckets.
            // Do NOT touch _latestSalesNavRecords — Sales Nav arrives passively on
            // page load and must be cleared explicitly via clearSalesNav().
            this.pages[this.currentPage] = { lusha: [], contactout: [], salesql: [] };
        },

        // Returns true when SN data was captured for the current page.
        // _salesNavForPage is set in parseSalesNavResponse to store.currentPage
        // at the time data arrived. If that matches the current page, it's fresh.
        isSalesNavFresh() {
            return this._salesNavForPage === this.currentPage &&
                   this._latestSalesNavRecords.length > 0;
        },

        getSalesNavLocations() {
            return this._latestSalesNav;
        },

        getSalesNavRecords() {
            return this._latestSalesNavRecords;
        },
    };

    // ═════════════════════════════════════════════════════════════════════
    // LAYER 1: page.on('response') — catches ContactOut + Sales Nav + Lusha fallback
    // ═════════════════════════════════════════════════════════════════════
    const attachToPage = async (pageTarget) => {
        try {
            pageTarget.on('response', async (response) => {
                try {
                    const url = response.url();
                    if (response.status() < 200 || response.status() >= 300) return;

                    if (url.includes(config.NETWORK_URLS.LUSHA)) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            console.log('📡 [Lusha] Captured via page listener');
                            parseLushaResponse(body, captureStore);
                        }
                    }

                    if (url.includes(config.NETWORK_URLS.CONTACTOUT)) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            console.log('📡 [ContactOut] Captured via page listener');
                            parseContactOutResponse(body, captureStore);
                        }
                    }

                    if (url.includes('api.salesql.com/extension2/search') || url.includes('protechts/search') || (config.NETWORK_URLS.SALESQL && url.includes(config.NETWORK_URLS.SALESQL))) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            console.log('📡 [SalesQL] Captured via page listener');
                            parseSalesQLResponse(body, captureStore);
                        }
                    }

                    if (isSalesNavLeadSearchUrl(url)) {
                        const body = await response.json().catch(() => null);
                        if (body) parseSalesNavResponse(body, captureStore);
                    }
                } catch {}
            });
        } catch {}
    };

    for (const pg of context.pages()) await attachToPage(pg);
    context.on('page', attachToPage);

    // Also listen on background pages (Lusha MV2 fallback)
    try {
        for (const bg of context.backgroundPages()) await attachToPage(bg);
        context.on('backgroundpage', attachToPage);
    } catch {}

    // ═════════════════════════════════════════════════════════════════════
    // LAYER 2: Raw WebSocket CDP — zero external deps (http + net + crypto)
    // ═════════════════════════════════════════════════════════════════════
    try {
        const http   = require('http');
        const crypto = require('crypto');
        const port   = config.PORT || 9222;

        // ── Minimal WebSocket frame encoder (client→server, always masked) ──
        function wsEncode(data) {
            const payload  = Buffer.from(data, 'utf8');
            const mask     = crypto.randomBytes(4);
            const len      = payload.length;
            let   header;

            if (len <= 125) {
                header = Buffer.alloc(6);
                header[0] = 0x81;           // FIN + text opcode
                header[1] = 0x80 | len;     // MASK + length
                mask.copy(header, 2);
            } else if (len <= 65535) {
                header = Buffer.alloc(8);
                header[0] = 0x81;
                header[1] = 0x80 | 126;
                header.writeUInt16BE(len, 2);
                mask.copy(header, 4);
            } else {
                header = Buffer.alloc(14);
                header[0] = 0x81;
                header[1] = 0x80 | 127;
                header.writeBigUInt64BE(BigInt(len), 2);
                mask.copy(header, 10);
            }

            const masked = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
            return Buffer.concat([header, masked]);
        }

        // ── Minimal WebSocket frame parser (server→client, never masked) ─
        function wsDecodeFrames(buf, onFrame) {
            let offset = 0;
            while (offset + 2 <= buf.length) {
                const b1  = buf[offset];
                const b2  = buf[offset + 1];
                const op  = b1 & 0x0F;   // 1=text, 8=close, 9=ping
                let   len = b2 & 0x7F;
                let   hdr = 2;

                if (len === 126) {
                    if (offset + 4 > buf.length) break;
                    len = buf.readUInt16BE(offset + 2);
                    hdr = 4;
                } else if (len === 127) {
                    if (offset + 10 > buf.length) break;
                    len = Number(buf.readBigUInt64BE(offset + 2));
                    hdr = 10;
                }

                if (offset + hdr + len > buf.length) break;

                const payload = buf.slice(offset + hdr, offset + hdr + len);
                offset += hdr + len;

                if (op === 1) onFrame(payload.toString('utf8'));   // text
                // op 8 = close, op 9 = ping — ignore for our purposes
            }
            return buf.slice(offset);   // unconsumed bytes
        }

        // ── Get Chrome's browser debugger WS URL ─────────────────────────
        const wsUrl = await new Promise((resolve, reject) => {
            const req = http.get(
                `http://127.0.0.1:${port}/json/version`,
                { timeout: 3000 },
                (res) => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => {
                        try { resolve(JSON.parse(d).webSocketDebuggerUrl); }
                        catch { reject(new Error('Cannot parse /json/version')); }
                    });
                }
            );
            req.on('error', reject);
        });

        // Parse ws://host:port/path
        const u     = new URL(wsUrl);
        const wsKey = crypto.randomBytes(16).toString('base64');

        // ── Open raw TCP + HTTP Upgrade handshake ────────────────────────
        const socket = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: u.hostname,
                port:     u.port || 80,
                path:     u.pathname + u.search,
                headers: {
                    Connection:            'Upgrade',
                    Upgrade:               'websocket',
                    'Sec-WebSocket-Key':   wsKey,
                    'Sec-WebSocket-Version': '13',
                    Host:                  u.host,
                },
            });
            req.on('upgrade', (_res, sock) => resolve(sock));
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('WS upgrade timeout')); });
            req.end();
        });

        socket.setKeepAlive(true);

        let recvBuf = Buffer.alloc(0);
        const send  = (obj) => socket.write(wsEncode(JSON.stringify(obj)));

        // ── CDP state ─────────────────────────────────────────────────────
        const trackedSessions = new Set();
        const pendingRequests  = new Map();   // `${sid}|${reqId}` → source
        const pendingBodies    = new Map();   // cmdId → source
        let   cmdId = 50000;

        const enableNetwork = (sessionId) =>
            send({ id: ++cmdId, method: 'Network.enable', params: {}, sessionId });

        // ── Process inbound CDP messages ──────────────────────────────────
        const onMessage = (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }

            // ── Target.getTargets response — pre-attach existing SWs ──────
            if (msg.id && msg.result?.targetInfos) {
                for (const t of msg.result.targetInfos) {
                    const tUrl = t.url || '';
                    if (
                        t.type === 'service_worker' || t.type === 'background_page' ||
                        tUrl.includes('lbdglhhdbgnknbdifhanfholehojlkgg') ||
                        tUrl.includes('mcebeofpilippmndlpcghpmghcljajna') ||
                        tUrl.includes('contactout')
                    ) {
                        send({ id: ++cmdId, method: 'Target.attachToTarget',
                               params: { targetId: t.targetId, flatten: true } });
                    }
                }
                return;
            }

            // ── New SW attached ───────────────────────────────────────────
            if (msg.method === 'Target.attachedToTarget') {
                const { sessionId, targetInfo } = msg.params || {};
                if (!sessionId) return;
                const type = targetInfo?.type || '';
                const url  = targetInfo?.url  || '';

                const isSalesQL    = url.includes('lbdglhhdbgnknbdifhanfholehojlkgg');
                const isLusha      = url.includes('mcebeofpilippmndlpcghpmghcljajna');
                const isContactOut = url.includes('contactout') && type === 'service_worker';

                if (isSalesQL || isLusha || isContactOut || type === 'service_worker' || type === 'background_page') {
                    trackedSessions.add(sessionId);
                    const label = isSalesQL ? 'SalesQL' : isLusha ? 'Lusha' : isContactOut ? 'ContactOut' : type;
                    console.log(`📡 [Raw WS] Tracking ${label}: ${url.slice(0, 70)}`);
                    enableNetwork(sessionId);
                }
                return;
            }

            // ── Flat-protocol: only handle msgs from our SW sessions ──────
            if (!msg.sessionId || !trackedSessions.has(msg.sessionId)) return;
            const sid = msg.sessionId;

            // Network.responseReceived — look for SalesQL / Lusha / CO
            if (msg.method === 'Network.responseReceived') {
                const url    = msg.params?.response?.url    || '';
                const status = msg.params?.response?.status || 0;
                if (status < 200 || status >= 300) return;

                let source = null;
                if (url.includes('api.salesql.com/extension2/search'))             source = 'salesql';
                else if (url.includes('lusha') && url.includes('/api/'))           source = 'lusha';
                else if (url.includes('contactout.com') && url.includes('/api/'))  source = 'contactout';

                if (source) {
                    console.log(`📡 [Raw WS] ${source} response: ${url.slice(0, 80)}`);
                    pendingRequests.set(`${sid}|${msg.params.requestId}`, source);
                }
                return;
            }

            // Network.loadingFinished — fetch body
            if (msg.method === 'Network.loadingFinished') {
                const key    = `${sid}|${msg.params?.requestId}`;
                const source = pendingRequests.get(key);
                if (!source) return;
                pendingRequests.delete(key);

                const id = ++cmdId;
                pendingBodies.set(id, source);
                send({ id, method: 'Network.getResponseBody',
                       params: { requestId: msg.params.requestId }, sessionId: sid });
                return;
            }

            // Response to Network.getResponseBody
            if (msg.id && pendingBodies.has(msg.id) && msg.result) {
                const source = pendingBodies.get(msg.id);
                pendingBodies.delete(msg.id);
                _handleBody(msg.result, source, captureStore);
            }
        };

        // ── Wire up socket events ─────────────────────────────────────────
        socket.on('data', (chunk) => {
            recvBuf = Buffer.concat([recvBuf, chunk]);
            recvBuf = wsDecodeFrames(recvBuf, onMessage);
        });
        socket.on('error', (e) => console.log(`⚠️ [Raw WS] Error: ${e.message}`));
        socket.on('close', ()  => console.log('⚠️ [Raw WS] Closed'));

        // ── Initial CDP commands ──────────────────────────────────────────
        send({ id: ++cmdId, method: 'Target.setAutoAttach',
               params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
        send({ id: ++cmdId, method: 'Target.getTargets', params: {} });

        console.log('✅ [Raw WS] CDP connected — SW capture active');

    } catch (err) {
        console.log(`⚠️ [Raw WS] Setup failed: ${err.message} — using page-level only`);
    }
    return captureStore;
}

function isSalesNavLeadSearchUrl(url) {
    if (!url) return false;
    if (config.NETWORK_URLS?.SALESNAV && url.includes(config.NETWORK_URLS.SALESNAV)) return true;
    return (
        url.includes('linkedin.com/sales-api/salesApiLeadSearch') ||
        url.includes('/sales-api/salesApiLeadSearch')
    );
}


// ═══════════════════════════════════════════════════════════════════════════════
// PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseLushaResponse(body, store) {
    try {
        const contacts = Array.isArray(body) ? body
            : (body.data?.contacts || body.contacts || body.results || []);
        if (!Array.isArray(contacts)) return;

        const current = store.getCurrent();
        let count = 0;

        for (const item of contacts) {
            if (!item) continue;

            const firstName = (item.firstName || '').trim();
            const lastName  = (item.lastName  || '').trim();
            if (!firstName && !lastName) continue;

            const fullName = (item.fullName || `${firstName} ${lastName}`).trim();

            let domain = '';
            if (Array.isArray(item.emails)) {
                for (const email of item.emails) {
                    const addr = (email.address || '').trim();
                    if (!addr) continue;
                    const atMatch = addr.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
                    if (atMatch) {
                        domain = atMatch[1].toLowerCase();
                        break;
                    }
                }
            }

            const personLinkedinUrl = (item.socialLink || '').trim();

            if (current.lusha.some(l => l.fullName === fullName)) continue;

            current.lusha.push({ firstName, lastName, fullName, domain, personLinkedinUrl });
            count++;
        }

        if (count > 0) {
            console.log(`🟢 [Lusha] Captured ${count} contacts (page ${store.currentPage})`);
        }
    } catch (err) {
        console.log(`⚠️ [Lusha] Parse error: ${err.message}`);
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SALES NAV PARSER — full record extraction
// ═══════════════════════════════════════════════════════════════════════════════
function parseSalesNavResponse(body, store) {
    try {
        const elements = body.elements || body.data || body.results || [];
        if (!Array.isArray(elements)) return;

        const records   = [];
        const locations = [];
        const seen = new Set();

        for (const item of elements) {
            if (!item) continue;

            const rawFullName = (item.fullName || '').trim();
            const rawFirstName = (item.firstName || '').trim();

            if (!rawFullName && !rawFirstName) continue;

            const cleanedFull = cleanName(rawFullName);
            if (!cleanedFull) continue;

            const key = cleanedFull.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            const nameParts = cleanedFull.split(/\s+/);
            const firstName = nameParts[0] || rawFirstName;
            const lastName  = nameParts.slice(1).join(' ') || '';

            const about   = (item.summary || '').replace(/[\r\n]+/g, ' ').trim();
            const premium = item.premium ? 'Yes' : 'No';
            const degree  = item.degree != null ? String(item.degree) : '';

            const pos = Array.isArray(item.currentPositions) ? item.currentPositions[0] : null;
            const title       = (pos?.title || '').trim();
            const companyName = (pos?.companyName || '').trim();

            const position_current     = pos?.current ? 'Yes' : '';
            const position_start_month = pos?.startedOn?.month != null ? String(pos.startedOn.month) : '';
            const position_start_year  = pos?.startedOn?.year  != null ? String(pos.startedOn.year)  : '';

            const companyDescription = (pos?.description || '').replace(/[\r\n]+/g, ' ').trim();

            const geoRegion = (item.geoRegion || '').trim();
            const personLoc = parseLocation(geoRegion);

            let personSalesUrl = '';
            const entityUrn = (item.entityUrn || '').trim();
            if (entityUrn) {
                const m = entityUrn.match(/\(([^,)]+)/);
                if (m && m[1]) personSalesUrl = `https://www.linkedin.com/sales/lead/${m[1]}`;
            }

            let companyLinkedin = '';
            let companyLocationRaw = '';
            let companyIndustry = '';
            const companyUrn = (pos?.companyUrn || '').trim();
            if (companyUrn) {
                const cm = companyUrn.match(/:(\d+)$/);
                if (cm && cm[1]) companyLinkedin = `https://www.linkedin.com/sales/company/${cm[1]}`;
            }
            const companyRes = pos?.companyUrnResolutionResult;
            companyLocationRaw = (companyRes?.location || '').trim();
            companyIndustry    = (companyRes?.industry  || '').trim();

            const companyLoc = parseLocation(companyLocationRaw);

            records.push({
                firstName,
                lastName,
                fullName: cleanedFull,
                title,
                companyName,
                about,
                premium,
                degree,
                position_current,
                position_start_month,
                position_start_year,
                city:    personLoc.city,
                state:   personLoc.state,
                country: personLoc.country,
                personSalesUrl,
                companyLinkedin,
                companyFullAddress: companyLocationRaw,
                companyCity:        companyLoc.city,
                companyState:       companyLoc.state,
                companyCountry:     companyLoc.country,
                industry: companyIndustry,
                companyDescription,
            });

            locations.push({
                name: cleanedFull,
                location: geoRegion,
                personSalesUrl,
                companyLinkedin,
                companyLocationRaw,
            });
        }

        if (records.length > 0) {
            store._latestSalesNavRecords = records;
            store._latestSalesNav = locations;
            store._salesNavForPage = store.currentPage;  // tag data with which page it belongs to
            console.log(`🟢 [Sales Nav] Captured ${records.length} full records (page ${store.currentPage})`);
        }
    } catch (err) {
        console.log(`⚠️ [Sales Nav] Parse error: ${err.message}`);
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONTACTOUT PARSER — v3.0.0
// ═══════════════════════════════════════════════════════════════════════════════
function parseContactOutResponse(body, store) {
    try {
        if (!body || !body.success || !body.data || !body.data.profiles) {
            console.log('⚠️ [ContactOut] No profiles in response');
            return;
        }

        const profiles = body.data.profiles;
        const current = store.getCurrent();
        let count = 0;

        for (const [profileUrl, profile] of Object.entries(profiles)) {
            if (!profile) continue;

            const rawFullName = (profile.full_name || '').trim();
            if (!rawFullName) continue;

            const cleanedFull = cleanName(rawFullName);
            if (!cleanedFull) continue;

            if (current.contactout.some(c => c.fullName === cleanedFull)) continue;

            const nameParts = cleanedFull.split(/\s+/);
            const firstName = nameParts[0] || '';
            const lastName  = nameParts.slice(1).join(' ') || '';

            const emails = Array.isArray(profile.emails) ? profile.emails : [];
            const businessDomain = extractBestBusinessDomain(emails);

            // Normalise LinkedIn URL — convert Sales Nav paths to standard /in/ paths
            let personLinkedinUrl = '';
            const rawUrl = profileUrl && profileUrl.includes('linkedin.com')
                ? profileUrl
                : (profile.profile_url && profile.profile_url.includes('linkedin.com') ? profile.profile_url : '');
            if (rawUrl) {
                personLinkedinUrl = rawUrl
                    .replace('/sales/lead/', '/in/')
                    .replace('/sales/people/', '/in/');
            }

            current.contactout.push({
                firstName,
                lastName,
                fullName: cleanedFull,
                domain: businessDomain,
                personLinkedinUrl,
                memberId: profile.member_id || '',
            });
            count++;
        }

        if (count > 0) {
            console.log(`🟢 [ContactOut] Captured ${count} profiles (page ${store.currentPage})`);
            const withDomain = current.contactout.filter(c => c.domain).length;
            console.log(`   📧 ${withDomain}/${count} have business email domains`);
        }
    } catch (err) {
        console.log(`⚠️ [ContactOut] Parse error: ${err.message}`);
    }
}




// ═══════════════════════════════════════════════════════════════════════════════
// SALESQL PARSER — v3.1.0
// ═══════════════════════════════════════════════════════════════════════════════
// SalesQL calls li.protechts.net and returns enriched profiles for the
// current page's leads.
//
// Observed response shapes (SalesQL returns one of these):
//   Shape A: Array of profile objects
//     [{ full_name, emails: [{email, type}], phones: [{phone}], linkedin_url }, ...]
//
//   Shape B: Object with a results/leads/data array
//     { results: [...], data: [...], leads: [...] }
//
//   Shape C: Map keyed by linkedin_url or member_id
//     { "linkedin.com/in/xyz": { name, emails, phones }, ... }
//
// Extracted per record:
//   fullName, firstName, lastName  (cleaned via nameCleaner)
//   salesqlEmail  — best work email (business domain, using emailFilter)
//   salesqlPhone  — first available phone number
//   domain        — domain extracted from work email (for Website_one fallback)
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// SALESQL PARSER — v3.3.0
// ═══════════════════════════════════════════════════════════════════════════════
// API: POST api.salesql.com/extension2/search
//
// Response shapes handled:
//   { profile: {...} }                   — single profile (most common)
//   [{ profile: {...} }, ...]            — array of profiles
//   { results: [{ profile: {...} }] }    — wrapped array
//   { data: [{ profile: {...} }] }       — wrapped array variant
//
// Extracted per lead:
//   fullName, firstName, lastName        → nameCleaner applied
//   linkedinUrl                          → profile.linkedin_url
//   salesqlEmail                         → best non-personal email address (may be masked "...@domain.com")
//   salesqlEmailDomain                   → domain extracted from best email
//   salesqlPhone                         → phones[0].phone (first phone)
//   orgEmployeeCount                     → primary_organization.employees_count
//   orgFoundedYear                       → primary_organization.founded_on_year
//   orgWebsite                           → primary_organization.website_url
//
// EMAIL PRIORITY:
//   1. type="main job" AND verified=true  → use this domain
//   2. If only ONE "main job" email total → use regardless of verified
//   3. Any remaining non-personal email   → fallback
//   4. Skip anything type="personal"
// ═══════════════════════════════════════════════════════════════════════════════
function parseSalesQLResponse(body, store) {
    try {
        // ── Normalise body to array of wrapper items ──────────────────────────
        // Real response shape: [ { identifier, linkedin_identifier, profile: {...} }, ... ]
        // Each item's .profile may be null (skip those).
        let items = [];
        if (!body || typeof body !== 'object') return;

        if (Array.isArray(body)) {
            items = body;
        } else if (body.profile) {
            items = [body];
        } else {
            const arr = body.results || body.data || body.leads || body.profiles || body.contacts;
            if (Array.isArray(arr)) {
                items = arr;
            } else {
                const vals = Object.values(body);
                if (vals.length > 0 && vals[0] && typeof vals[0] === 'object') items = vals;
            }
        }

        if (items.length === 0) {
            console.log('⚠️ [SalesQL] No items in response body');
            return;
        }

        const current = store.getCurrent();
        let count = 0;

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            // ── Extract profile object ────────────────────────────────────────
            // Real shape: item = { identifier, linkedin_identifier, profile: {...} }
            // profile may be null for leads SalesQL has no data on — skip them.
            let profile = null;
            if (item.profile && typeof item.profile === 'object') {
                profile = item.profile;
            } else if (!item.profile && item.profile !== undefined) {
                // profile key exists but is null/undefined → no data, skip
                continue;
            } else if (item.full_name || item.linkedin_url) {
                // Item IS the profile (flat shape)
                profile = item;
            } else {
                continue;
            }

            // ── Name ──────────────────────────────────────────────────────────
            const rawFull = (
                profile.full_name || profile.fullName || profile.name ||
                ((profile.first_name || '') + ' ' + (profile.last_name || '')).trim()
            ).trim();

            if (!rawFull) continue;

            const cleanedFull = cleanName(rawFull);
            if (!cleanedFull) continue;

            if (current.salesql.some(s => s.fullName === cleanedFull)) continue;

            const nameParts = cleanedFull.split(/\s+/);
            const firstName = nameParts[0] || '';
            const lastName  = nameParts.slice(1).join(' ') || '';

            // ── LinkedIn URL ──────────────────────────────────────────────────
            // profile.linkedin_url is the confirmed URL.
            // Fallback: reconstruct from item.linkedin_identifier at the outer level.
            let linkedinUrl = (profile.linkedin_url || '').trim();
            if (!linkedinUrl && item.linkedin_identifier) {
                linkedinUrl = `https://www.linkedin.com/in/${item.linkedin_identifier}`;
            }

            // ── Email selection ───────────────────────────────────────────────
            // Real data uses both type="job" (with main:true) and type="main job".
            // Priority chain:
            //   P1: type includes "main" AND verified:true
            //   P2: only one email with type includes "main" (regardless of verified)
            //   P3: main:true AND verified:true (catches type="job" main:true)
            //   P4: main:true (any verified)
            //   P5: verified:true among job emails
            //   P6: first job email (last resort)
            //   Skip: type="personal"
            const allEmails = Array.isArray(profile.emails) ? profile.emails : [];
            const jobEmails = allEmails.filter(e => {
                const t = (e.type || '').toLowerCase();
                return t !== 'personal' && t !== 'personal email';
            });

            let bestEmail = null;
            if (jobEmails.length === 1) {
                // Only one non-personal email — use it regardless of verified/main flags
                bestEmail = jobEmails[0];
            } else if (jobEmails.length > 1) {
                // Multiple job emails — pick the best verified one
                const hasMainType = jobEmails.filter(e => (e.type || '').toLowerCase().includes('main'));
                const p1 = hasMainType.filter(e => e.verified);          // type=main job + verified
                const p2 = hasMainType;                                   // type=main job (any)
                const p3 = jobEmails.filter(e => e.main && e.verified);  // main:true + verified
                const p4 = jobEmails.filter(e => e.main);                 // main:true (any)
                const p5 = jobEmails.filter(e => e.verified);             // verified (any job)

                if      (p1.length > 0) bestEmail = p1[0];
                else if (p2.length > 0) bestEmail = p2[0];
                else if (p3.length > 0) bestEmail = p3[0];
                else if (p4.length > 0) bestEmail = p4[0];
                else if (p5.length > 0) bestEmail = p5[0];
                else                    bestEmail = jobEmails[0];
            }

            let salesqlEmail = '';
            let salesqlEmailDomain = '';
            if (bestEmail) {
                const addr = (bestEmail.email || '').trim();
                if (addr) {
                    const atMatch = addr.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
                    if (atMatch) {
                        salesqlEmailDomain = atMatch[1].toLowerCase();
                        if (!addr.startsWith('...') && addr.includes('@')) {
                            // Full unmasked email — store complete address
                            salesqlEmail = addr;
                        } else {
                            // Masked address (e.g. ...@neosurf.com) — store domain only
                            salesqlEmail = salesqlEmailDomain;
                        }
                    }
                }
            }

            // ── Phone — prefer company + verified, then main, then first ──────
            const phones = Array.isArray(profile.phones) ? profile.phones : [];
            const companyPhone   = phones.find(p => p.phone_type === 'company' && p.verified && p.is_valid);
            const mainPhone      = phones.find(p => p.main);
            const anyPhone       = phones[0];
            const pickedPhone    = companyPhone || mainPhone || anyPhone;
            const salesqlPhone   = pickedPhone ? (pickedPhone.phone || '').trim() : '';

            // ── Primary organisation ──────────────────────────────────────────
            // Handle partial org objects (some items only have { name })
            const org = (profile.primary_organization && typeof profile.primary_organization === 'object')
                ? profile.primary_organization
                : {};
            const orgEmployeeCount = (org.employees_count != null ? String(org.employees_count) : '').trim();
            const orgFoundedYear   = (org.founded_on_year  != null ? String(org.founded_on_year)  : '').trim();
            const orgWebsite       = (org.website_url || org.websiteUrl || org.website || '').trim();

            current.salesql.push({
                firstName,
                lastName,
                fullName:          cleanedFull,
                linkedinUrl,
                salesqlEmail,
                salesqlEmailDomain,
                salesqlPhone,
                orgEmployeeCount,
                orgFoundedYear,
                orgWebsite,
                hasEmail: salesqlEmailDomain !== '',
                hasPhone: salesqlPhone !== '',
            });
            count++;
        }

        if (count > 0) {
            console.log(`🟢 [SalesQL] Captured ${count} profiles via network (page ${store.currentPage})`);
            const withEmail = current.salesql.filter(s => s.hasEmail).length;
            const withPhone = current.salesql.filter(s => s.hasPhone).length;
            const withOrg   = current.salesql.filter(s => s.orgWebsite).length;
            console.log(`   📧 ${withEmail}/${count} emails  📞 ${withPhone}/${count} phones  🏢 ${withOrg}/${count} org sites`);
        }
    } catch (err) {
        console.log(`⚠️ [SalesQL] Parse error: ${err.message}`);
    }
}



// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Decode + dispatch CDP response body
// ═══════════════════════════════════════════════════════════════════════════════
function _handleBody(result, source, captureStore) {
    try {
        const raw = result.base64Encoded
            ? Buffer.from(result.body, 'base64').toString('utf-8')
            : result.body;
        const json = JSON.parse(raw);

        if (source === 'salesql') {
            // SalesQL fires twice per page — skip second response if first already populated data
            if (captureStore.getCurrent().salesql.length >= 10) {
                console.log('📡 [CDP flat] SalesQL duplicate response — already captured, skipping');
            } else {
                console.log('📡 [CDP flat] SalesQL body captured from service worker');
                parseSalesQLResponse(json, captureStore);
            }
        } else if (source === 'lusha') {
            console.log('📡 [CDP flat] Lusha body captured from service worker');
            parseLushaResponse(json, captureStore);
        } else if (source === 'contactout') {
            console.log('📡 [CDP flat] ContactOut body captured from service worker');
            parseContactOutResponse(json, captureStore);
        }
    } catch (e) {
        console.log(`⚠️ [CDP flat] ${source} body error: ${e.message}`);
    }
}


module.exports = { setupNetworkCapture };