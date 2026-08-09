/**
 * Backend client.
 *
 * The extension makes no judgements of its own. It reads the page, sends the
 * text, and renders whatever the backend says — there is no local scoring, no
 * keyword matching, no heuristics anywhere in this file. If a verdict appears
 * in the UI, a backend produced it.
 *
 * Build a request the way settings.backend says, POST it, then normalise the
 * reply into one internal shape:
 *
 *   { ok, verdict, score, summary, flagged: [{text, reason, severity}], raw }
 *
 * See docs/BACKEND_API.md for the wire format.
 */
import { getFirstPath, clamp } from './util.js';

/** The only four verdicts the UI knows about. */
export const VERDICTS = ['scam', 'suspicious', 'clean', 'unknown'];

/**
 * @param {object} capture  output of the content script (text, url, signals…)
 * @param {object} cfg      full settings object
 * @param {object} extra    { source, strength, requestId }
 */
export async function scan(capture, cfg, extra = {}) {
  const backend = cfg.backend;
  const started = Date.now();

  if (backend.mode === 'off') {
    return fail('Backend is switched off in settings.', { code: 'backend_off' });
  }
  if (!backend.endpoint) {
    return fail('No backend endpoint configured.', { code: 'no_endpoint' });
  }

  const body = buildRequestBody(capture, cfg, extra);
  const headers = buildHeaders(cfg);

  let lastError = null;
  const attempts = Math.max(1, 1 + (backend.retries | 0));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(backend.endpoint, {
        method: backend.method || 'POST',
        headers,
        body: JSON.stringify(body)
      }, backend.timeoutMs);

      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

      if (!response.ok) {
        const detail = json ? shortJson(json) : text.slice(0, 300);
        lastError = `HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`;
        // 4xx other than 408/429 will not get better on retry.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
      } else if (!json) {
        lastError = 'Backend replied with something that is not JSON.';
        break;
      } else {
        return {
          ...normaliseResponse(json, cfg),
          ok: true,
          requestMs: Date.now() - started,
          raw: json
        };
      }
    } catch (err) {
      lastError = err && err.name === 'AbortError'
        ? `Timed out after ${backend.timeoutMs}ms.`
        : `Network error: ${err && err.message ? err.message : String(err)}`;
    }

    if (attempt < attempts) {
      await sleep((backend.retryBackoffMs || 800) * attempt);
    }
  }

  return fail(lastError || 'Request failed.', { code: 'request_failed' });
}

/**
 * Ask the backend to mint an access token.
 *
 * Resolved against the endpoint's origin, so changing the endpoint (an ngrok
 * URL changes every restart) moves this with it automatically.
 */
export async function registerToken(cfg) {
  const b = cfg.backend;
  if (!b.registerPath) return { ok: false, message: 'This backend does not hand out tokens.' };

  let url;
  try {
    url = new URL(b.registerPath, new URL(b.endpoint).origin).toString();
  } catch {
    return { ok: false, message: 'Set a valid address above first.' };
  }

  // Tunnelled backends drop in and out; a single attempt reports a dead server
  // when the next try would have worked.
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: buildHeaders({ ...cfg, backend: { ...b, apiKey: '' } })
      }, Math.min(b.timeoutMs || 20000, 15000));

      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }

      if (!response.ok) {
        last = json
          ? `HTTP ${response.status} — ${shortJson(json)}`
          : `HTTP ${response.status} from ${url}. ${describeHtmlReply(text)}`;
        if (response.status < 500 && response.status !== 429) break;
      } else if (!json) {
        last = `${url} did not return JSON. ${describeHtmlReply(text)}`;
        break;
      } else {
        const token = getFirstPath(json, b.registerTokenPath || 'token');
        if (!token) {
          return { ok: false, message: `No "${b.registerTokenPath}" field in the reply: ${shortJson(json)}` };
        }
        const expires = getFirstPath(json, ['expires_at', 'expiresAt', 'expires']);
        return {
          ok: true,
          token: String(token),
          message: expires
            ? `Token saved — expires ${new Date(expires).toLocaleString()}.`
            : 'Token saved.'
        };
      }
    } catch (err) {
      last = err?.name === 'AbortError'
        ? `${url} did not answer in time.`
        : `Could not reach ${url} — ${err.message}`;
    }
    if (attempt < 3) await sleep(600 * attempt);
  }

  return { ok: false, message: last || 'Could not get a token.' };
}

/** Turn an unexpected HTML body into something a person can act on. */
function describeHtmlReply(text) {
  const body = String(text || '');
  if (/ERR_NGROK|endpoint .* is offline/i.test(body)) return 'The tunnel is offline — start the server and try again.';
  if (/<html/i.test(body)) return 'It replied with a web page, not JSON. Check the address.';
  return body.slice(0, 160).replace(/\s+/g, ' ');
}

/** Quick reachability probe for the dashboard's "Test connection" button. */
export async function testConnection(cfg) {
  if (cfg.backend.mode === 'off') {
    return { ok: false, message: 'Backend is switched off.' };
  }
  const probe = {
    text: 'ScamWhip connection test. Please reply with your normal JSON shape.',
    url: 'https://scamwhip.local/test',
    title: 'ScamWhip connection test',
    capturedAt: new Date().toISOString(),
    signals: {},
    links: [],
    scope: 'test'
  };
  const res = await scan(probe, cfg, { source: 'test' });
  return res.ok
    ? { ok: true, message: `Backend answered in ${res.requestMs}ms — verdict "${res.verdict}".`, result: res }
    : { ok: false, message: res.error, result: res };
}

/* ------------------------------------------------------------------ */
/* request                                                             */
/* ------------------------------------------------------------------ */

export function buildRequestBody(capture, cfg, extra = {}) {
  const f = cfg.backend.requestFields || {};
  const body = {};
  const put = (field, value) => { if (field) body[field] = value; };

  put(f.text, applyPrompt(capture, cfg));
  put(f.url, capture.url || '');
  put(f.title, capture.title || '');
  put(f.capturedAt, capture.capturedAt || new Date().toISOString());
  put(f.source, extra.source || 'manual');
  if (cfg.capture.includeLinks) put(f.links, capture.links || []);
  put(f.signals, capture.signals || {});
  put(f.meta, {
    requestId: extra.requestId || null,
    crackStrength: extra.strength ?? null,
    headers: capture.headers || null,
    scope: capture.scope || 'page',
    chars: capture.chars ?? (capture.text || '').length,
    truncated: !!capture.truncated,
    client: 'scamwhip-extension',
    clientVersion: chrome.runtime?.getManifest?.().version || '0.0.0'
  });

  return { ...body, ...(cfg.backend.extraBody || {}) };
}

/**
 * Wrap the captured text in the instruction template, if there is one.
 *
 * This is not analysis — no judgement is made here, and nothing is scored. It
 * only states what we are asking for, because a general-purpose model has no
 * way to know otherwise. Point ScamWhip at a purpose-built classifier and you
 * can empty `promptTemplate` so the raw text goes over as-is.
 */
function applyPrompt(capture, cfg) {
  const template = cfg.backend.promptTemplate;
  const text = capture.text || '';
  if (!template) return text;

  const headers = capture.headers || {};
  const fields = {
    text,
    url: capture.url || '',
    title: capture.title || '',
    from: headers.fromAddress ? `${headers.from} <${headers.fromAddress}>` : (headers.from || ''),
    subject: headers.subject || ''
  };
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in fields ? fields[key] : whole));
}

/** Tunnels that serve an HTML interstitial to anything that looks like a browser. */
const TUNNEL_HOSTS = /\.(ngrok-free\.dev|ngrok-free\.app|ngrok\.io|ngrok\.app|trycloudflare\.com|loca\.lt)$/i;

function buildHeaders(cfg) {
  const b = cfg.backend;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };

  if (b.apiKey && b.authHeader) {
    headers[b.authHeader] = b.authScheme ? `${b.authScheme} ${b.apiKey}` : b.apiKey;
  }

  // A request from the service worker carries a browser User-Agent, so a free
  // ngrok/cloudflare tunnel answers with its "you are about to visit" HTML page
  // instead of your JSON. Opting out of that is a single header, and getting it
  // wrong surfaces as a baffling "replied with something that is not JSON".
  try {
    const host = new URL(b.endpoint).hostname;
    if (TUNNEL_HOSTS.test(host)) {
      headers['ngrok-skip-browser-warning'] = 'true';
      headers['bypass-tunnel-reminder'] = 'true';
    }
  } catch { /* endpoint not a valid URL; the fetch will report that */ }

  // Anything you set explicitly wins over the above.
  for (const [k, v] of Object.entries(b.headers || {})) {
    if (k && v !== undefined && v !== null && String(v).length) headers[k] = String(v);
  }
  return headers;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* response                                                            */
/* ------------------------------------------------------------------ */

export function normaliseResponse(envelope, cfg) {
  const map = cfg.backend.responseMap || {};

  // Some backends answer with a model's reply as a plain string, and the
  // structured verdict lives inside it. Unwrap that first; everything below
  // then maps exactly as it would against a native JSON response.
  const { json, unwrapError } = unwrapPayload(envelope, cfg);

  if (unwrapError) {
    // The model said something, just not JSON. Show what it said rather than
    // pretending we understood it.
    return {
      verdict: 'unknown',
      score: null,
      summary: unwrapError.text.slice(0, 600),
      flagged: [],
      note: unwrapError.reason
    };
  }

  const rawVerdict = getFirstPath(json, map.verdict);
  const rawScore = getFirstPath(json, map.score);
  const summary = str(getFirstPath(json, map.summary));
  const rawFlagged = getFirstPath(json, map.flagged);

  const score = normaliseScore(rawScore);
  const verdict = normaliseVerdict(rawVerdict, score, cfg);

  const flagged = toArray(rawFlagged).map((item) => {
    if (typeof item === 'string') return { text: item, reason: '', severity: 'medium' };
    return {
      text: str(getFirstPath(item, map.itemText)) || str(item),
      reason: str(getFirstPath(item, map.itemReason)),
      severity: normaliseSeverity(getFirstPath(item, map.itemSeverity)),
      start: numOrNull(getFirstPath(item, map.itemStart)),
      end: numOrNull(getFirstPath(item, map.itemEnd))
    };
  }).filter((f) => f.text || f.reason);

  // "Even the best model wasn't confident" — say so instead of presenting the
  // answer as though it were solid.
  const unsure = cfg.backend.unsurePath ? !!getFirstPath(envelope, cfg.backend.unsurePath) : false;

  return {
    verdict,
    score,
    summary: unsure && summary ? `${summary} (the checker flagged itself as unsure)` : summary,
    flagged,
    unsure
  };
}

/**
 * @returns {{json: object, unwrapError?: {text: string, reason: string}}}
 */
function unwrapPayload(envelope, cfg) {
  const path = cfg.backend.responseJsonPath;
  if (!path) return { json: envelope };

  const inner = getFirstPath(envelope, path);
  if (inner === undefined || inner === null) return { json: envelope };
  if (typeof inner === 'object') return { json: inner };

  const text = String(inner).trim();
  // Models like to wrap JSON in ```json fences however firmly you ask them not to.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  // Or to bracket it with a sentence either side.
  const braced = candidate.slice(candidate.indexOf('{'), candidate.lastIndexOf('}') + 1);

  for (const attempt of [candidate, braced]) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object') return { json: parsed };
    } catch { /* try the next shape */ }
  }

  return { json: envelope, unwrapError: { text, reason: `Could not read JSON out of "${path}".` } };
}

function normaliseVerdict(raw, score, cfg) {
  const aliases = cfg.backend.verdictAliases || {};
  const value = String(raw ?? '').trim().toLowerCase();
  if (value) {
    for (const [verdict, list] of Object.entries(aliases)) {
      if ((list || []).some((a) => String(a).toLowerCase() === value)) return verdict;
    }
    if (VERDICTS.includes(value)) return value;
  }
  if (typeof score === 'number') {
    const t = cfg.backend.scoreThresholds || {};
    if (score >= (t.scam ?? 0.75)) return 'scam';
    if (score >= (t.suspicious ?? 0.4)) return 'suspicious';
    return 'clean';
  }
  return 'unknown';
}

/** Accepts 0..1, 0..100, or "87%". */
function normaliseScore(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let n = typeof raw === 'string' ? parseFloat(raw.replace('%', '')) : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 1) n = n / 100;
  return clamp(n, 0, 1);
}

function normaliseSeverity(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['high', 'critical', 'severe', 'danger', '3'].includes(v)) return 'high';
  if (['low', 'info', 'minor', '1'].includes(v)) return 'low';
  return 'medium';
}

/* ------------------------------------------------------------------ */

function fail(error, extra = {}) {
  return { ok: false, error, verdict: 'unknown', score: null, summary: '', flagged: [], ...extra };
}
function toArray(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function str(v) { return v === undefined || v === null ? '' : String(v); }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function shortJson(j) { try { return JSON.stringify(j).slice(0, 300); } catch { return ''; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
