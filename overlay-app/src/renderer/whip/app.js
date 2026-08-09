
(function () {
  'use strict';

  const canvas = document.getElementById('whip');
  const hud = {
    pairing: document.getElementById('hud-pairing'),
    pairingCode: document.getElementById('pairing-code'),
    pairingCopy: document.getElementById('pairing-copy'),
    bridge: document.getElementById('hud-bridge'),
    verdict: document.getElementById('hud-verdict'),
    hint: document.getElementById('hud-hint'),
    debug: document.getElementById('hud-debug')
  };

  const host = window.whipHost || makeBrowserShim();
  let config = null;
  let rope = null;
  let renderer = null;
  let audio = null;
  let crackCount = 0;
  let verdictTimer = null;

  boot();

  async function boot() {
    config = await host.getConfig();
    if (!config) {
      console.error('[whip] no config - is config/whip.config.json readable?');
      return;
    }

    rope = new window.WhipPhysics.WhipRope(config);
    renderer = new window.WhipRenderer(canvas, config);
    audio = new window.WhipAudio(config);
    await applySkin();

    host.onConfig?.(async (next) => {
      const skinChanged = next.appearance.skin !== config.appearance.skin;
      config = next;
      rope.setConfig(config);
      renderer.setConfig(config);
      audio.setConfig(config);
      if (skinChanged) await applySkin();
      applyWindowLook();
    });

    host.onSpawn?.((at) => spawn(at?.x, at?.y));
    host.onDrop?.(() => rope.drop());
    host.onVerdict?.(showVerdict);
    host.onBridgeStatus?.(showBridgeStatus);
    host.getBridgeStatus?.().then(showBridgeStatus).catch(() => {});

    bindInput();
    applyWindowLook();

    ensureRunning();
  }

  async function applySkin() {
    const skin = await window.WhipSkin.loadSkin(config.appearance.skin);
    renderer.setSkin(skin);
    console.log(`[whip] skin "${skin.name}" - images: ${skin.loaded.join(', ') || 'none (vector mode)'}`);
  }

  function applyWindowLook() {
    document.body.classList.toggle('hide-cursor', !!config.window.hideCursor);
    document.body.classList.toggle('debug-border', !!config.window.debugBorder);
    hud.debug.classList.toggle('on', !!config.hud.showDebug);
    if (config.hud.showPairingOnStart === false) hud.pairing.classList.remove('on');
  }

  function bindInput() {
    window.addEventListener('mousemove', (event) => {
      if (rope.active) rope.setPointer(event.clientX, event.clientY);
      else lastPointer = { x: event.clientX, y: event.clientY };
    }, { passive: true });

    let lastPress = 0;
    const onPress = (event) => {
      if (!config.controls.dropOnMouseDown) return;
      const button = config.controls.dropButton || 'any';
      if (button === 'left' && event.button !== 0) return;
      if (button === 'right' && event.button !== 2) return;
      if (event.timeStamp - lastPress < 50) return;
      lastPress = event.timeStamp;

      if (rope.active) rope.drop();
      else if (!host.isElectron) spawn(event.clientX, event.clientY);
    };
    window.addEventListener('pointerdown', onPress);
    window.addEventListener('mousedown', onPress);

    window.addEventListener('contextmenu', (event) => event.preventDefault());

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && config.controls.hideOnEscape) {
        rope.despawn();
        audio.idle();
        host.whipGone?.();
      }

      if (event.key === 'd' && rope.active) rope.drop();
      if (event.code === 'Space' && !rope.active) { event.preventDefault(); spawn(lastPointer.x, lastPointer.y); }
    });

    window.addEventListener('resize', () => { renderer.resize(); ensureRunning(); });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { renderer.resize(); ensureRunning(); }
    });
  }

  let lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  function spawn(x, y) {

    renderer.resize();

    const px = Number.isFinite(x) ? x : lastPointer.x;
    const py = Number.isFinite(y) ? y : lastPointer.y;
    lastPointer = { x: px, y: py };
    rope.spawn(px, py, performance.now());
    hud.hint.classList.add('on');
    audio.ensure();
    ensureRunning();
  }

  let lastHeartbeat = 0;
  let frameErrors = 0;
  let running = false;

  const bounds = { width: 0, height: 0 };

  function ensureRunning() {
    if (running) return;
    running = true;
    lastHeartbeat = 0;
    requestAnimationFrame(frame);
  }

  function busy() {
    return rope.active
      || renderer.sparks.length > 0
      || renderer.flashes.length > 0
      || renderer.shockwaves.length > 0
      || !renderer.wasEmpty;
  }

  function frame(now) {
    try {
      step(now);
    } catch (err) {
      frameErrors += 1;
      if (frameErrors <= 3) console.error('[whip] frame failed, continuing:', err);
      if (frameErrors === 3) console.error('[whip] further frame errors will be silent');
      renderer.sparks.length = 0;
      renderer.flashes.length = 0;
      renderer.shockwaves.length = 0;
    }

    if (busy()) {
      requestAnimationFrame(frame);
    } else {
      running = false;
    }
  }

  function step(now) {

    if (rope.active && now - lastHeartbeat > 500) {
      lastHeartbeat = now;
      host.alive?.();
    }

    bounds.width = window.innerWidth;
    bounds.height = window.innerHeight;
    const events = rope.update(now, bounds);

    if (events.cracked) onCrack(events, now);

    if (rope.active) {
      audio.updateWhoosh(rope.tipSpeed, rope.tip?.x);
    }

    if (events.gone) {
      rope.despawn();
      audio.idle();
      hud.hint.classList.remove('on');
      host.whipGone?.();
    }

    renderer.draw(rope, now);
    if (config.hud.showDebug) updateDebug();
  }

  function onCrack(events, now) {
    crackCount += 1;
    audio.crack(events.strength, events.tipX);

    renderer.crackFx(events.tipX, events.tipY, events.strength, now);
    host.crack?.({ strength: events.strength, tipSpeed: events.tipSpeed });
  }

  function showBridgeStatus(status) {
    if (!status) return;
    hud.pairingCode.textContent = status.pairingCode || '—';
    hud.bridge.textContent = status.listening
      ? `${status.url} · ${status.clients} extension${status.clients === 1 ? '' : 's'} connected`
      : 'bridge not running';
    hud.pairing.classList.toggle('on', !!config.hud.showPairingOnStart && status.clients === 0);
    hud.pairing.classList.toggle('paired', status.clients > 0);
  }

  function showVerdict(result) {
    if (!config.hud.showVerdict) return;
    const labels = { scam: 'Likely scam', suspicious: 'Suspicious', clean: 'Nothing flagged', unknown: 'Likely safe' };
    const verdict = result.ok === false ? 'unknown' : result.verdict;

    hud.verdict.className = `verdict on ${verdict}`;
    hud.verdict.innerHTML = '';

    const title = document.createElement('b');
    title.textContent = result.ok === false ? 'Scan failed' : (labels[verdict] || verdict);
    const detail = document.createElement('span');
    detail.textContent = result.ok === false
      ? (result.error || '')
      : `${result.flaggedCount || 0} flagged${typeof result.score === 'number' ? ` · ${Math.round(result.score * 100)}%` : ''}`;
    const summary = document.createElement('small');
    summary.textContent = result.summary || '';

    hud.verdict.append(title, detail, summary);
    renderer.setVerdict(verdict, config.hud.verdictMs);

    clearTimeout(verdictTimer);
    verdictTimer = setTimeout(() => hud.verdict.classList.remove('on'), config.hud.verdictMs || 5000);
  }

  function updateDebug() {
    hud.debug.textContent = [
      `tip ${rope.tipSpeed.toFixed(0)} px/f (peak ${rope.peakTipSpeed.toFixed(0)})`,
      `threshold ${config.crack.tipSpeed}`,
      `cracks ${crackCount}`,
      `${rope.active ? (rope.dropping ? 'dropping' : 'held') : 'idle'}`
    ].join('  ·  ');
  }

  function makeBrowserShim() {
    console.info('[whip] running without Electron - cracks go to the console.');
    document.documentElement.classList.add('preview');
    return {
      isElectron: false,
      async getConfig() {
        const response = await fetch('../../config/whip.config.json', { cache: 'no-store' });
        const raw = await response.json();
        stripComments(raw);

        try {
          raw.sound = raw.sound || {};
          raw.sound.available = await (await fetch('/api/sounds', { cache: 'no-store' })).json();
        } catch {  }
        return raw;
      },
      async getBridgeStatus() {
        return { listening: false, clients: 0, url: '(preview — no bridge)', pairingCode: 'PREVIEW' };
      },
      crack(payload) {
        console.log('[whip] CRACK', payload);
      },
      whipGone() {},
      copyPairingCode() {}
    };
  }

  function stripComments(node) {
    if (!node || typeof node !== 'object') return;
    delete node['//'];
    for (const value of Object.values(node)) stripComments(value);
  }

  hud.pairingCopy?.addEventListener('click', () => {
    const code = hud.pairingCode.textContent;
    host.copyPairingCode?.();
    navigator.clipboard?.writeText(code).catch(() => {});
    hud.pairingCopy.textContent = 'copied';
    setTimeout(() => { hud.pairingCopy.textContent = 'copy'; }, 1500);
  });
})();
