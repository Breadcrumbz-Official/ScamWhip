# ScamWhip

Crack a physics whip on your desktop and the browser extension reads the visible
text of whatever you're looking at, sends it to your scam-detection backend, and
shows you what got flagged.

Two pieces that talk over a local WebSocket:

```
  overlay-app  ──ws://127.0.0.1:17311──▶  extension  ──HTTPS──▶  your backend
   (Electron)         "crack!"           (Chrome MV3)              (you write this)
        ▲                                      │
        └──────────── verdict ─────────────────┘
```

---

## Layout

```
ScamWhip/
├── extension/                 Chrome MV3 extension
│   ├── manifest.json
│   ├── index.html             dashboard / options page
│   ├── popup/                 the toolbar popup
│   ├── pages/                 dashboard css + js
│   ├── assets/icons/          toolbar icons
│   └── src/
│       ├── background/        service worker — orchestrates everything
│       ├── content/           collect.js (page reader), hud.js (result panel)
│       └── lib/               config, backend client, bridge client, helpers
│
├── overlay-app/               Electron overlay
│   ├── config/whip.config.json     every physics/appearance/sound knob
│   ├── assets/skins/               default/ and neon/ — drop your own art here
│   ├── assets/sounds/              optional custom crack recordings
│   └── src/
│       ├── main/              windows, tray, hotkeys, WebSocket server
│       └── renderer/
│           ├── app-window.*   the ordinary app window (status, pairing code)
│           └── whip/          physics.js, render.js, audio.js, skin.js, app.js
│
├── tools/
│   ├── preview-server.js      run the whip in a normal browser, no Electron
│   ├── bridge-sim.js          run the bridge alone, fire test cracks
│   ├── selftest.js            headless tests for physics + bridge + extension
│   ├── physics-bench.js       scripted gestures → crack strength vs. chatter
│   ├── test-page.html         fixture proving the reader skips invisible text
│   ├── popup-preview.html     the popup in six states, with a stubbed chrome API
│   ├── dashboard-preview.html the dashboard, likewise
│   ├── hud-preview.html       the in-page result panel, over a fake email
│   └── app-window-preview.html the desktop app window, likewise
│
└── docs/
    ├── BACKEND_API.md         the request/response contract — read this first
    ├── PROTOCOL.md            overlay ↔ extension messages
    └── CUSTOMIZATION.md       skins, physics tuning, sounds, controls
```

---

## Setup

### 1. The extension

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Pin it, click it — you should see *"Crack your whip to check for scam"*
   stamped on a sheet of paper, with the sender and subject of whatever you are
   reading above it and the flags below

The extension does **no analysis of its own**. It reads the page, sends the
text, and renders the reply — every verdict and every flag you see came from a
backend. Until yours exists it will report connection errors, which is the
honest behaviour; `docs/BACKEND_API.md` has a 20-line stub server to point it
at in the meantime.

### 2. The overlay app

```bash
cd overlay-app
npm install
npm start
```

The ScamWhip window opens and a whip icon appears in the tray. Closing the
window leaves it running in the tray; **Quit ScamWhip** in the window's footer
or the tray menu actually exits.

### 3. Pair them

1. ScamWhip window → **Copy** next to the pairing code (or tray → **Copy pairing code**)
2. Extension → gear icon → paste into **Pairing code**
3. The popup's **Overlay** chip turns green, and the app window stamps **PAIRED**

### 4. Get a checker token

It ships pointed at the Escalating Gemini API. Dashboard → **Get a token** and
you're done — tokens last 24 hours, so press it again whenever inspections start
failing.

To use something else, change the address in **Setup**.
[`docs/BACKEND_API.md`](docs/BACKEND_API.md) has the full contract, the three
settings that adapt ScamWhip to a general-purpose model, and a 20-line stub
server to develop against.

---

## Using it

| Do this | And |
|---|---|
| Click the tray icon (or `Ctrl+Shift+W`) | the whip spawns at your pointer |
| Move the mouse | the handle follows, the lash trails behind |
| Flick hard | the tip goes supersonic — **crack** → the page gets scanned |
| Click | you drop the whip; it falls off screen and the overlay hides |
| `Esc` | put it away immediately |
| `Ctrl+Alt+W` | panic key — hides the overlay instantly, whatever state it is in |

While the whip is out, the overlay covers the screen and swallows clicks (that
is how clicking drops it). It can never get stuck there: a watchdog hides it if
the renderer stops responding, a hard 60-second ceiling applies, the panic
hotkey always works, and the tray has a **Force-hide the overlay** item. Prefer
it never to capture clicks at all? Set `window.clickThrough: true`.

Same controls as [OpenWhip](https://github.com/GitFrog1111/OpenWhip), which this
whip's feel and tuning constants are modelled on.

No whip? The extension works on its own: click it and press **Scan this page
now**, or hit `Ctrl+Shift+Y`, or right-click a page → *Scan this page with
ScamWhip*.

Results land in four places — the toolbar badge, a desktop notification, a
panel on the page itself (with the flagged phrases highlighted in place), and a
verdict toast on the overlay that tints the whip red, amber or green.

---

## What actually gets sent

Only what a human can see. The reader walks the DOM and drops:

- `<script>`, `<style>`, `<template>`, `<noscript>`, `<svg>` contents
- `display:none`, `visibility:hidden`, `opacity:0`, `aria-hidden` subtrees
- screen-reader-only clips, `left:-9999px`, 0px fonts, closed `<details>` bodies
- zero-width characters, control characters, Unicode tag characters (U+E0000–E007F)
- Cyrillic and Greek letters posing as Latin ones — folded back, then NFKC

It reads open shadow roots, keeps block structure as newlines, and on Gmail /
Outlook / Proton / Yahoo / Fastmail / Zoho it reads **only the open email body**
rather than the whole app.

Everything it strips is *counted* and sent alongside the text as `signals`,
because hidden text is one of the strongest phishing tells there is. A page with
nine invisible blocks and eight lookalike letters is suspicious before you read a
word of it.

Nothing is captured until you crack the whip or press a button — there is no
content script running on any page before that moment. Hosts on the
`privacy.blocklist` (dashboard → Advanced) are never read at all.

---

## Development

```bash
node tools/selftest.js        # 41 headless checks: physics, bridge, wiring
node tools/physics-bench.js   # gesture bench: does it crack, does it chatter
node tools/preview-server.js  # tune the whip in a browser, no Electron needed
node tools/bridge-sim.js      # the bridge alone — press Enter to fire a crack
```

`physics-bench.js` replays scripted gestures against the real solver and reports
peak tip speed and crack count against two instability measures. Use it before
touching `physics.js` — the solver is chaotic enough that changes which sound
obviously right routinely measure worse. `--set physics.iterations=40` tries a
value without editing the config.

`preview-server.js` also serves `tools/test-page.html`, a fixture full of hidden
text, zero-width splits, homoglyphs and a spoofed link. Press its button to run
21 assertions against the real extractor in a real browser. It serves the four
UI previews too, so every surface can be checked without loading the extension
or launching Electron.

### Packaging

```bash
cd overlay-app
npm run dist
```

Puts a Windows installer and a portable single-file build in `overlay-app/dist/`:

| File | What it is |
|---|---|
| `ScamWhip Setup <version>.exe` | NSIS installer — pick a folder, gets shortcuts |
| `ScamWhip-<version>-portable.exe` | run it as-is, installs nothing |

`npm run pack` builds `dist/win-unpacked/` without wrapping it, which is faster
when you only want to check that a packaged build starts.

Both config files hot-reload: edit `overlay-app/config/whip.config.json` while
the whip is on screen and it changes as you save.

---

## Customising

Detail in [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md). The short version:

- **Whip art** — copy `assets/skins/default/`, swap the SVGs, set
  `appearance.skin`. Every image is optional; missing ones fall back to vectors.
- **Feel** — `physics` (44 segments, taper, gravity, damping, bend limits) and
  `physics.handle` (a damped angular spring driven by mouse velocity).
- **Crack difficulty** — `crack.tipSpeed`, default 200 px/frame. Raise it if
  cracks go off by accident, lower it if they are hard to land. Turn on
  `hud.showDebug` to watch live tip speed against the threshold.
- **Sound** — synthesised per crack from three layers by default, or drop your
  own `.wav`s into `assets/sounds/`.
- **What gets read** — dashboard → *Advanced*: `capture.scope`, per-site
  selectors, and every stripping rule individually switchable.
- **Backend shape** — dashboard → *Advanced*: rename every outgoing field, and
  map your response with dot paths so you never have to change your API.

---

## Notes

- The overlay window is transparent, always-on-top and skips the taskbar. While
  the whip is out it captures clicks (that's how you drop it); set
  `window.clickThrough: true` to let clicks pass through to whatever is below.
- The pairing code is generated on first run and stored in the app's userData
  folder. Set `bridge.requireToken: false` to skip auth on a trusted machine.
- The bridge server is dependency-free — `overlay-app` needs only Electron.
- MV3 service workers get evicted; WebSocket traffic plus a 30-second alarm keep
  it alive, and the extension reconnects with backoff whenever the app restarts.

## Licence

MIT.
