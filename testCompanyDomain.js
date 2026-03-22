// testCompanyDomain.js
const http = require('http');
const CDP_PORT = 9222;
const COMPANY_IDS = ['2757798', '1035', '1441'];

function getCDPTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const targets = JSON.parse(data);
        const target = targets.find(t => t.type === 'page' && t.url.includes('linkedin.com'));
        if (!target) return reject(new Error('No LinkedIn tab found.'));
        resolve(target);
      });
    }).on('error', () => reject(new Error(`CDP not available on port ${CDP_PORT}`)));
  });
}

function connectCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let msgId = 1;
    ws.on('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      close: () => ws.close()
    }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(msg.error) : res(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

// Step 1: extract CSRF token from browser
async function getCSRFToken(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const match = document.cookie.match(/JSESSIONID=.([^;]+)/);
        return match ? match[1].replace(/"/g, '') : '';
      })()
    `,
    returnByValue: true
  });
  return result.result?.value || '';
}

// Step 2: fetch company using extracted token
async function getCompanyData(cdp, companyId, csrfToken) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      (async () => {
        const url = 'https://www.linkedin.com/sales-api/salesApiCompanies/${companyId}?decoration=%28entityUrn%2Cname%2Cwebsite%2Cindustry%2CemployeeCount%2Clocation%2CflagshipCompanyUrl%2Cheadquarters%2Cdescription%29';
        const resp = await fetch(url, {
          credentials: 'include',
          headers: {
            'accept': 'application/json',
            'csrf-token': '${csrfToken}',
            'x-restli-protocol-version': '2.0.0',
            'x-li-lang': 'en_US'
          }
        });
        const data = await resp.json();
        return JSON.stringify({ status: resp.status, data });
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.result?.value) return JSON.parse(result.result.value);
  throw new Error(result.exceptionDetails?.text || 'Unknown error');
}

(async () => {
  console.log('🔍 LinkedIn Sales API — Company Domain Test\n');

  let target, cdp;
  try {
    target = await getCDPTarget();
    console.log(`✅ Connected to: ${target.url.substring(0, 70)}...\n`);
    cdp = await connectCDP(target.webSocketDebuggerUrl);
  } catch (err) {
    console.error(`❌ CDP Error: ${err.message}`);
    process.exit(1);
  }

  // Extract CSRF token once
  const csrfToken = await getCSRFToken(cdp);
  console.log(`🔑 CSRF Token: ${csrfToken}\n`);

  for (const companyId of COMPANY_IDS) {
    try {
      console.log(`📡 Fetching company ID: ${companyId}`);
      const { status, data } = await getCompanyData(cdp, companyId, csrfToken);
      console.log(`  HTTP Status: ${status}`);

      if (status === 200) {
        console.log(`  Name     : ${data.name || 'N/A'}`);
        console.log(`  Website  : ${data.website || '❌ Not listed'}`);
        console.log(`  Industry : ${data.industry || 'N/A'}`);
        console.log(`  Employees: ${data.employeeCount || 'N/A'}`);
        console.log(`  LinkedIn : ${data.flagshipCompanyUrl || 'N/A'}`);
      } else {
        console.log(`  RAW: ${JSON.stringify(data)}`);
      }
      console.log('');
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}\n`);
    }
  }

  cdp.close();
  console.log('✅ Done.');
})();