/**
 * ScamWhip service worker — the thing that ties the whip to the backend.
 *
 *   overlay app --crack--> bridge (WS) --> here
 *   here --> inject collect.js into the active tab --> visible text
 *   here --> POST to your backend --> flagged items
 *   here --> badge + notification + in-page HUD + result back to the overlay
 */
import { loadConfig, saveConfig, loadState, saveState } from '../lib/config.js';
import { BridgeClient } from '../lib/bridge.js';
import { scan as scanBackend, testConnection, registerToken } from '../lib/api.js';
import { hostOf, hostMatches, uid } from '../lib/util.js';

const bridge = new BridgeClient();
let scanInFlight = false;

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureContextMenu();
  await bootBridge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('index.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(bootBridge);

// The SW can be torn down at any time; this runs on every cold start.
bootBridge();

// Chrome may still evict us between cracks — the alarm wakes us to reconnect.
chrome.alarms.create('scamwhip-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'scamwhip-keepalive') bootBridge();
});

// Re-apply bridge settings the moment they change in the dashboard.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['scamwhip.settings']) bootBridge();
});

async function bootBridge() {
  const cfg = await loadConfig();
  bridge.onCrack = (msg) => handleCrack(msg).catch((e) => console.error('[ScamWhip] crack failed', e));
  bridge.onStatus = (snapshot) => {
    saveState({ bridge: snapshot });
    chrome.runtime.sendMessage({ type: 'state.changed', bridge: snapshot }).catch(() => {});
  };
  bridge.configure(cfg.bridge);
  if (cfg.bridge.enabled && bridge.status === 'disconnected') bridge.connect();
}

/* ------------------------------------------------------------------ */
/* triggers                                                            */
/* ------------------------------------------------------------------ */

async function handleCrack(msg) {
  const cfg = await loadConfig();
  if (!cfg.ui.scanOnCrack) return;

  const strength = typeof msg.strength === 'number' ? msg.strength : 1;
  if (strength < (cfg.ui.minCrackStrength || 0)) {
    bridge.sendStatus('ignored', { reason: 'crack too weak', strength });
    return;
  }
  await runScan({ source: 'whip-crack', strength, requestId: msg.id || uid('crack') });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'scan-now') runScan({ source: 'keyboard' });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'scamwhip-scan') runScan({ source: 'context-menu', tabId: tab?.id });
});

async function ensureContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'scamwhip-scan',
    title: 'Scan this page with ScamWhip',
    contexts: ['page', 'selection', 'link']
  });
}

/* ------------------------------------------------------------------ */
/* the scan pipeline                                                   */
/* ------------------------------------------------------------------ */

export async function runScan({ source = 'manual', strength = null, tabId = null, requestId = uid('scan') } = {}) {
  if (scanInFlight) {
    return { ok: false, error: 'A scan is already running.' };
  }
  scanInFlight = true;
  const cfg = await loadConfig();

  try {
    await saveState({ scanning: true });
    broadcast({ type: 'scan.started', requestId, source });
    bridge.sendStatus('scanning', { requestId, source });
    setBadge(cfg, '…', '#8b8b8b');

    const tab = await resolveTab(tabId);
    if (!tab) return finish(cfg, requestId, failure('No active tab to read.'));

    const guard = checkUrlAllowed(tab.url || '', cfg);
    if (!guard.ok) return finish(cfg, requestId, failure(guard.reason));

    /* 1. read the page ------------------------------------------------ */
    const capture = await capturePage(tab.id, cfg);
    if (!capture.ok) return finish(cfg, requestId, failure(capture.error || 'Could not read the page.'));
    if (!capture.text.trim()) {
      return finish(cfg, requestId, failure('No visible text found on this page.'), capture);
    }

    if (cfg.privacy.keepLastCapture) {
      await saveState({ lastCapture: { ...capture, text: capture.text.slice(0, 8000) } });
    }

    /* 2. ask the backend ---------------------------------------------- */
    const result = await scanBackend(capture, cfg, { source, strength, requestId });

    /* 3. tell everyone ------------------------------------------------ */
    return finish(cfg, requestId, result, capture, tab);
  } catch (err) {
    return finish(cfg, requestId, failure(err?.message || String(err)));
  } finally {
    scanInFlight = false;
    await saveState({ scanning: false });
  }
}

async function finish(cfg, requestId, result, capture = null, tab = null) {
  const record = {
    requestId,
    at: Date.now(),
    url: capture?.url || tab?.url || '',
    title: capture?.title || tab?.title || '',
    headers: capture?.headers || null,
    verdict: result.verdict || 'unknown',
    score: result.score ?? null,
    summary: result.summary || '',
    flagged: result.flagged || [],
    ok: !!result.ok,
    error: result.error || '',
    requestMs: result.requestMs ?? null,
    chars: capture?.chars ?? 0,
    scope: capture?.scope || '',
    signals: capture?.signals || {}
  };

  const state = await loadState();
  const history = [record, ...(state.history || [])].slice(0, cfg.privacy.historyLimit || 25);
  await saveState({ lastResult: record, history, scanning: false });

  setBadge(cfg, badgeFor(record), badgeColorFor(record));
  bridge.sendResult(result, { requestId, url: record.url });
  broadcast({ type: 'scan.finished', result: record });

  if (tab?.id && cfg.ui.showHud) showHud(tab.id, record, cfg).catch(() => {});
  if (cfg.ui.notifications) notify(record);

  return record;
}

/* ------------------------------------------------------------------ */
/* page capture                                                        */
/* ------------------------------------------------------------------ */

async function capturePage(tabId, cfg) {
  try {
    // Inject the reader once; it defines globalThis.__scamwhipCollect.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/collect.js']
    });

    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (opts) => globalThis.__scamwhipCollect(opts),
      args: [cfg.capture]
    });

    return result || { ok: false, error: 'The page reader returned nothing.' };
  } catch (err) {
    const message = String(err?.message || err);
    if (/cannot be scripted|Extension manifest|chrome:\/\//i.test(message)) {
      return { ok: false, error: 'Chrome does not allow reading this page (browser-internal or store page).' };
    }
    return { ok: false, error: `Injection failed: ${message}` };
  }
}

async function resolveTab(tabId) {
  if (tabId) {
    try { return await chrome.tabs.get(tabId); } catch { /* gone */ }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) return active;
  const [anyActive] = await chrome.tabs.query({ active: true });
  return anyActive || null;
}

function checkUrlAllowed(url, cfg) {
  if (!/^https?:/i.test(url)) {
    return { ok: false, reason: 'ScamWhip can only read normal web pages (http/https).' };
  }
  const host = hostOf(url);
  const { allowlist = [], blocklist = [] } = cfg.privacy;
  if (blocklist.some((p) => hostMatches(host, p))) {
    return { ok: false, reason: `${host} is on your blocklist — not scanned.` };
  }
  if (allowlist.length && !allowlist.some((p) => hostMatches(host, p))) {
    return { ok: false, reason: `${host} is not on your allowlist — not scanned.` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* output surfaces                                                     */
/* ------------------------------------------------------------------ */

async function showHud(tabId, record, cfg) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/hud.js'] });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (data, options) => globalThis.__scamwhipHud.show(data, options),
    args: [record, {
      position: cfg.ui.hudPosition,
      autoHideMs: cfg.ui.hudAutoHideMs,
      highlight: cfg.ui.highlightFlagged,
      theme: cfg.ui.theme
    }]
  });
}

function notify(record) {
  const titles = {
    scam: 'Likely scam',
    suspicious: 'Looks suspicious',
    clean: 'Nothing flagged',
    unknown: 'Scan finished'
  };
  const title = record.ok ? titles[record.verdict] || titles.unknown : 'ScamWhip error';
  const message = record.ok
    ? (record.summary || `${record.flagged.length} item(s) flagged.`).slice(0, 250)
    : record.error.slice(0, 250);

  chrome.notifications.create(`scamwhip-${record.requestId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title,
    message,
    priority: record.verdict === 'scam' ? 2 : 0
  }, () => void chrome.runtime.lastError);
}

const BADGE_COLORS = { scam: '#e5484d', suspicious: '#f5b942', clean: '#3fbf6f', unknown: '#8b8b8b' };

function badgeFor(record) {
  if (!record.ok) return '×';
  if (record.verdict === 'clean') return 'OK';
  return String(record.flagged.length || (record.verdict === 'scam' ? '!' : '?'));
}
function badgeColorFor(record) {
  return record.ok ? (BADGE_COLORS[record.verdict] || BADGE_COLORS.unknown) : BADGE_COLORS.unknown;
}
function setBadge(cfg, text, color) {
  if (!cfg.ui.badge) { chrome.action.setBadgeText({ text: '' }); return; }
  chrome.action.setBadgeText({ text: String(text) });
  chrome.action.setBadgeBackgroundColor({ color });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => { /* nobody listening */ });
}

function failure(error) {
  return { ok: false, error, verdict: 'unknown', score: null, summary: '', flagged: [] };
}

/* ------------------------------------------------------------------ */
/* messages from popup / dashboard                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'scan.run':
        sendResponse(await runScan({ source: msg.source || 'popup', tabId: msg.tabId }));
        break;

      case 'state.get': {
        const [cfg, state] = await Promise.all([loadConfig(), loadState()]);
        sendResponse({ config: cfg, state, bridge: bridge.snapshot(), scanning: scanInFlight });
        break;
      }

      case 'backend.test':
        sendResponse(await testConnection(await loadConfig()));
        break;

      case 'backend.register': {
        const cfg = await loadConfig();
        const result = await registerToken(cfg);
        if (result.ok) await saveConfig({ backend: { apiKey: result.token } });
        sendResponse(result);
        break;
      }

      case 'scamwhip:open-report':
        // hud.js sends this instead of calling window.open() itself, since
        // a content script's window.open() is at the mercy of the page's
        // popup blocker. chrome.tabs.create() from here isn't a "popup"
        // from the page's point of view, so it's never blocked.
        chrome.tabs.create({ url: chrome.runtime.getURL('index.html#last') });
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` });
    }
  })();
  return true; // keep the channel open for the async reply
});
