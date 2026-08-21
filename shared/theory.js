// theory.js — shared music-theory core, now also loaded by spicemap (for
// its degree-labeling engine and the SVG helper below) alongside masalamap
// and fusionmap. Pure functions, no DOM except the tiny mk() helper. See
// .claude/masalamap-fusionmap-spec.md.
//
// Loaded by all three apps rather than duplicated, per the spec's "factor
// out shared logic" note. spicemap still has its own diatonic-chord code
// (chordsInScale etc.) — that consolidation is flagged for later, not done
// here; this pass only covers what the shared abacus module needs.
//
// Chord wheel / secondary dominants / tritone subs / chord-progression
// sequencing are still out of scope — planned as a later "cooking" app on
// top of this diatonic foundation.

// Tiny SVG-element builder — used by shared/abacus.js and by spicemap's own
// fretboard/piano/chord-matrix rendering. One copy so multiple <script>
// tags on the same page (masalamap/fusionmap/spicemap all load this file)
// never fight over redeclaring it.
const SVG_NS = 'http://www.w3.org/2000/svg';
function mk(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Same 12-color interval-class palette as spicemap (PAL), indexed by
// semitone distance mod 12. Kept identical (same hex values) for visual
// continuity between the two apps.
const PAL = [
  '#FFFFFF', '#F51D2C', '#377EB8', '#BF5B17', '#FF7F00', '#4DAF4A',
  '#8A0303', '#a0a0a0', '#006906', '#F781BF', '#E9C81C', '#AB4EF3',
];
const BLACK_TEXT_FUNCTIONS = new Set([0, 4, 5, 7, 9, 10]);

function mod12(x) { return ((x % 12) + 12) % 12; }
function colorOf(fn) { return PAL[mod12(fn)]; }
function textColorFor(interval) {
  return BLACK_TEXT_FUNCTIONS.has(mod12(interval)) ? '#000000' : 'rgba(255,255,255,0.92)';
}

function rotateToDegree(set, k) {
  const d = set[k];
  return set.map(x => mod12(x - d)).sort((a, b) => a - b);
}

// ── scale-relative degree labeling (ported from spicemap, made pure) ────
// spicemap's own version reads rootPitchClass/labelMode/scaleOffsets off
// module globals; every function below takes the same information as
// explicit parameters instead, so multiple abacus instances (spicemap's
// one, masalamap's, fusionmap's two) can each label their own scale
// without stepping on each other.

// Enharmonic (flat) spellings for the 12 pitch classes — naturals are
// identical to NOTE_NAMES, so only the black-key entries differ.
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

// Reference degree semitones for a major scale, indexed by rank (0 = 1st
// degree ... 6 = 7th degree).
const MAJOR_REF = [0, 2, 4, 5, 7, 9, 11];

function accidental(diff) {
  if (diff === 0) return '';
  const n = Math.abs(diff);
  if (n === 1) return diff > 0 ? '♯' : '♭';
  if (n === 2) return diff > 0 ? '𝄪' : '𝄫';
  return (diff > 0 ? '♯' : '♭').repeat(n); // defensive fallback for extreme manual drags
}

// Signed semitone distance from a note to the major-scale reference degree
// at `refIdx` (0=1st degree ... 6=7th), wrapped to the nearest octave.
function degreeDist(semitone, refIdx) {
  let diff = semitone - MAJOR_REF[refIdx];
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
}

// Which of the 7 major-scale reference degrees does each note in a scale
// "belong" to — a sequence alignment between the scale's notes (ascending)
// and the 7 reference degrees (ascending), allowing degrees to be **skipped**
// (missing from the scale, e.g. pentatonic's 4th/7th — cost 0) or **repeated**
// (more than one note landing on the same nominal degree, e.g. blues' natural
// 4 and raised 4 both reading off "degree 4" — cost = that note's own
// deviation). This is what makes minor pentatonic read "♭3 4 5 ♭7" instead of
// mis-numbering every note after a skip, and blues read "♭3 4 ♭5 5 ♭7" instead
// of drifting into ♯2/♯3 the way a strict one-note-per-degree model would.
//
// Degree 1 is forced onto the root (note 0) at zero cost, guaranteeing the
// root never carries an accidental. Among equal-cost alignments, prefer
// fewer repeats, then fewer sharps.
//
// Exception: when the scale has exactly 7 notes (matching the 7 reference
// degrees 1-to-1), repeats are disallowed outright rather than merely
// discouraged — with 7 notes and 7 degrees, a repeat necessarily means some
// OTHER degree got skipped instead, which standard notation for a 7-note
// scale never does.
function assignDegreeIndices(set) {
  const n = set.length;
  const R = MAJOR_REF.length;
  const bijection = n === R;

  const dp = Array.from({ length: n }, () => new Array(R).fill(null));
  const back = Array.from({ length: n }, () => new Array(R).fill(-1));
  const sharpOf = diff => (diff > 0 ? 1 : 0);
  const lessOrEq = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] <= b[2];

  const d0 = degreeDist(set[0], 0);
  dp[0][0] = [Math.abs(d0), 0, sharpOf(d0)];

  for (let i = 1; i < n; i++) {
    for (let j = 0; j < R; j++) {
      let best = null, bestPrev = -1;
      const maxPrev = bijection ? j - 1 : j;
      for (let jp = 0; jp <= maxPrev; jp++) {
        if (!dp[i - 1][jp]) continue;
        const diff = degreeDist(set[i], j);
        const cand = [dp[i - 1][jp][0] + Math.abs(diff), dp[i - 1][jp][1] + (jp === j ? 1 : 0), dp[i - 1][jp][2] + sharpOf(diff)];
        if (!best || lessOrEq(cand, best)) { best = cand; bestPrev = jp; }
      }
      dp[i][j] = best;
      back[i][j] = bestPrev;
    }
  }

  let bestJ = -1, bestVal = null;
  for (let j = 0; j < R; j++) {
    if (dp[n - 1][j] && (!bestVal || dp[n - 1][j][0] < bestVal[0] ||
        (dp[n - 1][j][0] === bestVal[0] && dp[n - 1][j][1] < bestVal[1]) ||
        (dp[n - 1][j][0] === bestVal[0] && dp[n - 1][j][1] === bestVal[1] && dp[n - 1][j][2] < bestVal[2]))) {
      bestVal = dp[n - 1][j]; bestJ = j;
    }
  }
  const result = new Array(n);
  let j = bestJ;
  for (let i = n - 1; i >= 0; i--) { result[i] = j; j = i > 0 ? back[i][j] : j; }
  return result;
}

// Theoretically correct degree label for a note at reference slot `refIdx`
// (0-6) with semitone `semitone` — the accidental is just that degree's
// semitone compared to the major-scale reference for the same slot.
function degreeLabelAt(refIdx, semitone) {
  return accidental(degreeDist(semitone, refIdx)) + (refIdx + 1);
}

// Absolute note name for a scale member, spelled sharp or flat to match its
// own relative-degree accidental (e.g. A Phrygian's ♭2 is spelled B♭, not
// A♯) rather than always defaulting to NOTE_NAMES' sharps. `idx` is this
// note's position within `set`; the root (idx 0) always keeps its plain
// NOTE_NAMES spelling.
function absoluteNoteName(semitone, set, idx, rootPitchClass) {
  const pc = mod12(semitone + rootPitchClass);
  if (idx === 0) return NOTE_NAMES[pc];
  const assign = assignDegreeIndices(set);
  const diff = degreeDist(semitone, assign[idx]);
  return diff < 0 ? FLAT_NAMES[pc] : NOTE_NAMES[pc];
}

// Degree label for one note of `set` at position `idx` — root spelled "R" in
// relative mode. `labelMode`: 'relative' | 'absolute'; `rootPitchClass` only
// matters for 'absolute'.
function beadLabelAt(idx, semitone, set, labelMode, rootPitchClass) {
  if (labelMode === 'absolute') return absoluteNoteName(semitone, set, idx, rootPitchClass || 0);
  if (idx === 0) return 'R';
  const assign = assignDegreeIndices(set);
  return degreeLabelAt(assign[idx], semitone);
}

// Space-separated formula string for a whole scale (e.g. "1 2 ♭3 4 5 6 ♭7").
function formulaOf(set, labelMode, rootPitchClass) {
  if (labelMode === 'absolute') return set.map((s, i) => absoluteNoteName(s, set, i, rootPitchClass || 0)).join(' ');
  const assign = assignDegreeIndices(set);
  return set.map((s, i) => i === 0 ? '1' : degreeLabelAt(assign[i], s)).join(' ');
}

// The 4 diatonic-mode families (same base sets as spicemap's Increment 1/2
// catalog) — the 7-note scales that support clean stacked-3rds chord
// generation. Masalamap doesn't need spicemap's pentatonic/symmetric/
// composite scales; every chord here comes from tertian stacking through a
// 7-note scale, which only these families do cleanly.
const FAMILIES = {
  major:         { label: 'Major (diatonic)', base: [0, 2, 4, 5, 7, 9, 11], modes: ['Ionian', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Aeolian', 'Locrian'] },
  melodicMinor:  { label: 'Melodic minor',    base: [0, 2, 3, 5, 7, 9, 11], modes: ['Melodic minor', 'Dorian ♭2', 'Lydian augmented', 'Lydian dominant', 'Mixolydian ♭6', 'Locrian ♮2', 'Altered scale'] },
  harmonicMinor: { label: 'Harmonic minor',   base: [0, 2, 3, 5, 7, 8, 11], modes: ['Harmonic minor', 'Locrian ♮6', 'Ionian ♯5', 'Dorian ♯4', 'Phrygian dominant', 'Lydian ♯2', 'Ultralocrian'] },
  harmonicMajor: { label: 'Harmonic major',   base: [0, 2, 4, 5, 7, 8, 11], modes: ['Harmonic major', 'Dorian ♭5', 'Phrygian ♭4', 'Lydian ♭3', 'Mixolydian ♭2', 'Lydian augmented ♯2', 'Locrian 𝄫7'] },
};

function modeSet(familyKey, modeIndex) {
  return rotateToDegree(FAMILIES[familyKey].base, modeIndex);
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Chord-quality lookup by pitch-class set relative to root (triads + 7th
// chords only — the set of shapes a 7-note diatonic scale's tertian stack
// can actually produce). 9th/11th/13th chords are named by extending the
// underlying 7th-chord symbol (see diatonicChords below), not looked up
// here directly.
const CHORD_QUALITY = {
  '0,4,7':    { symbol: '',      name: 'major' },
  '0,3,7':    { symbol: 'm',     name: 'minor' },
  '0,3,6':    { symbol: '°',     name: 'diminished' },
  '0,4,8':    { symbol: '+',     name: 'augmented' },
  '0,4,7,11': { symbol: 'maj7',  name: 'major 7th' },
  '0,4,7,10': { symbol: '7',     name: 'dominant 7th' },
  '0,3,7,10': { symbol: 'm7',    name: 'minor 7th' },
  '0,3,6,10': { symbol: 'ø7',    name: 'half-diminished 7th' },
  '0,3,6,9':  { symbol: '°7',    name: 'diminished 7th' },
  '0,3,7,11': { symbol: 'mMaj7', name: 'minor-major 7th' },
  '0,4,8,11': { symbol: '+maj7', name: 'augmented major 7th' },
  '0,4,8,10': { symbol: '7♯5',   name: 'augmented 7th' },
  '0,4,6,10': { symbol: '7♭5',   name: 'dominant 7♭5' },
};

function qualityOf(tonesRelRoot) {
  const key = Array.from(new Set(tonesRelRoot.map(mod12))).sort((a, b) => a - b).join(',');
  return CHORD_QUALITY[key] || { symbol: '?', name: 'no common symbol', fallback: true };
}

// Extra shapes that only show up when REINTERPRETING a chord's full note-set
// from a different chord tone as root (see reinterpretFromRoot below) — 6th
// chords and 6/9s aren't reachable by plain tertian stacking from a scale
// degree, but they're exactly what a rootless upper-structure often reduces
// to (e.g. a 9th chord's non-root tones, read from its 3rd, form a 6th
// chord).
const EXTRA_QUALITY = {
  '0,4,7,9':   { symbol: '6',    name: 'major 6th' },
  '0,3,7,9':   { symbol: 'm6',   name: 'minor 6th' },
  '0,2,4,7,9': { symbol: '6/9',  name: 'six-nine' },
  '0,3,4,7,9': { symbol: 'm6/9', name: 'minor six-nine' },
  '0,2,4,7':   { symbol: 'add9', name: 'add9' },
  '0,2,3,7':   { symbol: 'm(add9)', name: 'minor add9' },
};

// Generic interval-class labels (not scale-relative) — same convention as
// spicemap's reference-table column headers. Used as a fallback formula
// display when a reinterpreted note-set doesn't resolve to a common symbol.
const TABLE_LABELS = ['R', '♭2', '2', '♭3', '3', '4', '♯4', '5', '♭6', '6', '♭7', '7'];

// The pitch-class set (absolute, mod 12, deduped) a chord actually sounds —
// independent of voicing/octave, used for cross-scale lookup and
// reinterpretation. `chordRootPc` = absolute pc of the chord's own root;
// `tones` = ascending offsets from that root (as produced by
// diatonicChords).
function absPcSet(chordRootPc, tones) {
  return new Set(tones.map(t => mod12(chordRootPc + t)));
}

// "This shape functions as X over root A, Y over root B" (spec). Re-reads
// the chord's full note-set with a DIFFERENT chord tone as root — the
// note-set itself doesn't change, only which tone anchors the interval
// count. Tries the tertian table first, then the 6th/6-9 shapes above;
// falls back to a plain interval-class formula (e.g. "R ♭3 5 6") when the
// reinterpretation isn't a commonly-named chord.
function popcount(x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

// When the full re-rooted note-set isn't a commonly-named chord, look for
// the largest NAMED subset of it that still contains the root — preferring
// richer shapes (7th/6th chords) over a bare triad, per how far "Extend to"
// is currently set. Ties (same subset size) favor keeping the
// closer-to-root tones. Returns null if not even a triad is found in there.
function bestNamedSubset(rel) {
  const nonZero = rel.filter(x => x !== 0);
  const n = nonZero.length;
  const masks = Array.from({ length: 1 << n }, (_, m) => m).sort((a, b) => popcount(b) - popcount(a));
  for (const m of masks) {
    const subset = [0];
    for (let i = 0; i < n; i++) if (m & (1 << i)) subset.push(nonZero[i]);
    if (subset.length < 3) continue; // below a triad isn't a "normal" chord
    subset.sort((a, b) => a - b);
    const key = subset.join(',');
    const q = CHORD_QUALITY[key] || EXTRA_QUALITY[key];
    if (q) return { symbol: q.symbol, name: q.name, subsetRel: subset, droppedRel: rel.filter(x => !subset.includes(x)) };
  }
  return null;
}

function reinterpretFromRoot(chordRootPc, tones, newRootPc) {
  const pcs = absPcSet(chordRootPc, tones);
  const rel = Array.from(pcs, pc => mod12(pc - newRootPc)).sort((a, b) => a - b);
  const key = rel.join(',');
  const exact = CHORD_QUALITY[key] || EXTRA_QUALITY[key];
  if (exact) return { symbol: exact.symbol, name: exact.name, formula: null, partial: false };

  const best = bestNamedSubset(rel);
  if (best) {
    return {
      symbol: best.symbol, name: best.name, formula: null, partial: true,
      dropped: best.droppedRel.map(iv => TABLE_LABELS[iv]),
    };
  }
  return { symbol: null, name: null, formula: rel.map(iv => TABLE_LABELS[iv]), partial: false };
}

// All re-rootings of a chord at once — reinterpretFromRoot run for every
// chord tone as root, in tag order (R first). Powers the overview cards so
// every reading is visible without having to click into a chord first.
function reinterpretAllRoots(chordRootPc, tones, tags) {
  return tags.map((tag, idx) => {
    const newRootPc = mod12(chordRootPc + tones[idx]);
    return { tag, rootPc: newRootPc, result: reinterpretFromRoot(chordRootPc, tones, newRootPc) };
  });
}

// Reverse lookup: "in which scales does this exact note-set also show up as
// a diatonic chord?" Brute-forces every root x family x mode combination at
// the given tone-count (depth) and keeps the ones whose diatonic chord at
// some degree has the identical absolute pitch-class set. Cheap (<= 12 x 4
// x 7 x 7 chords) — fine to run on every selection.
function findElsewhere(targetPcSet, depth, exclude) {
  const targetKey = Array.from(targetPcSet).sort((a, b) => a - b).join(',');
  const results = [];
  for (let rootPc = 0; rootPc < 12; rootPc++) {
    for (const familyKey of Object.keys(FAMILIES)) {
      const modes = FAMILIES[familyKey].modes;
      for (let modeIndex = 0; modeIndex < modes.length; modeIndex++) {
        const set = modeSet(familyKey, modeIndex);
        const chords = diatonicChords(set, depth);
        for (const chord of chords) {
          if (exclude && rootPc === exclude.rootPc && familyKey === exclude.familyKey &&
              modeIndex === exclude.modeIndex && chord.degreeIndex === exclude.degreeIndex) continue;
          const chordRootPc = mod12(rootPc + chord.rootOffset);
          const pcs = absPcSet(chordRootPc, chord.tones);
          const key = Array.from(pcs).sort((a, b) => a - b).join(',');
          if (key === targetKey) {
            results.push({ rootPc, familyKey, modeIndex, chord, chordRootPc });
          }
        }
      }
    }
  }
  return results;
}

// Roman-numeral case/decoration follows TRIAD quality only (standard
// convention), independent of how far the chord is extended for display.
function romanNumeralFor(degreeIndex, triadTonesRelRoot) {
  const q = qualityOf(triadTonesRelRoot);
  let rn = ROMAN[degreeIndex];
  if (q.name === 'minor' || q.name === 'diminished') rn = rn.toLowerCase();
  if (q.name === 'diminished') rn += '°';
  if (q.name === 'augmented') rn += '+';
  return rn;
}

const DEGREE_TAGS = ['R', '3', '5', '7', '9', '11', '13'];

// Tertian-stack diatonic chords for a 7-note `set` (ascending pitch-class
// offsets from the scale root), at every degree, extended to `depth` tones
// (3 = triad .. 7 = 13th chord — a 7-note scale's stacked-3rds tower uses
// each scale tone exactly once, so depth can't meaningfully exceed 7).
function diatonicChords(set, depth) {
  const n = 7;
  return Array.from({ length: n }, (_, i) => {
    const stackOffsets = Array.from({ length: depth }, (_, k) => 2 * k); // scale-step skips: 0,2,4,6,8,10,12
    const absTones = stackOffsets.map(s => { const idx = i + s; return set[idx % n] + 12 * Math.floor(idx / n); });
    const rootOffset = absTones[0];
    const tones = absTones.map(t => t - rootOffset); // relative to chord root, ascending
    const triadTones = tones.slice(0, 3);
    const tetradTones = tones.slice(0, Math.min(4, tones.length));
    const baseQ = qualityOf(tetradTones.length >= 3 ? tetradTones : triadTones);
    let symbol = baseQ.symbol;
    if (depth >= 5 && !baseQ.fallback) {
      const stripped = symbol.replace(/7$/, '');
      symbol = stripped + (depth === 5 ? '9' : depth === 6 ? '11' : '13');
    }
    return {
      degreeIndex: i,
      roman: romanNumeralFor(i, triadTones),
      rootOffset,       // this chord's root, as a semitone offset from the scale root
      tones,            // ascending, relative to chord root: [0, 3rd, 5th, 7th?, 9th?, 11th?, 13th?]
      tags: DEGREE_TAGS.slice(0, tones.length),
      quality: baseQ,
      symbol,
    };
  });
}

// Standard drop-voicing transforms on a close-position ascending stack.
// `kths` = which notes, counted from the TOP (1 = highest), get dropped an
// octave. Re-sorted back to ascending afterward, since dropping reorders
// which tone ends up lowest.
function dropVoicing(tones, tags, kths) {
  const n = tones.length;
  const paired = tones.map((t, idx) => ({ t, tag: tags[idx] }));
  kths.forEach(k => { const idx = n - k; if (paired[idx]) paired[idx].t -= 12; });
  paired.sort((a, b) => a.t - b.t);
  return { tones: paired.map(p => p.t), tags: paired.map(p => p.tag) };
}

const VOICINGS = {
  close:  { label: 'Close',    kths: [] },
  drop2:  { label: 'Drop 2',   kths: [2] },
  drop3:  { label: 'Drop 3',   kths: [3] },
  drop24: { label: 'Drop 2 & 4', kths: [2, 4] },
  drop23: { label: 'Drop 2 & 3', kths: [2, 3] },
};

function applyVoicing(tones, tags, voicingKey) {
  const v = VOICINGS[voicingKey];
  if (!v || v.kths.length === 0) return { tones: tones.slice(), tags: tags.slice() };
  return dropVoicing(tones, tags, v.kths);
}

// Upper-triangle pairwise interval matrix over a voiced (ascending) tone
// array. Each cell: raw semitone distance (>=12 for a compound/extension
// interval), its mod-12 hue class, and a simple/compound flag — this is the
// "pool ball" data the renderer colors (solid vs striped) per the spec.
function intervalMatrix(tones) {
  const n = tones.length;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      if (j <= i) { row.push(null); continue; }
      const raw = tones[j] - tones[i];
      row.push({ raw, hue: mod12(raw), compound: raw >= 12 });
    }
    rows.push(row);
  }
  return rows;
}

// Display-only absolute pitch, anchored so a chord's own root sits near
// middle C (60). Not meant to model continuous voice-leading register
// across chords — each chord is shown independently on selection.
function midiOf(chordRootPc, offsetFromChordRoot) {
  return 60 + chordRootPc + offsetFromChordRoot;
}
function noteLabel(midi) {
  const pc = mod12(midi);
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[pc] + octave;
}

// ── free-build chord naming (masalamap) ──────────────────────────────────

// Name an arbitrary absolute pitch-class set by trying EVERY note in it as
// a candidate root and checking for an exact tertian-table match (no
// partial/subset fallback here, unlike reinterpretFromRoot — free-build is
// about naming exactly what the user built, not approximating it). Returns
// every match found; a note-set can legitimately match under more than one
// assumed root (e.g. C-E-G-A = Cadd6 rooted on C, or Am7 rooted on A) —
// that ambiguity is surfaced as a list, never silently resolved to one.
function nameNoteSet(pcSet) {
  const pcs = Array.from(pcSet);
  const matches = [];
  for (const rootPc of pcs) {
    const rel = pcs.map(pc => mod12(pc - rootPc)).sort((a, b) => a - b);
    const key = rel.join(',');
    const q = CHORD_QUALITY[key] || EXTRA_QUALITY[key];
    if (q) matches.push({ rootPc, symbol: q.symbol, name: q.name });
  }
  return matches;
}

// ── scale-relationship presets (fusionmap) ───────────────────────────────
// Each takes/returns a plain { rootPc, familyKey, modeIndex } scale
// descriptor. These compute Scale B FROM Scale A's current settings (one-
// way shortcuts, not toggles on Scale B itself) — matches how the spec
// frames the preset buttons ("auto-populating Scale B relative to Scale A").

function parentRootOf(scale) {
  return mod12(scale.rootPc - FAMILIES[scale.familyKey].base[scale.modeIndex]);
}

// Relative major/minor: same parent scale (same key signature), different
// tonic. Well-defined as an Ionian<->Aeolian pair within Scale A's own
// family — simplification: any mode OTHER than Ionian(0) is treated as
// "the minor side" and jumps to that family's Ionian (0), i.e. this
// doubles as "reveal the underlying parent scale" for non-Ionian/Aeolian
// modes, not just the two canonical ones.
function relativeOf(scale) {
  const parentRoot = parentRootOf(scale);
  const targetMode = scale.modeIndex === 0 ? 5 : 0;
  return { rootPc: mod12(parentRoot + FAMILIES[scale.familyKey].base[targetMode]), familyKey: scale.familyKey, modeIndex: targetMode };
}

// Parallel major/minor: same tonic, toggles Ionian<->Aeolian of the major
// family at that root (e.g. C major <-> C minor).
function parallelOf(scale) {
  const isParallelMajor = scale.familyKey === 'major' && scale.modeIndex === 0;
  return { rootPc: scale.rootPc, familyKey: 'major', modeIndex: isParallelMajor ? 5 : 0 };
}

function fifthUp(scale) { return { rootPc: mod12(scale.rootPc + 7), familyKey: scale.familyKey, modeIndex: scale.modeIndex }; }
function fifthDown(scale) { return { rootPc: mod12(scale.rootPc - 7), familyKey: scale.familyKey, modeIndex: scale.modeIndex }; }
function tritoneOf(scale) { return { rootPc: mod12(scale.rootPc + 6), familyKey: scale.familyKey, modeIndex: scale.modeIndex }; }

// ── diatonic-set comparison (fusionmap) ──────────────────────────────────

// Diatonic chords of a scale, each tagged with its absolute pc-set key (for
// comparison) and its chord-root pitch class (for display).
function diatonicChordsWithKeys(scale, depth) {
  const set = modeSet(scale.familyKey, scale.modeIndex);
  return diatonicChords(set, depth).map(chord => {
    const chordRootPc = mod12(scale.rootPc + chord.rootOffset);
    const pcs = absPcSet(chordRootPc, chord.tones);
    return { chord, chordRootPc, pcKey: Array.from(pcs).sort((a, b) => a - b).join(',') };
  });
}

// Side-by-side diatonic chord lists for two scales, each entry flagged
// `shared` if the identical note-set (any root) also occurs in the other
// scale's list at the same depth.
function compareDiatonic(scaleA, scaleB, depth) {
  const listA = diatonicChordsWithKeys(scaleA, depth);
  const listB = diatonicChordsWithKeys(scaleB, depth);
  const keysA = new Set(listA.map(e => e.pcKey));
  const keysB = new Set(listB.map(e => e.pcKey));
  listA.forEach(e => { e.shared = keysB.has(e.pcKey); });
  listB.forEach(e => { e.shared = keysA.has(e.pcKey); });
  return { listA, listB };
}
