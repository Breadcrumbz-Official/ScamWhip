
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const BUNDLED_PATH = path.join(__dirname, '..', '..', 'config', 'whip.config.json');

class ConfigStore extends EventEmitter {
  constructor(userDir) {
    super();
    this.userDir = userDir;
    this.userPath = userDir ? path.join(userDir, 'whip.config.json') : null;
    this.bundledPath = BUNDLED_PATH;
    this.current = {};
    this.watchers = [];
    this.reloadTimer = null;
    this.error = '';
  }

  load() {

    this.error = '';
    const bundled = readJson(this.bundledPath, {}, (message) => { this.error = message; });
    const user = this.userPath ? readJson(this.userPath, {}, (message) => { this.error = message; }) : {};
    this.current = deepMerge(bundled, user);
    stripComments(this.current);
    return this.current;
  }

  get() {
    return this.current && Object.keys(this.current).length ? this.current : this.load();
  }

  watch() {
    this.unwatch();
    for (const file of [this.bundledPath, this.userPath].filter(Boolean)) {
      try {
        const watcher = fs.watch(path.dirname(file), (_event, filename) => {
          if (filename && path.basename(file) !== filename) return;
          clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => {
            const before = JSON.stringify(this.current);
            const after = this.load();
            if (JSON.stringify(after) !== before) this.emit('change', after);
          }, 150);
        });
        this.watchers.push(watcher);
      } catch (err) {

        if (err.code !== 'ENOENT') console.warn('[ScamWhip] cannot watch', file, err.message);
      }
    }
  }

  unwatch() {
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch {  }
    }
    this.watchers = [];
  }

  ensureUserFile() {
    if (!this.userPath) return null;
    if (!fs.existsSync(this.userPath)) {
      fs.mkdirSync(path.dirname(this.userPath), { recursive: true });
      fs.writeFileSync(this.userPath, JSON.stringify({
        '//': 'Anything you put here overrides config/whip.config.json. Only include what you want to change.',
        appearance: { skin: 'default' }
      }, null, 2), 'utf8');
    }
    return this.userPath;
  }
}

function readJson(file, fallback, onError) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const message = `${path.basename(file)} is not valid JSON (${err.message}) — it is being ignored entirely.`;
      console.error(`[ScamWhip] ${message}`);
      onError?.(message);
    }
    return fallback;
  }
}

function deepMerge(base, patch) {
  if (!isObject(base)) return clone(patch);
  const out = clone(base);
  if (!isObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function stripComments(node) {
  if (!isObject(node)) return;
  delete node['//'];
  for (const value of Object.values(node)) stripComments(value);
}

function isObject(v) { return Object.prototype.toString.call(v) === '[object Object]'; }
function clone(v) { return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)); }

module.exports = { ConfigStore, BUNDLED_PATH };
