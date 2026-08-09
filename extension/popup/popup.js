/**
 * Popup controller.
 *
 * Keeps the mockup's single-source-of-truth idea: nothing in the markup is
 * hardcoded, everything the popup shows comes out of one config object. The
 * difference is that here the object is *built from live state* — the last
 * scan, the bridge status and the backend settings — by buildConfig() below.
 *
 * Edit VIEW to change any label, colour or timing without touching the render
 * code underneath it.
 */
import { timeAgo, hostOf } from '../src/lib/util.js';
import { loadConfig, saveConfig } from '../src/lib/config.js';

const VIEW = {
  brand: { name: 'WHIP', tagline: 'Mail inspection' },

  /** verdict → stamp text, colour, and the line under it */
  verdicts: {
    scam:       { label: 'Scam',          color: '#B23A2E', risk: 'high risk' },
    suspicious: { label: 'Check closely', color: '#B9821C', risk: 'worth a second look' },
    clean:      { label: 'Looks clean',   color: '#2E7D53', risk: 'nothing flagged' },
    unknown:    { label: 'Likely safe',  color: '#2E7D53', risk: 'nothing came back flagged' },
    failed:     { label: 'Error',         color: '#4A5163', risk: 'the scan did not complete' }
  },
  severities: { high: '#B23A2E', medium: '#B9821C', low: '#4A5163' },

  idle: {
    label: 'Crack your whip\nto check for scam',
    color: '#4A5163',
    hint: 'Snap the overlay whip, or press the button below.'
  },

  actions: {
    scan: 'Scan this page now',
    rescan: 'Scan again',
    scanning: 'Inspecting…',
    trust: 'Mark sender safe',
    untrust: 'Un-mark sender',
    report: 'View full inspection report →'
  },

  loadingText: 'INSPECTING MESSAGE…',
  /** Replay the stamp animation only when a scan finishes while you watch. */
  animateOnFresh: true,
  freshWithinMs: 4000
};

const $ = (id) => document.getElementById(id);
let live = null;      // { config, state, bridge, scanning }
let scanning = false;

init();

async function init() {
  $('btnSettings').addEventListener('click', () => openDashboard());
  $('reportLink').addEventListener('click', () => openDashboard('#last'));
  $('btnPrimary').addEventListener('click', runScan);
  $('btnSecondary').addEventListener('click', toggleTrusted);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'scan.started') { scanning = true; render(); }
    if (msg?.type === 'scan.finished' || msg?.type === 'state.changed') refresh();
  });

  await refresh();
  setInterval(refresh, 3000);
}

async function refresh() {
  const info = await send({ type: 'state.get' });
  if (!info) return;
  live = info;
  scanning = !!info.scanning;
  render();
}

/* ------------------------------------------------------------------ */
/* live state → view model                                             */
/* ------------------------------------------------------------------ */

function buildConfig() {
  const cfg = live?.config;
  const result = live?.state?.lastResult || null;
  const headers = result?.headers;

  const fresh = result && Date.now() - result.at < VIEW.freshWithinMs;
  const verdictKey = !result ? null : result.ok ? (result.verdict || 'unknown') : 'failed';
  const meta = verdictKey ? VIEW.verdicts[verdictKey] || VIEW.verdicts.unknown : null;

  return {
    brand: VIEW.brand,

    target: {
      from: headers?.from || (result ? hostOf(result.url) : 'No page inspected yet'),
      address: headers?.fromAddress || '',
      subject: headers?.subject || result?.title || 'Open a page and run an inspection.'
    },

    scanning,
    hasResult: !!result,

    stamp: result
      ? { text: meta.label, color: meta.color, prompt: false, animate: VIEW.animateOnFresh && fresh }
      : { text: VIEW.idle.label, color: VIEW.idle.color, prompt: true, animate: false },

    confidence: buildConfidence(result, meta),

    flags: buildFlags(result),

    status: {
      overlay: bridgeStatus(cfg, live?.bridge),
      backend: backendStatus(cfg)
    },

    trusted: isTrusted(cfg, result?.url),
    actions: VIEW.actions
  };
}

function buildConfidence(result, meta) {
  if (!result) return { html: null, text: VIEW.idle.hint };
  if (!result.ok) return { html: null, text: result.error || meta.risk };

  const parts = [];
  if (typeof result.score === 'number') parts.push(`Confidence: <b>${Math.round(result.score * 100)}%</b>`);
  parts.push(meta.risk);
  return { html: parts.join(' · '), text: '', when: timeAgo(result.at) };
}

function buildFlags(result) {
  if (!result?.ok) return [];
  return (result.flagged || []).map((item) => ({
    color: VIEW.severities[item.severity] || VIEW.severities.medium,
    title: item.reason || 'Flagged',
    detail: item.text || ''
  }));
}

function bridgeStatus(cfg, bridge) {
  if (!cfg?.bridge?.enabled) return { cls: 'warn', text: 'overlay off' };
  switch (bridge?.status) {
    case 'connected': return { cls: 'ok', text: 'overlay ready' };
    case 'connecting': return { cls: 'pending', text: 'connecting' };
    case 'unauthorized': return { cls: 'bad', text: 'bad pairing code' };
    default: return { cls: 'bad', text: 'overlay offline' };
  }
}

function backendStatus(cfg) {
  const { mode, endpoint } = cfg?.backend || {};
  if (mode === 'off') return { cls: 'bad', text: 'backend off' };
  if (!endpoint) return { cls: 'bad', text: 'no endpoint' };
  return { cls: 'ok', text: hostOf(endpoint) || 'backend set' };
}

function isTrusted(cfg, url) {
  const host = hostOf(url || '');
  return !!host && (cfg?.privacy?.blocklist || []).includes(host);
}

/* ------------------------------------------------------------------ */
/* view model → DOM                                                    */
/* ------------------------------------------------------------------ */

function render() {
  if (!live) return;
  const config = buildConfig();

  $('brandName').textContent = config.brand.name;
  $('brandTagline').textContent = config.brand.tagline;

  $('popFrom').textContent = config.target.address
    ? `"${config.target.from}" <${config.target.address}>`
    : config.target.from;
  $('popFrom').title = $('popFrom').textContent;
  $('popSubj').textContent = config.target.subject;
  $('popSubj').title = config.target.subject;

  for (const [id, status] of [['statusOverlay', config.status.overlay], ['statusBackend', config.status.backend]]) {
    const el = $(id);
    el.className = `status ${status.cls}`;
    el.querySelector('span').textContent = status.text;
  }

  /* verdict zone */
  const loading = $('loadingWrap');
  const stampWrap = $('stampWrap');
  const stamp = $('stampEl');

  $('loadingText').textContent = VIEW.loadingText;
  loading.classList.toggle('hide', !config.scanning);
  stampWrap.classList.toggle('show', !config.scanning);

  stamp.style.setProperty('--verdict-color', config.stamp.color);
  stamp.textContent = config.stamp.text;
  stamp.classList.toggle('prompt', config.stamp.prompt);
  // Restart the animation only on a genuinely new result.
  stamp.classList.remove('animate');
  stampWrap.classList.remove('animate');
  if (config.stamp.animate) {
    void stamp.offsetWidth;
    stamp.classList.add('animate');
    stampWrap.classList.add('animate');
  }

  const conf = $('confEl');
  conf.textContent = '';
  if (config.confidence.html) {
    conf.innerHTML = config.confidence.html;
    if (config.confidence.when) {
      const when = document.createElement('span');
      when.textContent = ` · ${config.confidence.when}`;
      conf.appendChild(when);
    }
  } else {
    conf.textContent = config.confidence.text;
  }

  /* flags */
  const head = $('flagsHead');
  const list = $('flagsList');
  list.textContent = '';

  if (!config.hasResult) {
    head.textContent = 'FLAGS';
    list.appendChild(note('Nothing inspected yet.'));
  } else if (config.flags.length) {
    head.textContent = `FLAGS FOUND (${config.flags.length})`;
    for (const flag of config.flags) list.appendChild(flagRow(flag));
  } else {
    head.textContent = 'FLAGS';
    list.appendChild(note('Nothing flagged for this message.'));
  }

  /* actions */
  const primary = $('btnPrimary');
  primary.textContent = config.scanning ? config.actions.scanning
    : config.hasResult ? config.actions.rescan : config.actions.scan;
  primary.disabled = config.scanning;

  const secondary = $('btnSecondary');
  secondary.textContent = config.trusted ? config.actions.untrust : config.actions.trust;
  secondary.disabled = !config.hasResult;
  secondary.title = config.trusted
    ? 'Remove this site from the never-scan list'
    : 'Add this site to the never-scan list, so ScamWhip leaves it alone';

  $('reportLink').textContent = config.actions.report;
}

function flagRow({ color, title, detail }) {
  const row = document.createElement('div');
  row.className = 'flag-row';

  const mark = document.createElement('div');
  mark.className = 'flag-mark';
  mark.style.setProperty('--fc', color);
  mark.textContent = '!';

  const text = document.createElement('div');
  text.className = 'flag-text';
  const t = document.createElement('div');
  t.className = 'flag-title';
  t.textContent = title;
  text.appendChild(t);
  if (detail) {
    const d = document.createElement('div');
    d.className = 'flag-detail';
    d.textContent = detail.length > 220 ? `${detail.slice(0, 220)}…` : detail;
    text.appendChild(d);
  }

  row.append(mark, text);
  return row;
}

function note(message) {
  const div = document.createElement('div');
  div.className = 'no-flags';
  div.textContent = message;
  return div;
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function runScan() {
  if (scanning) return;
  scanning = true;
  render();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await send({ type: 'scan.run', source: 'popup', tabId: tab?.id });
  if (result && !result.ok) toast(result.error);
  await refresh();
}

/** "Mark sender safe" = put this host on the never-scan list. */
async function toggleTrusted() {
  const url = live?.state?.lastResult?.url;
  const host = hostOf(url || '');
  if (!host) return;

  const cfg = await loadConfig();
  const blocklist = cfg.privacy.blocklist || [];
  const already = blocklist.includes(host);

  await saveConfig({
    privacy: { blocklist: already ? blocklist.filter((h) => h !== host) : [...blocklist, host] }
  });

  toast(already ? `${host} will be inspected again.` : `${host} added to the never-scan list.`);
  await refresh();
}

function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`index.html${hash}`) });
  window.close();
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}
