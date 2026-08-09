/**
 * In-page result panel. Injected only after a scan comes back.
 *
 * Lives in a shadow root on an element tagged [data-scamwhip-ui] so that
 * collect.js skips it on the next crack (otherwise we'd start scanning our
 * own output). Same paper-and-rubber-stamp language as the popup and the
 * dashboard, restated here because a content script cannot share their CSS.
 */
(() => {
  if (globalThis.__scamwhipHud) return true;

  let hostEl = null;
  let hideTimer = null;

  const PANEL_CSS = `
    :host { all: initial; }
    :host {
      --paper: #F7F5EE;
      --ink: #1E2530;
      --ink-soft: #4A5163;
      --line: #CFC8B5;
      --rule: #E2DECF;
      --stamp-font: 'Special Elite', 'Courier New', Courier, monospace;
      --body-font: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
      --mono-font: 'IBM Plex Mono', ui-monospace, Consolas, monospace;
    }
    * { box-sizing: border-box; }

    .panel {
      position: fixed; z-index: 2147483647;
      width: 360px; max-width: calc(100vw - 24px);
      max-height: min(72vh, 640px);
      display: flex; flex-direction: column;
      background: var(--paper); color: var(--ink);
      font: 13px/1.5 var(--body-font);
      -webkit-font-smoothing: antialiased;
      border: 1px solid var(--line); border-radius: 8px;
      box-shadow: 0 1px 0 rgba(255,255,255,.7) inset, 0 18px 44px -14px rgba(20,24,32,.55);
      animation: sw-in 260ms cubic-bezier(.16,1,.3,1);
    }
    @keyframes sw-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
    .top-right    { top: 16px; right: 16px; }
    .top-left     { top: 16px; left: 16px; }
    .bottom-right { bottom: 16px; right: 16px; }
    .bottom-left  { bottom: 16px; left: 16px; }

    .head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 12px 16px 9px; border-bottom: 1px solid var(--line); flex: none;
    }
    .wordmark {
      font-family: var(--stamp-font); font-size: 15px; letter-spacing: .03em;
      display: flex; align-items: center; gap: 7px;
    }
    .wordmark svg { width: 16px; height: 16px; flex: none; }
    .tagline {
      font-family: var(--mono-font); font-size: 9px; letter-spacing: .1em;
      text-transform: uppercase; color: var(--ink-soft); margin-top: 2px;
    }
    .x {
      border: 0; background: none; cursor: pointer; color: var(--ink-soft);
      font: 16px/1 var(--body-font); padding: 4px 7px; border-radius: 5px; flex: none;
    }
    .x:hover { background: rgba(30,37,48,.07); color: var(--ink); }
    .x:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

    .scan-target {
      padding: 10px 16px; flex: none;
      border-bottom: 1px dashed var(--line);
      display: flex; flex-direction: column; gap: 2px;
      font-size: 12px; color: var(--ink-soft);
    }
    .scan-target .from {
      color: var(--ink); font-weight: 600; font-size: 13px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .scan-target .subj {
      font-style: italic;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }

    .body { overflow-y: auto; padding: 0 16px 4px; }

    .verdict-zone {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      padding: 24px 0 18px;
    }
    .stamp {
      font-family: var(--stamp-font); font-size: 26px; letter-spacing: .05em;
      padding: 10px 22px; border: 4px solid var(--verdict-color);
      color: var(--verdict-color); background: none;
      border-radius: 6px; text-transform: uppercase; text-align: center;
      position: relative; transform: rotate(-6deg);
      filter: url(#inkTexture);
      animation: stampDown .45s cubic-bezier(.2, 1.4, .5, 1) .15s backwards;
    }
    .stamp::before {
      content: ''; position: absolute; inset: 5px;
      border: 1px solid currentColor; border-radius: 3px; opacity: .55;
    }
    @keyframes stampDown {
      0%   { transform: rotate(-6deg) scale(2.2); opacity: 0; }
      60%  { transform: rotate(-6deg) scale(.92); opacity: 1; }
      100% { transform: rotate(-6deg) scale(1); opacity: 1; }
    }
    .confidence {
      font-family: var(--mono-font); font-size: 11.5px; color: var(--ink-soft);
      text-align: center; max-width: 300px;
      animation: fadeIn .3s ease .55s backwards;
    }
    .confidence b { color: var(--ink); }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    .summary {
      margin: 0; padding-top: 12px; border-top: 1px dashed var(--line);
      font-size: 12.5px; color: var(--ink-soft); white-space: pre-wrap;
    }

    .flags-head {
      font-family: var(--mono-font); font-size: 10.5px; letter-spacing: .1em;
      text-transform: uppercase; color: var(--ink-soft);
      padding: 12px 0 4px; border-top: 1px dashed var(--line);
    }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-top: 1px solid var(--rule); }
    li:first-of-type { border-top: none; }
    .mark {
      width: 16px; height: 16px; border-radius: 50%; flex: none; margin-top: 1px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; background: var(--sev); color: #fff;
    }
    .why { font-weight: 600; font-size: 12.5px; }
    .snippet { font-size: 11.5px; color: var(--ink-soft); margin-top: 1px; word-break: break-word; }
    .no-flags { font-size: 12.5px; color: var(--ink-soft); padding: 6px 0 2px; }

    .actions { display: flex; gap: 8px; padding: 12px 16px 14px; flex: none; border-top: 1px solid var(--line); }
    .btn {
      flex: 1; padding: 8px 10px; font-family: var(--body-font); font-weight: 600;
      font-size: 12.5px; border-radius: 6px; border: 1px solid transparent; cursor: pointer;
    }
    .btn-primary { background: var(--ink); color: var(--paper); }
    .btn-primary:hover { filter: brightness(1.2); }
    .btn-secondary { background: transparent; border-color: var(--line); color: var(--ink); }
    .btn-secondary:hover { background: rgba(30,37,48,.05); }
    .btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

    svg.defs { position: absolute; width: 0; height: 0; }

    .body::-webkit-scrollbar { width: 8px; }
    .body::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
    .body::-webkit-scrollbar-track { background: transparent; }
  `;

  /** Same wording, colours and risk lines as the popup's VIEW.verdicts. */
  const VERDICTS = {
    scam:       { label: 'Scam',          color: '#B23A2E', risk: 'high risk' },
    suspicious: { label: 'Check closely', color: '#B9821C', risk: 'worth a second look' },
    clean:      { label: 'Looks clean',   color: '#2E7D53', risk: 'nothing flagged' },
    unknown:    { label: 'Likely safe',   color: '#2E7D53', risk: 'nothing came back flagged' },
    failed:     { label: 'Error',         color: '#4A5163', risk: 'the scan did not complete' }
  };
  const SEVERITY = { high: '#B23A2E', medium: '#B9821C', low: '#4A5163' };

  const MARK_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 6l8 6 8-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
  </svg>`;

  // The stamp's worn edge. Scoped to this shadow root so it cannot collide with
  // a filter of the same name on the host page.
  const DEFS_SVG = `<svg class="defs" aria-hidden="true">
    <filter id="inkTexture" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="noise" seed="7"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="3"/>
    </filter>
  </svg>`;

  function show(record, options = {}) {
    destroy();

    const meta = record.ok ? (VERDICTS[record.verdict] || VERDICTS.unknown) : VERDICTS.failed;
    const flagged = record.ok ? (record.flagged || []) : [];

    hostEl = document.createElement('div');
    hostEl.setAttribute('data-scamwhip-ui', 'hud');
    hostEl.style.cssText = 'all:initial;position:static;';
    const shadow = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;

    const panel = document.createElement('div');
    panel.className = `panel ${options.position || 'bottom-right'}`;
    panel.style.setProperty('--verdict-color', meta.color);

    panel.innerHTML = `
      ${DEFS_SVG}
      <div class="head">
        <div>
          <div class="wordmark">${MARK_SVG}<span>WHIP</span></div>
          <div class="tagline">Mail inspection</div>
        </div>
        <button class="x" title="Close" aria-label="Close">&times;</button>
      </div>

      <div class="scan-target">
        <span class="from">${escapeHtml(targetFrom(record))}</span>
        <span class="subj">${escapeHtml(targetSubject(record))}</span>
      </div>

      <div class="body">
        <div class="verdict-zone">
          <div class="stamp">${escapeHtml(meta.label)}</div>
          <div class="confidence">${confidenceHtml(record, meta)}</div>
        </div>
        ${record.ok && record.summary ? `<p class="summary">${escapeHtml(record.summary)}</p>` : ''}
        <div class="flags-head">${flagged.length ? `Flags found (${flagged.length})` : 'Flags'}</div>
        ${flagged.length
          ? `<ul>${flagged.map(renderItem).join('')}</ul>`
          : `<div class="no-flags">${record.ok ? 'Nothing flagged for this message.' : 'The scan did not complete.'}</div>`}
      </div>

      <div class="actions">
        <button class="btn btn-secondary" data-act="details">Full report</button>
      </div>
    `;

    panel.querySelector('.x').addEventListener('click', destroy);
    panel.querySelector('[data-act="details"]').addEventListener('click', openReport);

    shadow.append(style, panel);
    document.documentElement.appendChild(hostEl);

    if (options.autoHideMs > 0) hideTimer = setTimeout(destroy, options.autoHideMs);

    return true;
  }

  function openReport() {
    // window.open() called from a content script is at the mercy of
    // Chrome's popup blocker, which checks the page's user-activation
    // state rather than the extension's — it's why this looked fine on a
    // click but got flagged as a blocked popup regardless. Opening the
    // tab from the background/service worker instead sidesteps that
    // entirely, since chrome.tabs.create() there isn't a "popup" from the
    // page's point of view at all.
    try {
      chrome.runtime.sendMessage({ type: 'scamwhip:open-report' }, () => {
        // Swallow "Receiving end does not exist" if no listener is wired
        // up yet, and fall back to the old behaviour so this never goes
        // fully silent.
        if (chrome.runtime.lastError) {
          window.open(chrome.runtime.getURL('index.html#last'), '_blank');
        }
      });
    } catch {
      window.open(chrome.runtime.getURL('index.html#last'), '_blank');
    }
  }

  function targetFrom(record) {
    const from = record.headers?.from;
    const address = record.headers?.fromAddress;
    if (from && address) return `"${from}" <${address}>`;
    return from || address || hostOf(record.url) || 'This page';
  }

  function targetSubject(record) {
    return record.headers?.subject || record.title || record.url || '';
  }

  function confidenceHtml(record, meta) {
    if (!record.ok) return escapeHtml(record.error || meta.risk);
    const parts = [];
    if (typeof record.score === 'number') {
      parts.push(`Confidence: <b>${Math.round(record.score * 100)}%</b>`);
    }
    parts.push(escapeHtml(meta.risk));
    return parts.join(' · ');
  }

  function renderItem(item) {
    const color = SEVERITY[item.severity] || SEVERITY.medium;
    const reason = safeText(item.reason, 'Flagged');
    const snippet = safeText(item.text, '');
    return `<li style="--sev:${color}">
      <div class="mark">!</div>
      <div>
        <div class="why">${escapeHtml(reason)}</div>
        ${snippet ? `<div class="snippet">${escapeHtml(snippet.slice(0, 400))}</div>` : ''}
      </div>
    </li>`;
  }

  /**
   * A flag's `reason`/`text` are supposed to be strings, but they come from
   * whatever the backend sends back through config.js's responseMap, and
   * that mapping can land on the wrong field — an object instead of the
   * string inside it. escapeHtml() happily calls String() on anything, and
   * String({...}) is the literal text "[object Object]", so a mis-mapped
   * field doesn't error, it just prints that. This tries the shapes a
   * mis-mapped value is actually likely to be before giving up.
   */
  function safeText(value, fallback = '') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') {
      const inner = value.text ?? value.value ?? value.reason ?? value.message;
      if (typeof inner === 'string') return inner;
      try {
        return JSON.stringify(value);
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  function destroy() {
    clearTimeout(hideTimer);
    hideTimer = null;
    hostEl?.remove();
    hostEl = null;
    return true;
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  globalThis.__scamwhipHud = { show, destroy };
  return true;
})();
