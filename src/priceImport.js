'use strict';
// Reads a price list (Excel or CSV) and works out which domain prices it sets.
// Nothing is written until the caller applies the plan, so the screen can
// show what will change first.
const ExcelJS = require('exceljs');
const reports = require('./reports');

const short = s => String(s || '').replace(/^Google Workspace /i, '').trim().toLowerCase();

async function readRows(buf) {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) { // "PK": an .xlsx (zip)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, row => {
      rows.push(row.values.slice(1).map(v => {
        if (v && typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : null);
        return v;
      }));
    });
    return rows;
  }
  return parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim()));
}

// Finds the columns by their headings: a domain column, a license/plan
// column (optional) and a monthly price per email.
function findColumns(header) {
  const hs = header.map(h => String(h ?? '').toLowerCase().trim());
  const find = test => hs.findIndex(test);
  const domain = find(h => h === 'domain' || h.includes('domain'));
  const license = find(h => /^(plan|license|licence|sku|product)/.test(h));
  let price = find(h => h.includes('monthly') && h.includes('price'));
  if (price < 0) price = find(h => /price/.test(h) && !/year|annual|total|amount/.test(h));
  const note = find(h => h === 'note' || h === 'notes');
  const status = find(h => h === 'status');
  return { domain, license, price, note, status };
}

function toPrice(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  // 0 means "no price set", so a 0 in the file is treated like an empty cell.
  return Number.isFinite(n) && n > 0 && String(v).trim() !== '' ? Math.round(n * 100) / 100 : null;
}

async function plan(db, buf) {
  const rows = await readRows(buf);
  if (!rows.length) throw new Error('The file is empty');
  const cols = findColumns(rows[0]);
  if (cols.domain < 0) throw new Error('No "Domain" column found in the first row');
  if (cols.price < 0) throw new Error('No price column found (expected a heading like "Monthly Price per Seat")');

  // Licenses each domain holds now, to decide between one domain price and
  // a price per license.
  const ov = reports.overview(db);
  const paidByDomain = new Map(ov.domains.map(d => [d.domain, Object.keys(d.licenses).filter(s => !reports.NOT_BILLED.has(s))]));
  const existing = new Map(db.prepare('SELECT domain, sku, price FROM prices').all().map(p => [`${p.domain}|${p.sku}`, p.price]));

  // Domains the file prices per license (two or more plans with prices).
  const plansInFile = new Map();
  for (const r of rows.slice(1)) {
    const d = String(r[cols.domain] ?? '').trim().toLowerCase();
    const lic = cols.license >= 0 ? short(r[cols.license]) : '';
    if (d && lic && toPrice(r[cols.price]) != null) (plansInFile.get(d) || plansInFile.set(d, new Set()).get(d)).add(lic);
  }

  const sets = new Map(); // "domain|sku" -> { domain, sku, price, rows }
  const skipped = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const domain = String(r[cols.domain] ?? '').trim().toLowerCase();
    if (!domain) return;
    const lic = cols.license >= 0 ? String(r[cols.license] ?? '').trim() : '';
    const price = toPrice(r[cols.price]);
    if (price == null) {
      const why = [cols.status >= 0 ? r[cols.status] : null, cols.note >= 0 ? r[cols.note] : null].filter(Boolean).join(' — ');
      skipped.push({ line, domain, license: lic, reason: why || 'no price in the file' });
      return;
    }
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { skipped.push({ line, domain, license: lic, reason: 'not a domain name' }); return; }
    const paid = paidByDomain.get(domain) || [];
    let sku = '*';
    if (lic && (paid.length > 1 || (plansInFile.get(domain)?.size || 0) > 1)) {
      // Price per license: use the license name the dashboard already knows,
      // or Google's full name for one it has not seen on this domain yet.
      sku = paid.find(s => short(s) === short(lic)) || (/^google workspace /i.test(lic) ? lic : `Google Workspace ${lic}`);
    }
    const key = `${domain}|${sku}`;
    const prev = sets.get(key);
    if (prev && prev.price !== price) {
      skipped.push({ line, domain, license: lic, reason: `a different price (${prev.price}) for the same domain and license is on line ${prev.line}` });
      return;
    }
    if (!prev) sets.set(key, { line, domain, sku, license: lic || null, price, old: existing.get(key) ?? null, known: paidByDomain.has(domain) });
  });

  const changes = [...sets.values()];
  return {
    columns: { domain: rows[0][cols.domain], license: cols.license >= 0 ? rows[0][cols.license] : null, price: rows[0][cols.price] },
    changes: changes.filter(c => c.old !== c.price),
    unchanged: changes.filter(c => c.old === c.price).length,
    skipped,
  };
}

function apply(db, changes, by) {
  const now = new Date().toISOString();
  const up = db.prepare(`INSERT INTO prices (domain, sku, price, note, updated_by, updated_at) VALUES (?, ?, ?, 'imported', ?, ?)
    ON CONFLICT(domain, sku) DO UPDATE SET price = excluded.price, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const log = db.prepare('INSERT INTO price_log (domain, sku, old_price, new_price, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const c of changes) {
    up.run(c.domain, c.sku, c.price, by, now);
    log.run(c.domain, c.sku, c.old, c.price, `${by} (import)`, now);
  }
}

module.exports = { plan, apply, parseCsv, findColumns };
