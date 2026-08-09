/**
 * WebSocket client that listens to the desktop overlay app.
 *
 * The overlay owns the server (ws://127.0.0.1:17311). The extension is the
 * client: it connects, authenticates with the pairing code, and waits for
 * `crack` messages. Protocol lives in docs/PROTOCOL.md.
 *
 * MV3 note: an open WebSocket with traffic on it keeps the service worker
 * alive (Chrome 116+). The heartbeat below plus the keepalive alarm in the
 * service worker cover the gaps.
 */

export const PROTOCOL_VERSION = 1;

export class BridgeClient {
  constructor() {
    this.socket = null;
    this.config = null;
    this.status = 'disconnected';   // disconnected | connecting | connected | error
    this.lastError = '';
    this.attempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.manuallyClosed = false;

    /** Consumers assign these. */
    this.onCrack = () => {};
    this.onStatus = () => {};
    this.onMessage = () => {};
  }

  configure(bridgeConfig) {
    const changed = JSON.stringify(this.config) !== JSON.stringify(bridgeConfig);
    this.config = bridgeConfig;
    if (changed) this.reconnectNow();
  }

  connect() {
    if (!this.config || !this.config.enabled) {
      this.setStatus('disconnected', 'Bridge disabled in settings.');
      return;
    }
    // Already told "no" by this overlay — wait for a new code rather than
    // hammering it. reconnectNow() (settings change, or the Reconnect button)
    // clears this.
    if (this.status === 'unauthorized') return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.manuallyClosed = false;
    this.setStatus('connecting');

    let url;
    try {
      url = new URL(this.config.url);
      if (this.config.token) url.searchParams.set('token', this.config.token);
      url.searchParams.set('client', 'extension');
      url.searchParams.set('v', String(PROTOCOL_VERSION));
    } catch {
      this.setStatus('error', `Invalid bridge URL: ${this.config.url}`);
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url.toString());
    } catch (err) {
      this.setStatus('error', `Could not open socket: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    // Every handler below checks that it still belongs to the current socket.
    // reconnectNow() closes the old one and opens a new one immediately, but a
    // WebSocket's close event lands a tick later — by which time the *new*
    // socket is live. Without this guard the dead socket's close handler
    // reports the fresh connection as disconnected and schedules a reconnect
    // against it, so every settings change left a stray timer behind.
    const current = () => this.socket === socket;

    socket.addEventListener('open', () => {
      if (!current()) return;
      this.attempts = 0;
      this.setStatus('connected');
      this.send({ type: 'hello', client: 'extension', version: manifestVersion() });
      this.startHeartbeat();
    });

    socket.addEventListener('message', (event) => {
      if (!current()) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'crack':
          this.onCrack(msg);
          break;
        case 'ping':
          this.send({ type: 'pong', ts: Date.now() });
          return;
        case 'hello':
        case 'pong':
          // Keepalive chatter. onStatus writes to chrome.storage and wakes
          // every open popup, so firing it on a pong every 25 seconds costs
          // real work to report that nothing happened.
          return;
        default:
          this.onMessage(msg);
      }
      this.onStatus(this.snapshot());
    });

    socket.addEventListener('close', (event) => {
      if (!current()) return;
      this.stopHeartbeat();
      if (this.manuallyClosed) {
        this.setStatus('disconnected');
        return;
      }
      // 4401 is our "bad pairing code" close code. Retrying a wrong code just
      // spams the overlay forever, so stop and say so — a settings change or a
      // manual reconnect will start us again.
      if (event.code === 4401) {
        this.setStatus('unauthorized',
          'The overlay rejected this pairing code. Right-click the tray icon → Show pairing code, then paste it again.');
        return;
      }
      this.setStatus('disconnected', `Overlay closed the connection (code ${event.code}).`);
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (!current()) return;
      // The close handler runs right after and carries the useful info.
      this.lastError = 'Could not reach the overlay app. Is it running?';
    });
  }

  reconnectNow() {
    clearTimeout(this.reconnectTimer);
    this.attempts = 0;
    if (this.status === 'unauthorized') this.status = 'disconnected'; // give the new code a chance
    if (this.socket) {
      this.manuallyClosed = true;
      try { this.socket.close(1000, 'reconnecting'); } catch { /* ignore */ }
      this.socket = null;
    }
    this.connect();
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...payload }));
      return true;
    } catch {
      return false;
    }
  }

  /** Tell the overlay how a scan went so the whip can react. */
  sendResult(result, meta = {}) {
    return this.send({
      type: 'result',
      requestId: meta.requestId || null,
      verdict: result.verdict,
      score: result.score,
      flaggedCount: (result.flagged || []).length,
      summary: (result.summary || '').slice(0, 400),
      ok: !!result.ok,
      error: result.error || null,
      url: meta.url || null
    });
  }

  sendStatus(state, detail = {}) {
    return this.send({ type: 'status', state, ...detail });
  }

  scheduleReconnect() {
    if (!this.config?.enabled || !this.config?.autoReconnect || this.manuallyClosed) return;
    clearTimeout(this.reconnectTimer);
    const min = this.config.reconnectMinMs ?? 1000;
    const max = this.config.reconnectMaxMs ?? 30000;
    const delay = Math.min(max, min * Math.pow(1.7, this.attempts)) * (0.85 + Math.random() * 0.3);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    const secs = this.config?.heartbeatSec ?? 25;
    this.heartbeatTimer = setInterval(() => this.send({ type: 'ping' }), secs * 1000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  setStatus(status, error = '') {
    this.status = status;
    if (error) this.lastError = error;
    if (status === 'connected') this.lastError = '';
    this.onStatus(this.snapshot());
  }

  snapshot() {
    return {
      status: this.status,
      lastError: this.lastError,
      attempts: this.attempts,
      url: this.config?.url || '',
      lastEventAt: Date.now()
    };
  }
}

function manifestVersion() {
  try { return chrome.runtime.getManifest().version; } catch { return '0.0.0'; }
}
