# SpiceMap

An interactive scale/chord explorer — abacus-style scale editor, fretboard
(guitar/bass/ukulele/mandolin/banjo) and piano views, chord matrix, and
click-to-hear playback via [Tone.js](https://tonejs.github.io/).

Live at [spicemap.10keyz.com](https://spicemap.10keyz.com).

## Structure

```
index.html   — markup only
style.css    — all styling
app.js       — all application logic
libs/        — vendored Tone.js (v14.8.49)
samples/     — instrument samples actually used by the app (piano, guitar-
               acoustic, bass-electric, one harmonium + one organ note for
               the drone) — pitch-shifted per note by Tone.Sampler
full-sample-packs/  — the complete original sample packs these are drawn
               from, for optional future use / self-hosting elsewhere.
               Gitignored — not loaded by the app itself.
```

## Running locally

Static site, no build step. Serve the folder over HTTP (opening
`index.html` directly via `file://` will hit browser CORS restrictions on
the sample fetches) — e.g.:

```
python3 -m http.server
```

## Deployment

GitHub Pages with a custom domain — the `CNAME` file points it at
`spicemap.10keyz.com`.

## Sample credits

Instrument samples are CC-BY 3.0:

- Piano (Salamander Grand Piano) — Alexander Holm
- Guitar-acoustic, bass-electric, harmonium, organ — [nbrosowsky/tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments)

Tone.js is MIT licensed.
