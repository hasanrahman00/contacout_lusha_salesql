// ═══════════════════════════════════════════════════════════════════════════════
// TASK: Scroll Dashboard Page — v2.5.1 (Steady Human Scroll)
// ═══════════════════════════════════════════════════════════════════════════════
// Slow, steady scrolling — no random pauses, no reverse scrolls.
// Just smooth consistent human-speed scrolling so all leads load properly.
// ═══════════════════════════════════════════════════════════════════════════════

const randInt = (min, max) => {
    const low = Math.ceil(min);
    const high = Math.floor(max);
    return Math.floor(Math.random() * (high - low + 1)) + low;
};

async function scrollDashboardPage(page, options = {}) {

    console.log('📜 Scrolling dashboard...');

    const trackerSelector  = options.trackerSelector || "a[data-control-name^='view_lead_panel']";
    const scrollSelector   = options.scrollSelector || null;
    const maxSteps         = randInt(options.minSteps || 12, options.maxSteps || 18);
    const stepPx           = options.stepPx || 280;
    const minDelayMs       = options.minDelayMs || 500;
    const maxDelayMs       = options.maxDelayMs || 1200;
    const timeoutMs        = options.timeoutMs || 20000;
    const maxRounds        = options.maxRounds || 30;
    const bottomStallLimit = options.bottomStallLimit || 4;

    console.log(`🖱️ Scroll: ${maxSteps} steps × ~${stepPx}px, ${minDelayMs}-${maxDelayMs}ms`);

    try {
        await page.waitForSelector(trackerSelector, { state: 'visible', timeout: timeoutMs });
        console.log('✅ Found lead elements');
    } catch (e) {
        console.log(`⚠️ Lead tracker not found: ${trackerSelector}`);
        return 'tracker-not-found';
    }

    const result = await page.evaluate(`
        (async () => {
            const cfg = {
                scrollSelector: ${JSON.stringify(scrollSelector)},
                maxSteps: ${maxSteps},
                stepPx: ${stepPx},
                minDelayMs: ${minDelayMs},
                maxDelayMs: ${maxDelayMs},
                maxRounds: ${maxRounds},
                bottomStallLimit: ${bottomStallLimit}
            };

            const delay = (ms) => new Promise((res) => setTimeout(res, ms));
            const rand  = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

            // Find scrollable container
            let el = null;
            if (cfg.scrollSelector) {
                el = document.querySelector(cfg.scrollSelector);
            }
            if (!el) {
                const cands = Array.from(document.querySelectorAll('main, section, div, ul, ol'))
                    .filter((n) => n.scrollHeight > n.clientHeight && n.offsetHeight > 300)
                    .sort((a, b) => b.clientHeight - a.clientHeight);
                el = cands[0] || null;
            }
            if (!el) return 'no-scroll-container';

            let lastTop = -1;
            let same    = 0;
            let rounds  = 0;

            while (rounds < cfg.maxRounds) {
                for (let i = 0; i < cfg.maxSteps; i++) {

                    // Steady scroll — small variance (±15%) to look natural
                    const variance  = cfg.stepPx * 0.15;
                    const scrollAmt = Math.round(cfg.stepPx + (Math.random() * variance * 2 - variance));

                    el.scrollBy({ top: scrollAmt, behavior: 'smooth' });

                    // Steady delay — just enough variation to not look robotic
                    await delay(rand(cfg.minDelayMs, cfg.maxDelayMs));

                    // Stall detection — reached bottom
                    const curr = el.scrollTop;
                    if (curr === lastTop) {
                        same += 1;
                        if (same >= cfg.bottomStallLimit) {
                            return 'scroll-complete';
                        }
                    } else {
                        same = 0;
                        lastTop = curr;
                    }
                }
                rounds += 1;
            }

            return 'scroll-max-rounds';
        })()
    `);

    console.log(`✅ Scroll done: ${result}`);
    return result;
}

module.exports = { scrollDashboardPage };