// ═══════════════════════════════════════════════════════════════════════════════
// 📗 xlsxWriter — Pure-Node Styled XLSX Generator
// ═══════════════════════════════════════════════════════════════════════════════
// Produces a real .xlsx file (OOXML) using only Node built-ins + zlib.
// No ExcelJS, no xlsx package needed.
//
// Styling applied:
//   Row 1 (header)  : Dark blue bg (#1e3a5f), white bold text, center-aligned
//   Even data rows  : Very light blue (#eef4fb)
//   Odd data rows   : White (#ffffff)
//   All cells       : Thin border, Calibri 11pt
//   Row 1           : Frozen (freeze pane)
//   Columns         : Auto-width based on content (max 60 chars)
//
// Format: XLSX = ZIP archive containing:
//   [Content_Types].xml
//   _rels/.rels
//   xl/workbook.xml
//   xl/_rels/workbook.xml.rels
//   xl/worksheets/sheet1.xml
//   xl/styles.xml
//   xl/sharedStrings.xml (inline strings used instead for simplicity)
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

const fs   = require('fs');
const zlib = require('zlib');

// ── Colour palette ────────────────────────────────────────────────────────────
const HEADER_BG   = '1e3a5f';   // dark navy blue
const HEADER_FG   = 'FFFFFF';   // white
const ROW_EVEN    = 'eef4fb';   // very light blue
const ROW_ODD     = 'FFFFFF';   // white
const BORDER_CLR  = 'b0c4de';   // soft blue-grey border

// ── XML helpers ───────────────────────────────────────────────────────────────
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Convert column index (0-based) to Excel letter(s): 0→A, 25→Z, 26→AA
function colLetter(idx) {
    let s = '';
    idx += 1;
    while (idx > 0) {
        const rem = (idx - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        idx = Math.floor((idx - 1) / 26);
    }
    return s;
}

// Cell address e.g. cellRef(0,0) → "A1"
function cellRef(col, row) {
    return `${colLetter(col)}${row + 1}`;
}

// ── Style index constants (defined in buildStyles()) ─────────────────────────
const SI_HEADER   = 0;   // dark header
const SI_EVEN     = 1;   // even data row
const SI_ODD      = 2;   // odd data row

// ── Build xl/styles.xml ───────────────────────────────────────────────────────
function buildStyles() {
    const border = `
      <border>
        <left style="thin"><color rgb="${BORDER_CLR}"/></left>
        <right style="thin"><color rgb="${BORDER_CLR}"/></right>
        <top style="thin"><color rgb="${BORDER_CLR}"/></top>
        <bottom style="thin"><color rgb="${BORDER_CLR}"/></bottom>
        <diagonal/>
      </border>`;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="${HEADER_FG}"/><name val="Calibri"/></font>
    <font><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${HEADER_BG}"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="${ROW_EVEN}"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>${border}
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="3">
    <!-- 0: Header — dark bg, white bold, center -->
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="0"/>
    </xf>
    <!-- 1: Even data row — light blue -->
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center" wrapText="0"/>
    </xf>
    <!-- 2: Odd data row — white -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center" wrapText="0"/>
    </xf>
  </cellXfs>
</styleSheet>`;
}

// ── Build xl/worksheets/sheet1.xml ────────────────────────────────────────────
function buildSheet(headers, rows) {
    // Compute column widths (cap at 60)
    const widths = headers.map(h => Math.min(h.length + 2, 60));
    for (const row of rows) {
        for (let c = 0; c < headers.length; c++) {
            const val = String(row[headers[c]] || '');
            widths[c] = Math.min(Math.max(widths[c], val.length + 2), 60);
        }
    }

    const lastCol = colLetter(headers.length - 1);
    const lastRow = rows.length + 1;
    const dimension = `A1:${lastCol}${lastRow}`;

    // Column definitions
    const cols = widths.map((w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
    ).join('');

    // Header row (row 1)
    const headerCells = headers.map((h, c) =>
        `<c r="${cellRef(c, 0)}" s="${SI_HEADER}" t="inlineStr"><is><t>${esc(h)}</t></is></c>`
    ).join('');
    const headerRow = `<row r="1" ht="20" customHeight="1">${headerCells}</row>`;

    // Data rows
    const dataRows = rows.map((row, ri) => {
        const si = (ri % 2 === 0) ? SI_EVEN : SI_ODD;
        const cells = headers.map((h, c) =>
            `<c r="${cellRef(c, ri + 1)}" s="${si}" t="inlineStr"><is><t>${esc(row[h] || '')}</t></is></c>`
        ).join('');
        return `<row r="${ri + 2}" ht="16">${cells}</row>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="16" customHeight="1"/>
  <cols>${cols}</cols>
  <sheetData>
    ${headerRow}
    ${dataRows}
  </sheetData>
  <dimension ref="${dimension}"/>
  <pageSetup orientation="landscape" fitToPage="1" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

// ── ZIP writer (pure Node — no archiver needed) ───────────────────────────────
// XLSX is a ZIP file. We write a minimal ZIP using stored (uncompressed) entries
// for XML files (they're already small / fast to decompress).
// ZIP format: local file header + data, then central directory, then EOCD.

function writeZip(entries) {
    // entries: [{ name: string, data: Buffer }]
    const localHeaders = [];
    const centralDir   = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = Buffer.from(entry.name, 'utf-8');
        const dataBytes = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf-8');
        const crc = crc32(dataBytes);
        const size = dataBytes.length;

        // Local file header
        const local = Buffer.alloc(30 + nameBytes.length);
        local.writeUInt32LE(0x04034b50, 0);  // signature
        local.writeUInt16LE(20, 4);           // version needed
        local.writeUInt16LE(0, 6);            // flags
        local.writeUInt16LE(0, 8);            // compression: stored
        local.writeUInt16LE(0, 10);           // mod time
        local.writeUInt16LE(0, 12);           // mod date
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(size, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        nameBytes.copy(local, 30);

        localHeaders.push(local);
        localHeaders.push(dataBytes);

        // Central directory entry
        const cd = Buffer.alloc(46 + nameBytes.length);
        cd.writeUInt32LE(0x02014b50, 0);   // signature
        cd.writeUInt16LE(20, 4);            // version made by
        cd.writeUInt16LE(20, 6);            // version needed
        cd.writeUInt16LE(0, 8);             // flags
        cd.writeUInt16LE(0, 10);            // compression: stored
        cd.writeUInt16LE(0, 12);            // mod time
        cd.writeUInt16LE(0, 14);            // mod date
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(size, 20);
        cd.writeUInt32LE(size, 24);
        cd.writeUInt16LE(nameBytes.length, 28);
        cd.writeUInt16LE(0, 30);            // extra length
        cd.writeUInt16LE(0, 32);            // comment length
        cd.writeUInt16LE(0, 34);            // disk number start
        cd.writeUInt16LE(0, 36);            // internal attrs
        cd.writeUInt32LE(0, 38);            // external attrs
        cd.writeUInt32LE(offset, 42);       // local header offset
        nameBytes.copy(cd, 46);

        centralDir.push(cd);
        offset += local.length + size;
    }

    const cdBuf  = Buffer.concat(centralDir);
    const cdSize  = cdBuf.length;
    const cdStart = offset;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);                    // disk number
    eocd.writeUInt16LE(0, 6);                    // disk with cd
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);                   // comment length

    return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

// CRC-32 (IEEE polynomial) — needed for ZIP integrity
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Build a styled .xlsx file and write it to `outputPath`.
 * @param {Array<Object>} rows     - Array of objects keyed by header labels
 * @param {Array<string>} headers  - Column header labels (ordered)
 * @param {string}        outputPath
 */
function buildXlsx(rows, headers, outputPath) {
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml"
    ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="xl/workbook.xml"/>
</Relationships>`;

    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="14000"/></bookViews>
  <sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
    Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    Target="styles.xml"/>
</Relationships>`;

    const entries = [
        { name: '[Content_Types].xml',         data: contentTypes },
        { name: '_rels/.rels',                 data: rootRels },
        { name: 'xl/workbook.xml',             data: workbook },
        { name: 'xl/_rels/workbook.xml.rels',  data: workbookRels },
        { name: 'xl/worksheets/sheet1.xml',    data: buildSheet(headers, rows) },
        { name: 'xl/styles.xml',               data: buildStyles() },
    ];

    const zipBuf = writeZip(entries);
    fs.writeFileSync(outputPath, zipBuf);
}

module.exports = { buildXlsx };
