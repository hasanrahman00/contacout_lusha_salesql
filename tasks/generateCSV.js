// ═══════════════════════════════════════════════════════════════════════════════
// 📊 TASK: Generate CSV + Styled XLSX — v3.0.0
// ═══════════════════════════════════════════════════════════════════════════════
//   Data sources: Sales Nav (base) + Lusha + ContactOut + SalesQL (email, phone, LinkedIn, org)
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const path = require('path');
const { parse } = require('json2csv');
const { buildXlsx } = require('./xlsxWriter');

// ── Column definitions (v3.1.0 — Sales Nav + Lusha + ContactOut + SalesQL) ──────
const COLUMNS = [
    { label: 'Url Number',           key: 'url_number' },
    { label: 'Page Number',          key: 'pageNumber' },
    { label: 'Company Name',         key: 'companyName' },
    { label: 'First Name',           key: 'firstName' },
    { label: 'Last Name',            key: 'lastName' },
    { label: 'Job Title',            key: 'title' },
    { label: 'About',                key: 'about' },
    { label: 'Premium',              key: 'premium' },
    { label: 'Degree',               key: 'degree' },
    { label: 'Position Current',     key: 'position_current' },
    { label: 'Position Start Month', key: 'position_start_month' },
    { label: 'Position Start Year',  key: 'position_start_year' },
    { label: 'Person Sales Url',     key: 'personSalesUrl' },
    { label: 'Person LinkedIn Url',  key: 'personLinkedinUrl' },
    { label: 'City',                 key: 'city' },
    { label: 'State',                key: 'state' },
    { label: 'Country',              key: 'country' },
    { label: 'Website_one',          key: 'emailDomain' },
    { label: 'SalesQL Email',         key: 'salesqlEmail' },
    { label: 'SalesQL Phone',         key: 'salesqlPhone' },
    { label: 'SalesQL Has Email',     key: 'salesqlHasEmail' },
    { label: 'SalesQL Has Phone',     key: 'salesqlHasPhone' },
    { label: 'SalesQL Org Employees', key: 'salesqlOrgEmployees' },
    { label: 'SalesQL Org Founded',   key: 'salesqlOrgFounded' },
    { label: 'SalesQL Org Website',   key: 'salesqlOrgWebsite' },
    { label: 'Company Linkedin',     key: 'companyLinkedin' },
    { label: 'Industry',             key: 'industry' },
    { label: 'Company Full Address', key: 'companyFullAddress' },
    { label: 'Company City',         key: 'companyCity' },
    { label: 'Company State',        key: 'companyState' },
    { label: 'Company Country',      key: 'companyCountry' },
    { label: 'Company Description',  key: 'companyDescription' },
];

const CSV_FIELDS = COLUMNS.map(c => c.label);

/**
 * Convert JSONL file → leads.csv + leads.xlsx with enforced column order.
 */
async function generateCSV(inputFile, outputFile) {
    console.log('📊 Generating CSV + XLSX...');

    try {
        if (!fs.existsSync(inputFile)) {
            console.log('⚠️ No data file found yet. Skipping CSV generation.');
            return 0;
        }

        const jsonlData = fs.readFileSync(inputFile, 'utf-8');
        const lines = jsonlData.trim().split('\n').filter(l => l.trim());

        if (lines.length === 0) {
            console.log('⚠️ No data captured yet.');
            return 0;
        }

        // Deduplicate by personSalesUrl (unique lead ID), fall back to fullName
        const seen = new Set();
        const rows = [];

        for (const line of lines) {
            let record;
            try { record = JSON.parse(line); } catch { continue; }

            const key = (record.personSalesUrl || record.fullName || '').toLowerCase().trim();
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);

            const row = {};
            for (const col of COLUMNS) {
                row[col.label] = record[col.key] || '';
            }
            rows.push(row);
        }

        // ── Plain CSV ────────────────────────────────────────────────────
        const csv = parse(rows, { fields: CSV_FIELDS });
        fs.writeFileSync(outputFile, csv, 'utf-8');

        // ── Styled XLSX ──────────────────────────────────────────────────
        const xlsxPath = outputFile.replace(/\.csv$/i, '.xlsx');
        buildXlsx(rows, COLUMNS.map(c => c.label), xlsxPath);

        console.log(`✅ CSV + XLSX generated: ${rows.length} leads (${seen.size} unique)`);
        return rows.length;

    } catch (err) {
        console.error(`❌ CSV/XLSX error: ${err.message}`);
        return 0;
    }
}

module.exports = { generateCSV, CSV_FIELDS };
