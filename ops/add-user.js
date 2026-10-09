'use strict';
// Creates a dashboard login. Usage: npm run add-user -- <username> <admin|accountant|viewer> ["Full name"]
// The password is read from the DASHBOARD_PASSWORD env var, or prompted for.
const path = require('path');
const readline = require('readline');
const dbm = require('../src/db');
const auth = require('../src/auth');

const [username, role, name] = process.argv.slice(2);
if (!username || !role) {
  console.error('Usage: npm run add-user -- <username> <admin|accountant|viewer> ["Full name"]');
  process.exit(1);
}

function ask(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = s => { if (!rl.stdoutMuted || s.includes(q)) rl.output.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const password = process.env.DASHBOARD_PASSWORD || await ask('Password (min 10 chars): ');
  const db = dbm.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'dashboard.db'));
  try {
    auth.createUser(db, { username, role, name, password });
    console.log(`Created ${role} "${username}".`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
