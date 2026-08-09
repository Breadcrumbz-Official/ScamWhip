/**
 * Dashboard.
 *
 * Shows only what someone needs to get ScamWhip working and read the last
 * result. Configuration is not editable here.
 *
 * Controls carry data-path="a.b.c" pointing into the settings object, so
 * adding one is: put it in DEFAULTS, drop an input in index.html.
 */
import { loadConfig, saveConfig, loadState, STATE_KEY } from '../src/lib/config.js';
import { getPath, timeAgo, hostOf } from '../src/lib/util.js';

const VERDICTS = {
  scam:       { label: 'Scam',          color: '#B23A2E', risk: 'high risk' },
  suspicious: { label: 'Check closely', color: '#B9821C', risk: 'worth a second look' },
  clean:      { label: 'Looks clean',   color: '#2E7D53', risk: 'nothing flagged' },
  unknown:    { label: 'Likely safe',  color: '#2E7D53', risk: 'nothing came back flagged' },
  failed:     { label: 'Error',         color: '#4A5163', risk: 'the inspection did not finish' }
};
const SEVERITY = { high: '#B23A2E', medium: '#B9821C', low: '#4A5163' };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let config = null;

boot();

async function boot() {
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;
  config = await loadConfig();

  bindFields();
  bindActions();
  await render();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'scan.finished' || msg?.type === 'state.changed') render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATE_KEY]) render();
  });
  setInterval(renderStatus, 4000);
}

/* ------------------------------------------------------------------ */
/* settings binding                                                    */
/* ------------------------------------------------------------------ */

/** Typing must not save on every keystroke — saving reconnects the bridge. */
const SAVE_DEBOUNCE_MS = 500;
const saveTimers = new Map();

function bindFields() {
  for (const el of $$('[data-path]')) {
    const instant = el.type === 'checkbox';
    el.addEventListener(instant ? 'change' : 'input', () => onFieldChange(el));
    if (!instant) el.addEventListener('blur', () => onFieldChange(el, true));
  }
}

function fillFields() {
  for (const el of $$('[data-path]')) {
    const value = getPath(config, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value ?? '';
  }
}

async function onFieldChange(el, immediate = false) {
  const path = el.dataset.path;
  // Pasted keys and codes routinely carry a stray space or newline.
  const value = el.type === 'checkbox' ? el.checked : el.value.trim();

  clearTimeout(saveTimers.get(path));
  const run = async () => {
    saveTimers.delete(path);
    config = await saveConfig(patchFor(path, value));
    renderStatus();
  };
  if (el.type === 'checkbox' || immediate) return run();
  saveTimers.set(path, setTimeout(run, SAVE_DEBOUNCE_MS));
}

/** "a.b.c" + value → {a:{b:{c:value}}} */
function patchFor(path, value) {
  const keys = path.split('.');
  const root = {};
  let node = root;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) node[key] = value;
    else node = node[key] = {};
  });
  return root;
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

function bindActions() {
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await runAction(btn.dataset.act);
    } catch (err) {
      toast(err?.message || String(err), 'err');
    } finally {
      btn.disabled = false;
    }
  });

}

async function runAction(act) {
  switch (act) {
    case 'register': {
      setup('Asking the checker for a token…');
      const res = await send({ type: 'backend.register' });
      setup(res.message, res.ok ? 'ok' : 'err');
      if (res.ok) {
        // Fill the field straight from the response rather than waiting on a
        // full config reload — belt-and-braces so the token shows up the
        // instant it's minted, even if the storage round-trip is slow.
        if (res.token) $('#f-key').value = res.token;
        await render();
      }
      break;
    }

    case 'test': {
      setup('Asking the checker…');
      const res = await send({ type: 'backend.test' });
      setup(res.message, res.ok ? 'ok' : 'err');
      break;
    }

    case 'scan': {
      setup('Inspecting…');
      const result = await send({ type: 'scan.run', source: 'dashboard' });
      setup(result.ok
        ? `Done — ${VERDICTS[result.verdict]?.label || result.verdict}, ${result.flagged.length} flag(s).`
        : (result.error || result.message), result.ok ? 'ok' : 'err');
      await render();
      break;
    }





    default:
      toast(`Unknown action: ${act}`, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

async function render() {
  config = await loadConfig();
  fillFields();
  await renderStatus();
  const state = await loadState();
  renderLast(state);
  renderHistory(state);
}

async function renderStatus() {
  const info = await send({ type: 'state.get' });
  const bridge = info?.bridge || {};

  const overlay = !config.bridge.enabled ? { cls: 'warn', text: 'whip app off' }
    : bridge.status === 'connected' ? { cls: 'ok', text: 'whip app ready' }
    : bridge.status === 'connecting' ? { cls: 'pending', text: 'connecting' }
    : bridge.status === 'unauthorized' ? { cls: 'bad', text: 'wrong pairing code' }
    : { cls: 'bad', text: 'whip app not running' };

  const { mode, endpoint } = config.backend;
  const backend = mode === 'off' ? { cls: 'bad', text: 'checker off' }
    : !endpoint ? { cls: 'bad', text: 'no checker set' }
    : { cls: 'ok', text: hostOf(endpoint) || 'checker set' };

  for (const [sel, s] of [['#statusOverlay', overlay], ['#statusBackend', backend]]) {
    const el = $(sel);
    el.className = `status ${s.cls}`;
    el.querySelector('span').textContent = s.text;
  }
}

function renderLast(state) {
  const result = state.lastResult;

  $('#last-empty').classList.toggle('hidden', !!result);
  $('#last-body').classList.toggle('hidden', !result);
  if (!result) return;

  const headers = result.headers;
  $('#last-from').textContent = headers?.fromAddress
    ? `"${headers.from}" <${headers.fromAddress}>`
    : (headers?.from || hostOf(result.url) || 'Unknown source');
  $('#last-subj').textContent = headers?.subject || result.title || '';

  const key = result.ok ? (result.verdict || 'unknown') : 'failed';
  const meta = VERDICTS[key] || VERDICTS.unknown;
  const stamp = $('#last-stamp');
  stamp.textContent = meta.label;
  stamp.style.setProperty('--verdict-color', meta.color);

  const bits = [];
  if (result.ok && typeof result.score === 'number') bits.push(`Confidence: <b>${Math.round(result.score * 100)}%</b>`);
  bits.push(result.ok ? meta.risk : (result.error || meta.risk));
  bits.push(timeAgo(result.at));
  $('#last-conf').innerHTML = bits.join(' · ');

  const flagged = result.ok ? (result.flagged || []) : [];
  $('#last-flags-head').textContent = flagged.length ? `Flags found (${flagged.length})` : 'Flags';

  const list = $('#last-flags');
  list.textContent = '';
  if (!flagged.length) {
    const p = document.createElement('div');
    p.className = 'no-flags';
    p.textContent = result.ok ? 'Nothing flagged in this message.' : 'The inspection did not finish.';
    list.appendChild(p);
  } else {
    for (const item of flagged) list.appendChild(flagRow(item));
  }
}

function flagRow(item) {
  const row = document.createElement('div');
  row.className = 'flag-row';

  const mark = document.createElement('div');
  mark.className = 'flag-mark';
  mark.style.setProperty('--fc', SEVERITY[item.severity] || SEVERITY.medium);
  mark.textContent = '!';

  const text = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'flag-title';
  title.textContent = item.reason || 'Flagged';
  text.appendChild(title);
  if (item.text) {
    const detail = document.createElement('div');
    detail.className = 'flag-detail';
    detail.textContent = item.text;
    text.appendChild(detail);
  }

  row.append(mark, text);
  return row;
}

function renderHistory(state) {
  const body = $('#history-body');
  body.textContent = '';
  const history = state.history || [];

  if (!history.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.className = 'none';
    td.colSpan = 3;
    td.textContent = 'Nothing yet.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const entry of history) {
    const tr = document.createElement('tr');

    const when = document.createElement('td');
    when.className = 'when';
    when.textContent = timeAgo(entry.at);
    when.title = new Date(entry.at).toLocaleString();

    const verdict = document.createElement('td');
    const key = entry.ok ? (entry.verdict || 'unknown') : 'failed';
    verdict.className = `verdict ${key}`;
    verdict.textContent = entry.ok ? (VERDICTS[key]?.label || key) : 'Error';

    const page = document.createElement('td');
    page.className = 'page';
    page.textContent = entry.headers?.subject || entry.title || entry.url || '';

    tr.append(when, verdict, page);
    body.appendChild(tr);
  }
}

/* ------------------------------------------------------------------ */

function setup(message, kind = '') {
  const el = $('#setup-msg');
  el.textContent = message;
  el.className = `result-line ${kind}`;
}

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'err' ? 6000 : 3000);
}

/**
 * The service worker can be asleep, mid-restart, or running an older build with
 * no handler for this message. Each of those rejects sendMessage, and reporting
 * them all as "no response" hides the one fact that would let you fix it.
 */
function send(message, timeoutMs = 30000) {
  return Promise.race([
    chrome.runtime.sendMessage(message).then(
      (reply) => reply ?? { ok: false, message: `The extension gave no answer to "${message.type}". Reload it at chrome://extensions.` },
      (err) => ({ ok: false, message: describeMessagingError(err, message.type) })
    ),
    new Promise((resolve) => setTimeout(
      () => resolve({ ok: false, message: `"${message.type}" took longer than ${Math.round(timeoutMs / 1000)}s. The checker may be unreachable.` }),
      timeoutMs
    ))
  ]);
}

function describeMessagingError(err, type) {
  const text = String(err?.message || err);
  if (/Receiving end does not exist|Could not establish connection/i.test(text)) {
    return 'The extension background worker is not running. Reload ScamWhip at chrome://extensions, then try again.';
  }
  if (/Extension context invalidated/i.test(text)) {
    return 'The extension was reloaded while this page was open. Refresh this page.';
  }
  return `Could not reach the extension (${type}): ${text}`;
}
