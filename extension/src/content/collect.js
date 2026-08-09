/**
 * ScamWhip page reader — injected on demand, never on page load.
 *
 * Goal: hand the backend the text a human actually sees, and nothing else.
 * That means:
 *   - no <script>/<style>/<template> contents
 *   - no display:none / visibility:hidden / opacity:0 / aria-hidden subtrees
 *   - no sr-only, no text parked at left:-9999px, no 0px fonts
 *   - no zero-width, control, variation-selector or Unicode "tag" characters
 *   - lookalike (Cyrillic/Greek) letters folded back to Latin
 *
 * Everything it strips is *counted* and reported in `signals`, because hidden
 * junk in a page is itself one of the strongest scam tells there is.
 *
 * Defines globalThis.__scamwhipCollect(options) and returns true so the
 * service worker can inject once, then call it with arguments.
 */
(() => {
  if (globalThis.__scamwhipCollect) return true;

  /* ---------------------------------------------------------------- */
  /* character tables                                                  */
  /* ---------------------------------------------------------------- */

  // Zero-width, soft hyphen, bidi controls, word joiner, BOM, Mongolian vowel sep.
  const ZERO_WIDTH_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
  // C0/C1 control characters, keeping \t \n \r.
  const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
  // Variation selectors + U+E0000..U+E007F "tag" chars (a favourite text-smuggling trick).
  const TAG_CHAR_RE = /[\uFE00-\uFE0F]|\uDB40[\uDC00-\uDFFF]/g;
  const EMOJI_RE = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u2B00-\u2BFF\uFE0F]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF]/g;
  // Exotic spaces: NBSP, Ogham, en/em quad family, narrow NBSP, medium math, ideographic.
  const EXOTIC_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

  /** Only characters that are visually identical to a Latin letter. */
  const HOMOGLYPHS = {
    // Cyrillic
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
    'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ԛ': 'Q', 'Ԝ': 'W',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's',
    'і': 'i', 'ј': 'j', 'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v',
    // Greek
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
    'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
    'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', 'κ': 'k', 'τ': 't', 'υ': 'u',
    'χ': 'x', 'γ': 'y', 'ε': 'e',
    // Misc lookalikes
    'ǀ': 'l', 'Ӏ': 'I', 'ԁ': 'd', 'ｅ': 'e'
  };
  const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE',
    'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'CANVAS',
    'SVG', 'MATH', 'AUDIO', 'VIDEO', 'TRACK', 'SOURCE', 'MAP', 'AREA',
    'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST', 'PROGRESS', 'METER'
  ]);

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'TD', 'TH', 'TR', 'UL', 'DETAILS', 'SUMMARY', 'DIALOG'
  ]);

  /* ---------------------------------------------------------------- */
  /* visibility                                                        */
  /* ---------------------------------------------------------------- */

  function makeVisibility(opts, signals) {
    const cache = new WeakMap();
    const docWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    const docHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    const margin = opts.offscreenMarginPx;

    /** @returns {''|'display'|'visibility'|'opacity'|'aria'|'tiny'|'offscreen'|'clipped'} */
    function reasonHidden(el) {
      if (cache.has(el)) return cache.get(el);

      let reason = '';
      const style = getComputedStyle(el);

      if (el.hasAttribute('hidden')) reason = 'display';
      else if (el.getAttribute('aria-hidden') === 'true') reason = 'aria';
      else if (style.display === 'none') reason = 'display';
      else if (style.visibility === 'hidden' || style.visibility === 'collapse') reason = 'visibility';
      else if (style.contentVisibility === 'hidden') reason = 'display';
      else if (parseFloat(style.opacity) === 0) reason = 'opacity';
      else if (parseFloat(style.fontSize) < opts.minFontSizePx) reason = 'tiny';
      else if (isClipped(style)) reason = 'clipped';
      else if (style.display !== 'contents') {
        const rects = el.getClientRects();
        if (rects.length === 0) {
          reason = 'display';
        } else {
          const r = el.getBoundingClientRect();
          if (r.width < 1 && r.height < 1 && style.overflow === 'hidden') {
            reason = 'clipped';
          } else {
            const left = r.left + window.scrollX;
            const top = r.top + window.scrollY;
            if (left + r.width < -margin || top + r.height < -margin ||
                left > docWidth + margin || top > docHeight + margin) {
              reason = 'offscreen';
            }
          }
        }
      }

      // A closed <details> keeps everything out of view except its <summary>.
      // Walk from the parent, so the <details> element itself stays walkable.
      if (!reason && el.parentElement) {
        const details = el.parentElement.closest('details:not([open])');
        if (details) {
          const summary = details.querySelector(':scope > summary');
          if (!summary || !(summary === el || summary.contains(el))) reason = 'display';
        }
      }

      cache.set(el, reason);
      return reason;
    }

    /** The sr-only / visually-hidden clip idiom. */
    function isClipped(style) {
      const clip = (style.clip || '').replace(/\s/g, '');
      if (clip === 'rect(0px,0px,0px,0px)' || clip === 'rect(1px,1px,1px,1px)') return true;
      const clipPath = (style.clipPath || '').replace(/\s/g, '');
      if (clipPath === 'inset(50%)' || clipPath === 'inset(100%)') return true;
      if (parseFloat(style.textIndent) <= -999) return true;
      return false;
    }

    return { reasonHidden };
  }

  /* ---------------------------------------------------------------- */
  /* walking                                                           */
  /* ---------------------------------------------------------------- */

  function collectFrom(root, opts, signals) {
    const vis = makeVisibility(opts, signals);
    /** @type {Array<{type:'text'|'break', value?:string}>} */
    const chunks = [];
    const links = [];
    const seenLinks = new Set();
    let hiddenSample = '';

    const pushBreak = () => {
      if (chunks.length && chunks[chunks.length - 1].type !== 'break') chunks.push({ type: 'break' });
    };

    function walk(node, depth) {
      if (depth > 200) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.nodeValue;
        if (!raw || !raw.trim()) return;
        chunks.push({ type: 'text', value: raw });
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = /** @type {Element} */ (node);
      const tag = el.tagName ? el.tagName.toUpperCase() : '';

      if (SKIP_TAGS.has(tag)) return;
      if (el.hasAttribute && el.hasAttribute('data-scamwhip-ui')) return; // our own HUD

      const hidden = vis.reasonHidden(el);
      if (hidden) {
        // Hidden text is not collected, but it IS evidence.
        const buried = (el.textContent || '').trim();
        if (buried.length > 12) {
          signals.hiddenTextBlocks += 1;
          signals.hiddenTextChars += buried.length;
          signals[`hidden_${hidden}`] = (signals[`hidden_${hidden}`] || 0) + 1;
          if (!hiddenSample) hiddenSample = buried.replace(/\s+/g, ' ').slice(0, 220);
        }
        return;
      }

      if (tag === 'BR') { pushBreak(); return; }
      if (tag === 'A' && opts.includeLinks) recordLink(el);

      const isBlock = BLOCK_TAGS.has(tag) || getComputedStyle(el).display.startsWith('block');
      if (isBlock) pushBreak();

      if (opts.pierceShadowDom && el.shadowRoot) {
        for (const child of el.shadowRoot.childNodes) walk(child, depth + 1);
      }
      for (const child of el.childNodes) walk(child, depth + 1);

      if (isBlock) pushBreak();
    }

    function recordLink(anchor) {
      if (links.length >= opts.maxLinks) return;
      const href = anchor.href || '';
      if (!href || href.startsWith('javascript:')) return;
      const label = clean((anchor.textContent || '').replace(/\s+/g, ' ').trim(), opts, signals).slice(0, 160);
      const key = `${label}|${href}`;
      if (seenLinks.has(key)) return;
      seenLinks.add(key);

      // Just the facts: what the link says and where it actually goes. Whether
      // that pairing is suspicious is the backend's call, not ours.
      links.push({ text: label, href: href.slice(0, 600) });
    }

    walk(root, 0);

    return { chunks, links, hiddenSample };
  }

  /* ---------------------------------------------------------------- */
  /* cleaning                                                          */
  /* ---------------------------------------------------------------- */

  function clean(input, opts, signals) {
    let s = input;

    if (opts.stripZeroWidth) {
      const before = s.length;
      s = s.replace(ZERO_WIDTH_RE, '');
      signals.zeroWidthRemoved += before - s.length;
    }
    if (opts.stripTagChars) {
      const before = s.length;
      s = s.replace(TAG_CHAR_RE, '');
      signals.tagCharsRemoved += before - s.length;
    }
    if (opts.stripControlChars) {
      const before = s.length;
      s = s.replace(CONTROL_RE, '');
      signals.controlCharsRemoved += before - s.length;
    }
    if (opts.normalizeUnicode) {
      // NFKC also folds the 𝓯𝓪𝓷𝓬𝔂 math-alphanumeric letters spam loves.
      try { s = s.normalize('NFKC'); } catch { /* older engine */ }
    }
    if (opts.normalizeHomoglyphs) {
      s = s.replace(HOMOGLYPH_RE, (ch) => {
        signals.homoglyphsNormalized += 1;
        return HOMOGLYPHS[ch] || ch;
      });
    }
    if (opts.stripEmoji) {
      const before = s.length;
      s = s.replace(EMOJI_RE, '');
      signals.emojiRemoved += before - s.length;
    }

    // Every flavour of exotic space becomes a plain space.
    s = s.replace(EXOTIC_SPACE_RE, ' ');
    return s;
  }

  function assemble(chunks, opts, signals) {
    let out = '';
    for (const chunk of chunks) {
      if (chunk.type === 'break') {
        if (out && !out.endsWith('\n')) out += '\n';
        continue;
      }
      let piece = clean(chunk.value, opts, signals);
      if (opts.collapseWhitespace) piece = piece.replace(/[ \t\r\f\v]+/g, ' ');
      if (!piece.trim()) {
        if (out && !out.endsWith(' ') && !out.endsWith('\n')) out += ' ';
        continue;
      }
      const needsSpace = out && !out.endsWith('\n') && !out.endsWith(' ') && !piece.startsWith(' ');
      out += (needsSpace ? ' ' : '') + piece;
    }

    let lines = out.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());

    if (opts.dedupeLines) {
      const seen = new Set();
      lines = lines.filter((line) => {
        if (!line) return true;
        // Short lines repeat legitimately ("Reply", "1", "$5") — only fold long ones.
        if (line.length < 24) return true;
        if (seen.has(line)) { signals.duplicateLinesRemoved += 1; return false; }
        seen.add(line);
        return true;
      });
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ---------------------------------------------------------------- */
  /* scope                                                             */
  /* ---------------------------------------------------------------- */

  function resolveRoot(opts) {
    const host = location.hostname;

    const trySelector = (selector) => {
      if (!selector) return null;
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch { return null; }
      const usable = nodes.filter((n) => (n.textContent || '').trim().length > 40);
      if (!usable.length) return null;
      if (usable.length === 1) return { root: usable[0], multi: null };
      return { root: null, multi: usable };
    };

    if (opts.scope === 'selector' && opts.customSelector) {
      const hit = trySelector(opts.customSelector);
      if (hit) return { ...hit, scope: 'selector' };
      return { root: document.body, multi: null, scope: 'page', note: 'custom selector matched nothing' };
    }

    if (opts.scope === 'auto' || opts.scope === 'email') {
      const key = Object.keys(opts.emailSelectors || {}).find((k) => host === k || host.endsWith(`.${k}`));
      if (key) {
        const hit = trySelector(opts.emailSelectors[key]);
        if (hit) return { ...hit, scope: 'email' };
      }
      if (opts.scope === 'email') {
        const generic = trySelector('[role="main"] article, article, [role="main"]');
        if (generic) return { ...generic, scope: 'email', note: 'generic main-content fallback' };
      }
    }

    return { root: document.body || document.documentElement, multi: null, scope: 'page' };
  }

  /* ---------------------------------------------------------------- */
  /* message headers                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Who sent it and what it claims to be about. The popup shows these, and
   * they are worth sending to the backend: a display name that says "PayPal"
   * over an address that does not is the whole scam in one line.
   */
  const HEADER_SELECTORS = {
    'mail.google.com': { from: '.gD, .go', subject: 'h2.hP' },
    'outlook.live.com': { from: '[automationid="senderPersona"], .OZZZK, [title*="@"]', subject: '[role="heading"][aria-level="2"]' },
    'outlook.office.com': { from: '[automationid="senderPersona"], .OZZZK, [title*="@"]', subject: '[role="heading"][aria-level="2"]' },
    'mail.yahoo.com': { from: '[data-test-id="message-from"]', subject: '[data-test-id="message-subject"]' },
    'mail.proton.me': { from: '.message-header .sender-name, .item-senddate-row', subject: '.message-header .text-ellipsis' },
    'app.fastmail.com': { from: '.v-Message-fromName', subject: '.v-Message-subject' }
  };

  function readHeaders(opts, signals) {
    const host = location.hostname;
    const key = Object.keys(HEADER_SELECTORS).find((k) => host === k || host.endsWith(`.${k}`));
    const selectors = { ...(HEADER_SELECTORS[key] || {}), ...(opts.headerSelectors?.[key] || {}) };

    const pick = (selector) => {
      if (!selector) return null;
      try { return document.querySelector(selector); } catch { return null; }
    };

    const fromEl = pick(selectors.from);
    const subjectEl = pick(selectors.subject);

    // Gmail and friends stash the real address in an attribute.
    let address = '';
    if (fromEl) {
      address = fromEl.getAttribute('email') || fromEl.getAttribute('title') || '';
      if (!/@/.test(address)) {
        const match = (fromEl.textContent || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
        address = match ? match[0] : '';
      }
    }

    const name = fromEl
      ? (fromEl.getAttribute('name') || (fromEl.textContent || '').replace(address, '').replace(/[<>]/g, '').trim())
      : '';

    return {
      from: clean(name, opts, signals).slice(0, 120) || location.hostname,
      fromAddress: address.slice(0, 200),
      subject: clean(subjectEl ? subjectEl.textContent || '' : document.title, opts, signals).replace(/\s+/g, ' ').trim().slice(0, 300),
      isEmail: !!key
    };
  }

  /* ---------------------------------------------------------------- */
  /* entry point                                                       */
  /* ---------------------------------------------------------------- */

  globalThis.__scamwhipCollect = function collect(options) {
    const opts = Object.assign({
      scope: 'auto',
      customSelector: '',
      emailSelectors: {},
      maxChars: 24000,
      minFontSizePx: 5,
      offscreenMarginPx: 2000,
      includeLinks: true,
      maxLinks: 120,
      stripZeroWidth: true,
      stripControlChars: true,
      stripTagChars: true,
      normalizeUnicode: true,
      normalizeHomoglyphs: true,
      collapseWhitespace: true,
      dedupeLines: true,
      stripEmoji: false,
      pierceShadowDom: true
    }, options || {});

    const started = performance.now();
    const signals = {
      zeroWidthRemoved: 0,
      controlCharsRemoved: 0,
      tagCharsRemoved: 0,
      homoglyphsNormalized: 0,
      emojiRemoved: 0,
      duplicateLinesRemoved: 0,
      hiddenTextBlocks: 0,
      hiddenTextChars: 0
    };

    try {
      const target = resolveRoot(opts);
      const roots = target.multi || [target.root];

      let chunks = [];
      let links = [];
      let hiddenSample = '';

      for (const root of roots) {
        if (!root) continue;
        const part = collectFrom(root, opts, signals);
        if (chunks.length) chunks.push({ type: 'break' });
        chunks = chunks.concat(part.chunks);
        links = links.concat(part.links).slice(0, opts.maxLinks);
        if (!hiddenSample) hiddenSample = part.hiddenSample;
      }

      let text = assemble(chunks, opts, signals);
      const fullLength = text.length;
      const truncated = fullLength > opts.maxChars;
      if (truncated) text = `${text.slice(0, opts.maxChars)}\n…[truncated by ScamWhip at ${opts.maxChars} characters]`;

      if (hiddenSample) signals.hiddenTextSample = hiddenSample;

      return {
        ok: true,
        url: location.href,
        title: document.title || '',
        headers: readHeaders(opts, signals),
        capturedAt: new Date().toISOString(),
        scope: target.scope,
        scopeNote: target.note || '',
        text,
        chars: text.length,
        fullChars: fullLength,
        truncated,
        links: opts.includeLinks ? links : [],
        signals,
        tookMs: Math.round(performance.now() - started)
      };
    } catch (err) {
      return {
        ok: false,
        error: `Page read failed: ${err && err.message ? err.message : String(err)}`,
        url: location.href,
        title: document.title || '',
        capturedAt: new Date().toISOString(),
        text: '',
        chars: 0,
        links: [],
        signals
      };
    }
  };

  return true;
})();
