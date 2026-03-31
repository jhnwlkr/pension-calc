export function fmt(n, dec = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function fmtGBP(n, dec = 0) {
  return '£' + fmt(n, dec);
}

export function fmtPct(n, dec = 1) {
  return fmt(n, dec) + '%';
}

// Compact currency for chart axes: £1.2m above £1m, otherwise £250k
export function fmtAxisGBP(v) {
  if (Math.abs(v) >= 1_000_000) return '£' + (v / 1_000_000).toFixed(1) + 'm';
  return '£' + (v / 1000).toFixed(0) + 'k';
}

// Box-Muller normal random
export function randn() {
  let u, v;
  do { u = Math.random(); v = Math.random(); } while (u === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
