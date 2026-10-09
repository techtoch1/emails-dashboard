'use strict';
// Applies a price list (CSV or Excel on stdin) the same way the Prices
// page's import does, and prints what it set and skipped.
// Usage: node ops/apply-prices.js "<changed by>" < prices.csv
const path = require('path');
const dbm = require('../src/db');
const priceImport = require('../src/priceImport');

const by = process.argv[2] || 'admin';
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  const db = dbm.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dashboard.db'));
  try {
    const p = await priceImport.plan(db, Buffer.concat(chunks));
    dbm.tx(db, () => priceImport.apply(db, p.changes, by));
    for (const c of p.changes) {
      console.log(`set  ${c.domain.padEnd(28)} ${(c.sku === '*' ? 'all licenses' : c.sku).padEnd(36)} ${String(c.old ?? '-').padStart(7)} -> ${c.price}${c.known ? '' : '   (not in the dashboard yet)'}`);
    }
    for (const s of p.skipped) console.log(`skip row ${s.line} ${s.domain} ${s.license}: ${s.reason}`);
    console.log(`\n${p.changes.length} price(s) set, ${p.unchanged} already the same, ${p.skipped.length} row(s) skipped.`);
  } catch (e) {
    console.error(`Could not apply prices: ${e.message}`);
    process.exit(1);
  }
});
