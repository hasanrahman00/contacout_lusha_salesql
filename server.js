/**
 * VikiLeads Dashboard Server
 * --------------------------
 * Serves the SaaS dashboard UI and API endpoints for
 * managing LinkedIn scraping jobs.
 *
 * Usage: node server.js [port]
 * Default: http://localhost:3000
 */

const path = require('path');
const { Router } = require('./routes/router');
const { register } = require('./routes/api');

const PORT = parseInt(process.argv[2] || process.env.PORT || '3002', 10);

const app = new Router();

// API routes first, then static fallback
register(app);

// Static files from public/
app.static(path.join(__dirname, 'public'));

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     VikiLeads Dashboard v1.0             ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  🌐  http://localhost:${PORT}              ║`);
  console.log('  ║  📊  Dashboard ready                     ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
