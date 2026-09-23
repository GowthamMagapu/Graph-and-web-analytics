const nf = new Intl.NumberFormat();
const cf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export const num = (n) => (Math.abs(n) >= 100_000 ? cf.format(n) : nf.format(Math.round(n)));
export const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
export const dec = (x, digits = 2) => x.toFixed(digits);

export function timeLabel(iso, range) {
  const d = new Date(iso);
  if (range === 'LAST_HOUR') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (range === 'LAST_30D') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' });
}
