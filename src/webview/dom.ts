/** Tiny DOM helpers — no framework, per the §10.1 implementation note. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') {
      node.className = v;
    } else if (k.startsWith('data-') || k === 'role' || k.startsWith('aria-') || k === 'tabindex' || k === 'title' || k === 'type' || k === 'placeholder' || k === 'value' || k === 'for' || k === 'id' || k === 'name') {
      node.setAttribute(k, v);
    } else {
      (node as unknown as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) {
    if (c === null) {
      continue;
    }
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** `3s` · `4m 12s` · `1h 07m` — for elapsed and parked durations. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${(s % 60).toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
}

/** `$0.0432` under a cent-dollar, `$1.24` above. Client-side estimate framing. */
export function fmtCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Clock time for timeline rows: `21:04:11`. */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toTimeString().slice(0, 8);
}
