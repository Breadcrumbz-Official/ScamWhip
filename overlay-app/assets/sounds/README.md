# Sounds

**Anything you drop in this folder gets played.** No config, no manifest — the
app lists the folder at startup and picks one at random for each crack.

Files are played **as recorded**: no pitch shift, no reverb, no synthesised
layers on top. What you put here is what you hear.

- `.wav`, `.mp3`, `.ogg`, `.m4a`, `.aac`, `.flac`, `.opus`
- Added a file while the app is running? Tray → **Reload config** picks it up
- Empty the folder and the built-in synthesised crack takes over

## Options

All under `sound` in `config/whip.config.json`:

| Key | Default | What it does |
|---|---|---|
| `files` | `[]` | Empty = use everything in this folder. Name files here to use only those. |
| `volume` | 0.85 | Master level. |
| `scaleWithStrength` | true | A harder crack plays louder. Set false for identical volume every time. |
| `pitchJitterFiles` | false | Re-pitch each hit slightly. Off by default — that is processing, and the point here is as-is playback. |
| `panning` | true | Follow the whip tip left/right across the screen. |
| `whoosh.enabled` | true | The swish while you swing. Synthesised and independent of these files — turn it off if you want silence between cracks. |

Keep crack recordings short and front-loaded; the transient at the very start is
what sells it.
