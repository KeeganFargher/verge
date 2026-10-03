export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function secs(n: number): string {
  return n < 10 ? `${n.toFixed(1)} s` : `${Math.round(n)} s`;
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
