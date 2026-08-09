# ScamWhip

Crack a whip. Catch a scam. Yes, really.

Somewhere between "phishing detector" and "Indiana Jones cosplay," ScamWhip
puts a physics-simulated bullwhip on your desktop and a Chrome extension in
your browser. See something sus in your inbox? Don't report it like a
coward — **whip it.** The crack triggers a scan of whatever you're reading,
checks it against an AI backend, and stamps a verdict right onto the page:
clean, suspicious, or full-blown scam, flags included, no keyboard required.

It is, unfortunately, a fully functional scam detector wearing a whip as a
UI. We're as surprised as you are.

Under the hood it's two programs having a very fast, very local
conversation: a desktop overlay app that renders the whip and feels the
crack, and a browser extension that reads the page and shows you the
verdict. One WebSocket, zero cloud dependency between them, and an
unreasonable amount of effort spent making rope physics not explode.

---

## Setup instructions (for judges, the impatient, and the mildly suspicious)

You need two things running: the browser extension, and the desktop app.
Takes about 3 minutes. No account creation, no payment info, nothing scary.

### Step 1 — Get the code

Download/unzip this repo somewhere you'll remember. That's it, that's the step.

### Step 2 — Install the browser extension

1. Open Chrome (or any Chromium browser — Edge, Brave, etc. all work the same way).
2. Go to `chrome://extensions` in the address bar.
3. Flip on **Developer mode** — it's a toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the `extension` folder from this repo (the whole folder, not a file inside it).
6. It should now show up in your extensions list as **ScamWhip**. Pin it to your
   toolbar (click the puzzle-piece icon → the pin next to ScamWhip) so you can
   actually find it later.

### Step 3 — Get an access token (already pre-wired, just needs a key)

The extension ships already pointed at a live AI backend — you don't need to
build or deploy anything. You just need a token so it'll talk to you.

1. Click the ScamWhip icon in your toolbar, then open the **dashboard** (there's
   a link/button for it in the popup).
2. Find the **Get a token** button and click it.
3. That's it — it mints you a working token automatically and plugs it in.
   Tokens are good for 24 hours, so if things stop working tomorrow, just click
   it again.

### Step 4 — Install and run the desktop overlay app

This is the part that actually draws the whip.

1. Make sure you have [Node.js](https://nodejs.org) installed (any reasonably
   recent version — if you can run `node -v` in a terminal and it prints a
   number, you're set).
2. Open a terminal and navigate into the overlay app folder:
   ```bash
   cd overlay-app
   ```
3. Install its dependencies:
   ```bash
   npm install
   ```
   (This downloads Electron and friends. Takes a minute. Grab a coffee, judge
   the next team, whatever.)
4. Start it:
   ```bash
   npm start
   ```
5. A small application window should pop up showing connection status and a
   pairing code, and the app should tuck itself into your system tray. If it
   says "Paired," you're fully wired up.

### Step 5 — Actually use the thing

1. Open literally any email, message, or webpage with text on it.
2. Click the ScamWhip tray icon (or use the hotkey — check the app window for
   the exact combo, it's shown right there) to spawn the whip on your screen.
3. Move your mouse to swing it. **Flick it hard** — a lazy wiggle won't crack
   it, you have to actually whip it like you mean it.
4. On a successful crack, it scans the page you're looking at and a verdict
   stamp appears on it within a couple seconds.
5. Click again / drop it to send the whip away when you're done.

### If something doesn't work

- **Extension says it can't connect** — make sure the overlay app (Step 4) is
  actually running. It's the one hosting the local connection the extension
  needs.
- **Whip won't crack** — you're probably being too gentle. It's a whip, not a
  fishing rod. Commit to the flick.
- **Token expired** — go back to the dashboard and click **Get a token** again.
- **Still stuck** — contact us on discord but its prob one of the issues listed above
