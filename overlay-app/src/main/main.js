
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut,
  nativeImage, clipboard, shell, dialog, Notification
} = require('electron');

const { BridgeServer } = require('./ws-server');
const { ConfigStore } = require('./config-store');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

let overlay = null;
let appWindow = null;
let tray = null;
let bridge = null;
let store = null;
let config = null;
let whipVisible = false;
let sweepTimer = null;
let watchdogTimer = null;
let lastHeartbeat = 0;
let shownAt = 0;
let escapeGrabbed = false;
let pairingCode = '';
let quitting = false;
let hotkeyProblems = [];

const NETWORK_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_STREAM_WRITE_AFTER_END']);

process.on('uncaughtException', (err) => {
  if (NETWORK_ERRORS.has(err?.code)) {
    log(`ignored network error: ${err.code} (${err.message})`);
    return;
  }
  console.error('[ScamWhip] uncaught exception', err);
  if (app.isReady()) {
    dialog.showErrorBox('ScamWhip', `${err?.message || err}\n\nThe overlay is still running — check the console for details.`);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[ScamWhip] unhandled rejection', reason);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {

  app.on('second-instance', () => showAppWindow());
  app.whenReady().then(start);
}

app.on('window-all-closed', () => {});

app.on('activate', () => showAppWindow());

async function start() {
  store = new ConfigStore(app.getPath('userData'));
  config = store.load();
  store.watch();
  store.on('change', (next) => {
    config = next;
    overlay?.webContents.send('config', rendererConfig());
    applyWindowConfig();
    pushAppStatus();
    log('config reloaded');
  });

  pairingCode = loadOrCreatePairingCode();

  createOverlay();
  createAppWindow();
  createTray();
  registerShortcuts();
  await startBridge();
  announce();

  if (config.hud?.showAppWindowOnStart !== false) showAppWindow();
}

function announce() {
  const hotkey = config.controls?.globalHotkey || 'Control+Shift+W';
  log(`ready. Tray icon: click to spawn the whip. Hotkey: ${hotkey}.`);
  log('On Windows 11 the tray icon may be under the "^" arrow next to the clock - drag it onto the taskbar to keep it visible.');

  if (config.hud?.showAppWindowOnStart !== false) return;
  if (config.hud?.showStartupNotice === false) return;
  if (!Notification.isSupported()) return;

  const notice = new Notification({
    title: 'ScamWhip is running',
    body: `Press ${hotkey.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl')} to spawn the whip, or click the tray icon. On Windows 11 it may be hidden under the "^" arrow by the clock.`,
    icon: iconPath('appicon.png') || undefined,
    silent: true
  });
  notice.on('click', () => showWhip());
  notice.show();
}

function createOverlay() {
  const bounds = targetDisplay().bounds;

  overlay = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'ScamWhip overlay',
    icon: iconPath('appicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  overlay.setAlwaysOnTop(true, config.window?.alwaysOnTopLevel || 'floating');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  overlay.webContents.on('did-finish-load', () => {
    overlay.webContents.send('config', rendererConfig());
    overlay.webContents.send('bridge-status', bridgeStatus());
  });

  overlay.webContents.on('render-process-gone', (_e, details) => forceHide(`renderer gone: ${details.reason}`));
  overlay.webContents.on('unresponsive', () => forceHide('renderer unresponsive'));
  overlay.on('closed', () => { overlay = null; whipVisible = false; });

  applyWindowConfig();
}

function applyWindowConfig() {
  if (!overlay) return;
  overlay.setOpacity(clamp(config.window?.opacity ?? 1, 0.05, 1));
  overlay.setAlwaysOnTop(!!config.window?.alwaysOnTop, config.window?.alwaysOnTopLevel || 'floating');

  overlay.setIgnoreMouseEvents(!!config.window?.clickThrough, { forward: true });
}

function targetDisplay() {
  if ((config.window?.display || 'cursor') === 'primary') return screen.getPrimaryDisplay();
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function showWhip() {
  if (!overlay) return;
  const display = targetDisplay();
  overlay.setBounds(display.bounds);

  const cursor = screen.getCursorScreenPoint();
  overlay.showInactive();
  whipVisible = true;
  shownAt = Date.now();
  lastHeartbeat = Date.now();
  overlay.webContents.send('spawn-whip', {
    x: cursor.x - display.bounds.x,
    y: cursor.y - display.bounds.y
  });
  updateTrayMenu();
  startWatchdog();
  grabEscape();
}

function grabEscape() {
  if (config.controls?.hideOnEscape === false || escapeGrabbed) return;
  escapeGrabbed = globalShortcut.register('Escape', () => forceHide('Escape'));
  if (!escapeGrabbed) log('could not grab Escape - something else owns it');
}

function releaseEscape() {
  if (!escapeGrabbed) return;
  try { globalShortcut.unregister('Escape'); } catch {  }
  escapeGrabbed = false;
}

function startWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!whipVisible) { clearInterval(watchdogTimer); return; }

    const silentFor = Date.now() - lastHeartbeat;
    if (silentFor > 4000) {
      forceHide(`renderer stopped responding for ${Math.round(silentFor / 1000)}s`);
      return;
    }
    const maxSeconds = config.controls?.maxWhipSeconds ?? 60;
    if (maxSeconds > 0 && Date.now() - shownAt > maxSeconds * 1000) {
      forceHide(`on screen longer than ${maxSeconds}s`);
    }
  }, 1500);
}

function dropWhip() {
  if (!overlay || !whipVisible) return;
  overlay.webContents.send('drop-whip');
}

function hideWhip() {
  if (!overlay) return;
  overlay.hide();
  whipVisible = false;
  releaseEscape();
  updateTrayMenu();
  if (config.controls?.respawnAfterDropMs > 0) {
    setTimeout(showWhip, config.controls.respawnAfterDropMs);
  }
}

function forceHide(why) {
  if (!overlay) return;
  try { overlay.hide(); } catch {  }
  whipVisible = false;
  lastHeartbeat = 0;
  releaseEscape();
  updateTrayMenu();
  log(`overlay force-hidden (${why})`);
}

function toggleWhip() {
  whipVisible ? dropWhip() : showWhip();
}

function createAppWindow() {
  appWindow = new BrowserWindow({
    width: 620,
    height: 780,
    minWidth: 460,
    minHeight: 560,
    show: false,
    title: 'ScamWhip',
    icon: iconPath('appicon.png'),
    backgroundColor: '#EFEBE0',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'app-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  appWindow.setMenuBarVisibility(false);
  appWindow.loadFile(path.join(__dirname, '..', 'renderer', 'app-window.html'));

  appWindow.webContents.on('did-finish-load', () => pushAppStatus());

  appWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    appWindow.hide();
  });

  appWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  appWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

function showAppWindow() {
  if (!appWindow) return;
  if (appWindow.isMinimized()) appWindow.restore();
  appWindow.show();
  appWindow.focus();
  pushAppStatus();
}

function appStatus() {
  return {
    bridge: bridgeStatus(),
    whipVisible,
    configError: store?.error || '',
    version: app.getVersion(),
    hotkeys: {
      spawn: config.controls?.globalHotkey || '',
      panic: config.controls?.panicHotkey || ''
    },
    hotkeyProblems
  };
}

function pushAppStatus() {
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.webContents.send('app:status', appStatus());
  }
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('ScamWhip — click to spawn the whip');
  updateTrayMenu();

  tray.on('click', () => {
    if (config.controls?.spawnOnTrayClick === false) return tray.popUpContextMenu();
    toggleWhip();
  });
  tray.on('right-click', () => tray.popUpContextMenu());
  tray.on('double-click', () => showAppWindow());
}

function updateTrayMenu() {
  pushAppStatus();
  if (!tray) return;
  const clients = bridge ? bridge.clientCount : 0;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ScamWhip', click: showAppWindow },
    { label: whipVisible ? 'Drop the whip' : 'Spawn the whip', click: toggleWhip },
    { type: 'separator' },
    {
      label: bridge?.listening
        ? `Bridge: ${clients} extension${clients === 1 ? '' : 's'} connected`
        : 'Bridge: not running',
      enabled: false
    },
    { label: `Copy pairing code (${pairingCode.slice(0, 4)}…)`, click: copyPairingCode },
    { label: 'Show pairing code…', click: showPairingDialog },
    { type: 'separator' },
    { label: 'Open config folder', click: openConfigFolder },
    { label: 'Edit whip.config.json', click: openConfigFile },
    { label: 'Reload config', click: () => { config = store.load(); overlay?.webContents.send('config', rendererConfig()); applyWindowConfig(); } },
    { type: 'separator' },
    {
      label: 'Click-through (whip ignores clicks)',
      type: 'checkbox',
      checked: !!config.window?.clickThrough,
      click: (item) => {
        config.window.clickThrough = item.checked;
        applyWindowConfig();
      }
    },
    { label: 'Test crack (no whip)', click: () => emitCrack({ strength: 1, tipSpeed: 0, source: 'tray-test' }) },
    {
      label: `Force-hide the overlay (${(config.controls?.panicHotkey || 'Control+Alt+W').replace('Control', 'Ctrl')})`,
      click: () => forceHide('tray menu')
    },
    { type: 'separator' },
    { label: 'Quit ScamWhip', click: () => { app.quit(); } }
  ]));
}

function trayImage() {
  for (const name of ['tray.png', 'appicon.png']) {
    const file = iconPath(name);
    if (!file) continue;
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) continue;
    return process.platform === 'darwin'
      ? image.resize({ width: 18, height: 18 })
      : name === 'appicon.png' ? image.resize({ width: 16, height: 16 }) : image;
  }

  log('WARNING: no usable tray icon in assets/ - the tray entry will be blank.');
  return nativeImage.createEmpty();
}

function iconPath(name) {
  const file = path.join(ASSETS, name);
  return fs.existsSync(file) ? file : '';
}

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba']);

function discoverSounds() {
  try {
    return fs.readdirSync(path.join(ASSETS, 'sounds'))
      .filter((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

function rendererConfig() {
  const copy = JSON.parse(JSON.stringify(config));
  copy.sound = copy.sound || {};
  copy.sound.available = discoverSounds();
  return copy;
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  hotkeyProblems = [];

  const claim = (accelerator, handler, what) => {
    if (!accelerator) return;
    let ok = false;
    try { ok = globalShortcut.register(accelerator, handler); } catch { ok = false; }
    if (ok) return;
    log(`could not register ${what} ${accelerator} - something else owns it`);
    hotkeyProblems.push({ accelerator, what });
  };

  claim(config.controls?.globalHotkey, toggleWhip, 'hotkey');
  claim(config.controls?.crackHotkeyFallback,
    () => emitCrack({ strength: 1, tipSpeed: 0, source: 'hotkey' }), 'crack hotkey');

  claim(config.controls?.panicHotkey, () => forceHide('panic hotkey'), 'panic hotkey');

  pushAppStatus();
}

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(sweepTimer);
  clearInterval(watchdogTimer);
  store?.unwatch();
  bridge?.stop();
});

async function startBridge() {
  if (config.bridge?.enabled === false) return;

  bridge = new BridgeServer({
    host: config.bridge?.host || '127.0.0.1',
    port: config.bridge?.port || 17311,
    token: config.bridge?.requireToken === false ? '' : pairingCode,
    allowUnauthenticated: !!config.bridge?.allowUnauthenticated
  });

  bridge.on('connection', (info) => {
    log(`extension connected (${info.name} v${info.version})`);
    pushBridgeStatus();
  });
  bridge.on('disconnection', () => pushBridgeStatus());
  bridge.on('rejected', () => {
    log('an extension was rejected - wrong pairing code. Copy it again from the tray menu.');
    pushBridgeStatus();
  });
  bridge.on('socket-error', (err) => log(`socket hiccup: ${err.code || err.message}`));
  bridge.on('message', (message) => {
    if (message.type === 'result') {
      overlay?.webContents.send('verdict', message);
      log(`result: ${message.verdict} (${message.flaggedCount} flagged)`);
    }
  });
  bridge.on('error', (err) => {
    const message = err.code === 'EADDRINUSE'
      ? `Port ${config.bridge.port} is already in use. Change bridge.port in whip.config.json, or close the other ScamWhip.`
      : err.message;
    log(`bridge error: ${message}`);
    dialog.showErrorBox('ScamWhip bridge', message);
    pushBridgeStatus();
  });

  try {
    const address = await bridge.start();
    log(`bridge listening on ${address.url}`);
    sweepTimer = setInterval(() => bridge.sweep(), 30000);
  } catch {

  }
  pushBridgeStatus();
}

function emitCrack(payload) {
  const message = {
    type: 'crack',
    id: `crack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    strength: clamp(payload.strength ?? 1, 0, 1),
    tipSpeed: payload.tipSpeed ?? 0,
    source: payload.source || 'whip'
  };
  const sent = bridge ? bridge.broadcast(message) : 0;
  log(`crack (strength ${message.strength.toFixed(2)}) -> ${sent} client(s)`);
  overlay?.webContents.send('crack-sent', { ...message, delivered: sent });
  return sent;
}

function bridgeStatus() {
  return {
    listening: !!bridge?.listening,
    clients: bridge?.clientCount || 0,
    url: bridge ? bridge.address().url : '',
    pairingCode,
    requiresToken: config.bridge?.requireToken !== false
  };
}

function pushBridgeStatus() {
  overlay?.webContents.send('bridge-status', bridgeStatus());
  updateTrayMenu();
}

function loadOrCreatePairingCode() {
  const file = path.join(app.getPath('userData'), 'pairing-code.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8) return existing;
  } catch {  }

  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('').slice(0, 16);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code, 'utf8');
  return code;
}

function copyPairingCode() {
  clipboard.writeText(pairingCode);
  log('pairing code copied to clipboard');
}

function showPairingDialog() {
  dialog.showMessageBox({
    type: 'info',
    title: 'ScamWhip pairing code',
    message: pairingCode,
    detail: `Paste this into the extension: ScamWhip dashboard → Whip & overlay → Pairing code.\n\nBridge: ${bridge ? bridge.address().url : 'not running'}`,
    buttons: ['Copy', 'Close'],
    defaultId: 0,
    noLink: true
  }).then(({ response }) => {
    if (response === 0) copyPairingCode();
  });
}

function openConfigFolder() {
  const file = store.ensureUserFile();
  shell.showItemInFolder(file || app.getPath('userData'));
}

function openConfigFile() {
  shell.openPath(store.ensureUserFile());
}

ipcMain.handle('app:status', () => appStatus());
ipcMain.handle('app:copy-pairing', () => { copyPairingCode(); return pairingCode; });
ipcMain.on('app:spawn', () => toggleWhip());
ipcMain.on('app:force-hide', () => forceHide('app window'));
ipcMain.on('app:test-crack', () => emitCrack({ strength: 1, tipSpeed: 0, source: 'app-window-test' }));
ipcMain.on('app:open-config-file', () => openConfigFile());
ipcMain.on('app:open-config-folder', () => openConfigFolder());
ipcMain.on('app:hide-window', () => appWindow?.hide());
ipcMain.on('app:quit', () => app.quit());

ipcMain.on('whip:crack', (_event, payload) => emitCrack(payload || {}));
ipcMain.on('whip:alive', () => { lastHeartbeat = Date.now(); });
ipcMain.on('whip:gone', () => hideWhip());
ipcMain.handle('config:get', () => rendererConfig());
ipcMain.handle('bridge:status', () => bridgeStatus());
ipcMain.handle('pairing:copy', () => { copyPairingCode(); return pairingCode; });

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function log(...args) { console.log('[ScamWhip]', ...args); }
