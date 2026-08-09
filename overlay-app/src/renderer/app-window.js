
(() => {
  'use strict';

  const host = window.scamwhip;
  const $ = (id) => document.getElementById(id);

  const STAMPS = {
    paired:  { label: 'Paired',      color: '#2E7D53', note: 'Crack the whip and the extension inspects whatever you are reading.' },
    waiting: { label: 'Waiting',     color: '#B9821C', note: 'The bridge is up. Paste the pairing code into the extension to connect it.' },
    down:    { label: 'Bridge down', color: '#B23A2E', note: 'Nothing is listening. Another copy of ScamWhip may already own the port.' }
  };

  let copyTimer = null;

  host.onStatus(render);
  host.getStatus().then(render);

  $('btnCopy').addEventListener('click', async () => {
    await host.copyPairingCode();
    const line = $('copyResult');
    line.textContent = 'Copied to the clipboard.';
    line.className = 'result-line ok';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { line.textContent = ''; line.className = 'result-line'; }, 2500);
  });

  $('btnSpawn').addEventListener('click', () => host.spawnWhip());
  $('btnTest').addEventListener('click', () => host.testCrack());
  $('btnHide').addEventListener('click', () => host.forceHide());
  $('btnConfig').addEventListener('click', () => host.openConfigFile());
  $('btnFolder').addEventListener('click', () => host.openConfigFolder());
  $('btnFixConfig').addEventListener('click', () => host.openConfigFile());

  clickable($('btnClose'), () => host.hideWindow());
  clickable($('btnQuit'), () => host.quit());

  function clickable(el, run) {
    el.addEventListener('click', run);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(); }
    });
  }

  function render(status) {
    if (!status) return;
    const bridge = status.bridge || {};
    const paired = bridge.listening && bridge.clients > 0;
    const stamp = !bridge.listening ? STAMPS.down : paired ? STAMPS.paired : STAMPS.waiting;

    const stampEl = $('stampEl');
    stampEl.textContent = stamp.label;
    stampEl.style.setProperty('--verdict-color', stamp.color);
    $('stampNote').textContent = stamp.note;

    setStatus('statusBridge', bridge.listening ? (paired ? 'ok' : 'warn') : 'bad',
      bridge.listening ? (paired ? 'bridge paired' : 'bridge idle') : 'bridge down');
    setStatus('statusWhip', status.whipVisible ? 'ok' : 'pending',
      status.whipVisible ? 'whip out' : 'whip stowed');

    $('factUrl').textContent = bridge.url || 'not running';
    $('factClients').textContent = bridge.listening
      ? `${bridge.clients} connected`
      : '—';
    $('factWhip').textContent = status.whipVisible ? 'on screen' : 'hidden';

    $('pairingCode').textContent = bridge.requiresToken ? (bridge.pairingCode || '—') : 'not required';
    $('btnCopy').disabled = !bridge.requiresToken;

    $('btnSpawn').textContent = status.whipVisible ? 'Drop the whip' : 'Spawn the whip';

    const problems = status.hotkeyProblems || [];
    const warnings = [];
    if (status.configError) warnings.push(status.configError);
    for (const { accelerator, what } of problems) {
      warnings.push(`Another program already owns ${accelerator}, so the ${what} does nothing. `
        + `Pick a different one in whip.config.json under "controls", or use the tray icon.`);
    }
    $('configWarning').classList.toggle('hidden', !warnings.length);
    $('configWarningText').textContent = warnings.join(' ');

    renderHotkeys(status.hotkeys || {}, problems);
    $('versionLine').textContent = `ScamWhip ${status.version || ''}`.trim();
  }

  function setStatus(id, cls, text) {
    const el = $(id);
    el.className = `status ${cls}`;
    el.querySelector('span').textContent = text;
  }

  function renderHotkeys(hotkeys, problems = []) {
    const taken = new Set(problems.map((p) => p.accelerator));
    const note = $('hotkeyNote');
    note.textContent = '';
    const rows = [
      [hotkeys.spawn, 'spawn or drop the whip'],
      [hotkeys.panic, 'hide the overlay, whatever state it is in'],
      ['Esc', 'put the whip away']
    ].filter(([key]) => key);

    rows.forEach(([key, meaning], index) => {
      if (index) note.append(document.createTextNode(' · '));
      const kbd = document.createElement('kbd');
      kbd.textContent = String(key).replace(/CommandOrControl|Control/g, 'Ctrl');
      if (taken.has(key)) kbd.classList.add('dead');
      note.append(kbd, document.createTextNode(` ${taken.has(key) ? 'unavailable' : meaning}`));
    });
  }
})();
