/**
 * Every knob in ScamWhip lives here.
 *
 * Nothing else in the extension hard-codes a threshold, a URL or a field name —
 * if you want to change behaviour, change a default here or edit it live in the
 * dashboard (index.html), which writes to chrome.storage.local under STORAGE_KEY.
 */
import { deepMerge, clone } from './util.js';

export const STORAGE_KEY = 'scamwhip.settings';
export const STATE_KEY = 'scamwhip.state';

/**
 * Bump this whenever a stored setting changes meaning, and add a migration.
 *
 * Settings are merged as deepMerge(DEFAULTS, stored) — *stored wins*. That is
 * correct (your choices should survive an update) but it means changing a
 * default does nothing for anyone who already has the extension installed:
 * they keep the old value forever, silently. Migrations are how a default
 * actually reaches an existing install.
 */
export const SETTINGS_VERSION = 3;

export const DEFAULTS = {
  /** Stamped so an existing install can be brought forward — see MIGRATIONS. */
  settingsVersion: SETTINGS_VERSION,

  /** ------------------------------------------------------------------
   *  Backend — the scam-detection API you (or someone else) will write.
   *  ScamWhip never ships a backend; it just talks to one.
   *  ------------------------------------------------------------------ */
  backend: {
    /** 'live' → send captures to `endpoint`
     *  'off'  → capture text but never send it anywhere
     *
     *  There is deliberately no local-analysis mode. The extension scans and
     *  sends; every verdict and every flag you see came from a backend. */
    mode: 'live',

    endpoint: 'https://emote-galore-panther.ngrok-free.dev/request',
    method: 'POST',

    /** Auth. Leave apiKey empty to send no auth header at all.
     *  authScheme '' sends the raw key, which is what X-Token wants. */
    authHeader: 'X-Token',
    authScheme: '',
    apiKey: '',

    /** Some backends mint a token for you. If set, the dashboard's
     *  "Get a token" button POSTs here (resolved against the endpoint's
     *  origin) and stores whatever it finds at `registerTokenPath`. */
    registerPath: '/register',
    registerTokenPath: 'token',

    /** This backend is a general-purpose model, not a scam classifier, so the
     *  request has to say what we want. The page text is substituted for
     *  {{text}}; {{url}}, {{title}}, {{from}} and {{subject}} also work.
     *  Set to '' to send the raw text with no instructions. */
    promptTemplate: [
      'You are a scam and phishing detector. Analyse the message below and reply with',
      'ONLY a JSON object, no prose, no code fences, in exactly this shape:',
      '{"verdict":"scam|suspicious|clean","score":0.0,"summary":"one sentence",',
      '"flagged":[{"text":"the exact wording","reason":"why it is a problem","severity":"high|medium|low"}]}',
      '',
      'Report only what is actually in the message. If nothing is wrong, return an empty flagged list.',
      '',
      '--- MESSAGE ---',
      'From: {{from}}',
      'Subject: {{subject}}',
      'URL: {{url}}',
      '',
      '{{text}}'
    ].join('\n'),

    /** When the real answer arrives as a JSON string inside a field, name it
     *  here and that field is parsed before the mapping below is applied. */
    responseJsonPath: 'answer',

    /** Envelope flag meaning "even the best model wasn't confident". */
    unsurePath: 'unsure',

    /** Anything extra you need, e.g. {"X-Tenant": "ryser"} */
    headers: {},

    timeoutMs: 20000,
    retries: 1,
    retryBackoffMs: 800,

    /** Rename the outgoing JSON fields to match your API. Set a value to ''
     *  to omit that field from the request body entirely. */
    requestFields: {
      text: 'text',
      url: 'url',
      title: 'title',
      capturedAt: 'capturedAt',
      source: 'source',
      links: 'links',
      signals: 'signals',
      meta: 'meta'
    },

    /** Merged into the request body verbatim — good for {"model": "..."} etc. */
    extraBody: {},

    /** Where to find things in YOUR response. Each entry accepts a single dot
     *  path or an array of fallbacks; the first one that exists wins. */
    responseMap: {
      verdict: ['verdict', 'result.verdict', 'data.verdict', 'label'],
      score: ['score', 'result.score', 'data.score', 'confidence'],
      summary: ['summary', 'result.summary', 'data.summary', 'explanation', 'message'],
      flagged: ['flagged', 'flags', 'result.flagged', 'data.flagged', 'findings', 'matches'],
      /** ...and how to read one item inside that flagged array: */
      itemText: ['text', 'snippet', 'excerpt', 'match', 'value'],
      itemReason: ['reason', 'why', 'explanation', 'description', 'rule'],
      itemSeverity: ['severity', 'level', 'risk'],
      itemStart: ['start', 'offset', 'range.start'],
      itemEnd: ['end', 'range.end']
    },

    /** Map your verdict strings onto ScamWhip's four buckets. */
    verdictAliases: {
      scam: ['scam', 'malicious', 'phishing', 'fraud', 'danger', 'high'],
      suspicious: ['suspicious', 'warning', 'caution', 'medium', 'unsure'],
      clean: ['clean', 'safe', 'ok', 'benign', 'legit', 'low', 'none']
    },

    /** If the backend sends no verdict, derive one from `score` (0..1). */
    scoreThresholds: { scam: 0.75, suspicious: 0.4 }
  },

  /** ------------------------------------------------------------------
   *  Capture — what "visible text" means, exactly.
   *  ------------------------------------------------------------------ */
  capture: {
    /** 'auto'     → use the email-body selector for known mail sites, else page
     *  'page'     → always the whole document
     *  'email'    → only the email body (fails over to page)
     *  'selector' → only `customSelector` */
    scope: 'auto',
    customSelector: '',

    /** Site → CSS selector for "the thing I'm actually reading". */
    emailSelectors: {
      'mail.google.com': '.a3s, .ii.gt, [role="listitem"][aria-expanded="true"]',
      'outlook.live.com': '[role="document"], .allowTextSelection',
      'outlook.office.com': '[role="document"], .allowTextSelection',
      'outlook.office365.com': '[role="document"], .allowTextSelection',
      'mail.yahoo.com': '[data-test-id="message-view-body-content"]',
      'mail.proton.me': '.message-content, iframe.protonmail_quote',
      'app.fastmail.com': '.v-Message-body',
      'mail.zoho.com': '.zmPreviewBody'
    },

    maxChars: 24000,
    minFontSizePx: 5,          // anything smaller counts as invisible
    offscreenMarginPx: 2000,   // further outside the viewport than this = hidden

    includeLinks: true,
    maxLinks: 120,

    /** Text hygiene. All of these only affect the `text` we send — the counts
     *  of what was stripped are still reported in `signals`, because hidden
     *  junk is itself a scam signal worth sending to the backend. */
    stripZeroWidth: true,
    stripControlChars: true,
    stripTagChars: true,         // U+E0000..E007F "tag" chars used to smuggle text
    normalizeUnicode: true,      // NFC
    normalizeHomoglyphs: true,   // Cyrillic/Greek lookalikes → Latin
    collapseWhitespace: true,
    dedupeLines: true,
    stripEmoji: false,

    /** Read text out of open shadow roots too (most web components). */
    pierceShadowDom: true
  },

  /** ------------------------------------------------------------------
   *  Bridge — the local WebSocket the overlay app talks on.
   *  ------------------------------------------------------------------ */
  bridge: {
    enabled: true,
    url: 'ws://127.0.0.1:17311',
    token: '',                 // pairing code from the overlay tray menu
    autoReconnect: true,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
    heartbeatSec: 25
  },

  /** ------------------------------------------------------------------
   *  UI / behaviour
   *  ------------------------------------------------------------------ */
  ui: {
    scanOnCrack: true,
    minCrackStrength: 0,       // ignore limp cracks below this (0..1)
    showHud: true,             // in-page result panel
    hudPosition: 'bottom-right',
    hudAutoHideMs: 0,          // 0 = stay until dismissed
    notifications: true,
    badge: true,
    theme: 'dark'
  },

  /** ------------------------------------------------------------------
   *  Privacy
   *  ------------------------------------------------------------------ */
  privacy: {
    /** If non-empty, ONLY these hosts may ever be scanned. */
    allowlist: [],
    /** Never scanned, even on an explicit crack. */
    blocklist: ['*.bank', 'accounts.google.com', 'login.microsoftonline.com'],
    /** Keep the captured text in local storage for the dashboard's preview. */
    keepLastCapture: true,
    historyLimit: 25
  }
};

/** Endpoints that were only ever a placeholder — safe to move off. */
const PLACEHOLDER_ENDPOINTS = [
  'http://127.0.0.1:8080/api/v1/scan',
  'https://example.com/api/v1/scan',
  'https://api.example.com/v1/scan'
];

const MIGRATIONS = {
  /** v1 → v2: mock mode was removed, and the default backend changed. */
  2(settings) {
    const backend = settings.backend || (settings.backend = {});
    let clearResults = false;

    // Mock mode no longer exists. Anything left on it was showing canned
    // results that came from the extension itself, so those have to go too.
    if (backend.mode === 'mock') {
      backend.mode = 'live';
      clearResults = true;
    }

    // Only move an endpoint that was never really chosen.
    if (!backend.endpoint || PLACEHOLDER_ENDPOINTS.includes(backend.endpoint)) {
      backend.endpoint = DEFAULTS.backend.endpoint;
      backend.authHeader = DEFAULTS.backend.authHeader;
      backend.authScheme = DEFAULTS.backend.authScheme;
      backend.apiKey = '';
    }

    return { settings, clearResults };
  },

  /** v2 → v3: the endpoint field was removed from the dashboard, so nothing
   *  can set backend.endpoint by hand any more — it should just be the
   *  default. Anyone who blanked it out (or never filled it in) while the
   *  field still existed is stuck on '' forever otherwise, since deepMerge
   *  favours whatever's already stored over DEFAULTS. */
  3(settings) {
    const backend = settings.backend || (settings.backend = {});
    if (!backend.endpoint) {
      backend.endpoint = DEFAULTS.backend.endpoint;
    }
    return { settings, clearResults: false };
  }
};

/** Settings as stored + defaults filled in, migrated if they are from an older build. */
export async function loadConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const saved = stored[STORAGE_KEY];
  if (!saved) return clone(DEFAULTS);

  const from = saved.settingsVersion || 1;
  if (from >= SETTINGS_VERSION) return deepMerge(DEFAULTS, saved);

  let settings = clone(saved);
  let clearResults = false;
  for (let v = from + 1; v <= SETTINGS_VERSION; v++) {
    if (!MIGRATIONS[v]) continue;
    const out = MIGRATIONS[v](settings);
    settings = out.settings;
    clearResults = clearResults || out.clearResults;
  }
  settings.settingsVersion = SETTINGS_VERSION;

  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  if (clearResults) {
    const state = await chrome.storage.local.get(STATE_KEY);
    const current = state[STATE_KEY] || {};
    await chrome.storage.local.set({
      [STATE_KEY]: { ...current, lastResult: null, lastCapture: null, history: [] }
    });
  }
  console.info(`[ScamWhip] settings migrated v${from} → v${SETTINGS_VERSION}`);

  return deepMerge(DEFAULTS, settings);
}

/** Shallow-path deep merge: pass a partial object, get the merged result back. */
export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = deepMerge(current, patch);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Overwrite everything (used by "Import settings"). */
export async function replaceConfig(full) {
  const next = deepMerge(DEFAULTS, full || {});
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function resetConfig() {
  await chrome.storage.local.set({ [STORAGE_KEY]: clone(DEFAULTS) });
  return clone(DEFAULTS);
}

/** Ephemeral runtime state (last result, bridge status, history). */
export async function loadState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || {
    bridge: { status: 'disconnected', lastEventAt: 0, lastError: '' },
    lastResult: null,
    lastCapture: null,
    history: [],
    scanning: false
  };
}

export async function saveState(patch) {
  const current = await loadState();
  const next = deepMerge(current, patch);
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}
