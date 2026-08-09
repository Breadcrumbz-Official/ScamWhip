/**
 * Small shared helpers. No imports, no side effects — safe for the service
 * worker, the popup and the dashboard alike.
 */

/** Deep-merge `patch` into a clone of `base`. Arrays are replaced, not merged. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base)) return clone(patch);
  const out = clone(base);
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? deepMerge(out[key], value)
      : clone(value);
  }
  return out;
}

export function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = clone(v);
  return out;
}

/**
 * Read `a.b.c` / `a.b[0].c` out of an object. Used to map whatever shape your
 * backend returns onto the shape the UI wants — see settings.backend.responseMap.
 */
export function getPath(obj, path) {
  if (!path || obj == null) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const raw of parts) {
    if (cur == null) return undefined;
    const match = raw.match(/^([^[\]]*)((\[\d+\])*)$/);
    if (!match) return undefined;
    const [, key, indexes] = match;
    if (key) cur = cur[key];
    if (indexes) {
      for (const idx of indexes.match(/\d+/g) || []) {
        if (cur == null) return undefined;
        cur = cur[Number(idx)];
      }
    }
  }
  return cur;
}

/** First defined value produced by any of `paths`. */
export function getFirstPath(obj, paths) {
  for (const p of [].concat(paths || [])) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** "3 minutes ago" style stamp for the UI. */
export function timeAgo(ts) {
  if (!ts) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * Wildcard host matcher used by the allow/block lists.
 * "*.example.com" matches example.com and any subdomain.
 */
export function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!p) return false;
  if (p.startsWith('*.')) {
    const bare = p.slice(2);
    return h === bare || h.endsWith(`.${bare}`);
  }
  return h === p;
}

export function bytesToNiceSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
