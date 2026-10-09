'use strict';
// Runs one sync of every enabled tenant from the command line and prints the result.
const path = require('path');
const dbm = require('../src/db');
const { syncAll } = require('../src/sync');

const db = dbm.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dashboard.db'));
syncAll(db).then(results => {
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.tenant}: ${r.ok ? `${r.accounts} accounts` : r.error}`);
    for (const w of r.warnings || []) console.log(`     warning: ${w}`);
  }
  process.exit(results.every(r => r.ok) ? 0 : 1);
});
