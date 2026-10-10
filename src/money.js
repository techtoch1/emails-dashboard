'use strict';
// Fields that carry prices or income. Removed from anything sent to a user
// who may not see money, so neither a screen nor the AI assistant can reveal it.
const MONEY_KEYS = new Set(['monthly_cost', 'price', 'cost', 'total', 'income', 'unpriced', 'unpriced_accounts', 'currency']);

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !MONEY_KEYS.has(k)).map(([k, x]) => [k, scrub(x)]));
  }
  return v;
}

module.exports = { MONEY_KEYS, scrub };
