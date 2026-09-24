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
// What colorOf actually reads. PAL above stays the shipped default (and
// the "Sentiment12" preset in spicemap's own palette picker); this is the
// one that swaps when a different palette is chosen. Separate, rather than
// mutating PAL in place, so the default is always still there to reset to.
// A host that never calls setPalette — masalamap, fusionmap — just gets PAL
// forever, exactly as before.
let ACTIVE_PAL = PAL.slice();
function setPalette(colors) {
  ACTIVE_PAL = colors.slice();
}
function activePalette() { return ACTIVE_PAL.slice(); }

function mod12(x) { return ((x % 12) + 12) % 12; }
function colorOf(fn) { return ACTIVE_PAL[mod12(fn)]; }

// Relative luminance (WCAG), used to decide black-vs-white label text.
// This replaced a hardcoded BLACK_TEXT_FUNCTIONS set of degree numbers,
// which only ever worked because it was hand-matched to PAL's exact
// colors — the moment the palette can change (let alone be user-defined),
// "degree 4 takes black text" stops being a fact about degrees at all and
// becomes one about whatever color is sitting there now. Computing it is
// also simply more correct: a custom palette can't pick an unreadable
// combination by accident.
function relativeLuminance(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 0;
  const chan = v => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(m[1]) + 0.7152 * chan(m[2]) + 0.0722 * chan(m[3]);
}
function textColorFor(interval) {
  // 0.25. The pure-contrast crossover — the luminance where black and
  // white are equally readable — is 0.179 (√(1.05×0.05) − 0.05), so
  // anything above that technically reads better in black. But the four
  // colors sitting just above it (♭2 #F51D2C, 2 #377EB8, ♭3 #BF5B17,
  // 7 #AB4EF3, all L≈0.19-0.21) are near enough to the line that black
  // only wins ~5.1:1 vs ~4.1:1, and this palette was hand-tuned to use
  // white on them. 0.25 sits in the gap between that cluster and the next
  // one up (4 #4DAF4A at L=0.327), so it reproduces the original
  // hand-picked mapping exactly while still deriving it from the color.
  //
  // A first pass used 0.4, which was simply too high: it flipped 3, 4, 5
  // AND 6 to white text, and 6 (#F781BF, pink) is the one a user caught —
  // white on it is 2.37:1 where black is 8.85:1. Worth keeping the number
  // honest rather than nudging it by eye again.
  return relativeLuminance(colorOf(interval)) > 0.25 ? '#000000' : 'rgba(255,255,255,0.92)';
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

// A handful of non-7-note scales worth offering alongside the 4 tertian
// families, picked specifically because they harmonize *cleanly* (every
// degree resolves to an exact, non-approximate chord via buildTriad/
// buildSeventhChord below) rather than needing the approximate fallback
// path most non-7-note collections do:
//  - Octatonic (half-whole/"dominant diminished"): alternates a full
//    dominant 7th with a full diminished 7th a half-step above it — the
//    scale jazz altered-dominant vocabulary is built on.
//  - Octatonic (whole-half/"diminished scale"): every degree is one of just
//    two diminished-7th shapes (it's literally the union of two °7 chords a
//    whole step apart), the scale played over diminished chords.
//  - Whole-tone: every degree is the same augmented-7th (♯5) shape,
//    transposed — the symmetric-6-note counterpart.
// Deliberately NOT the rest of spicemap's dictionary (pentatonic,
// composite/bebop/flamenco scales) — those need the approximate fallback at
// most/every degree, per spicemap's own comments, so they don't share these
// three's "clean" property.
const EXTRA_SCALES = [
  { label: 'Octatonic (half-whole)', set: [0, 1, 3, 4, 6, 7, 9, 10] },
  { label: 'Octatonic (whole-half)', set: [0, 2, 3, 5, 6, 8, 9, 11] },
  { label: 'Whole-tone',             set: [0, 2, 4, 6, 8, 10] },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

// Chord-quality lookup by pitch-class set relative to root. Originally just
// the triad/7th shapes a 7-note diatonic scale's tertian stack can produce;
// now also the shared home for sus2/sus4 (see buildTriad below) now that
// this table backs chord generation for non-7-note scales too — spicemap
// used to keep its own separate copy of this table with sus2/sus4 added,
// on the reasoning that masalamap's old pure-tertian-stacking algorithm
// could never produce a suspended triad so there was nothing to add them
// for. That's no longer true once buildTriad (ported from spicemap) is in
// the general path below, and for the existing 7-note families it changes
// nothing (that path's exact-degree-skipping never needed buildTriad to
// begin with — verified against every mode in the catalog) — so there's
// nothing standing in the way of one shared table. 9th/11th/13th chords are
// named by extending the underlying 7th-chord symbol (see diatonicChords
// below), not looked up here directly.
const CHORD_QUALITY = {
  '0,4,7':    { symbol: '',      name: 'major' },
  '0,3,7':    { symbol: 'm',     name: 'minor' },
  '0,3,6':    { symbol: '°',     name: 'diminished' },
  '0,4,8':    { symbol: '+',     name: 'augmented' },
  '0,2,7':    { symbol: 'sus2',  name: 'suspended 2nd' },
  '0,5,7':    { symbol: 'sus4',  name: 'suspended 4th' },
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

// ── chord construction for non-7-note scales ─────────────────────────────
// Ported from spicemap's original chordsInScale/buildTriad/buildSeventhChord
// (before diatonic chords moved to masalamap) — ordinary 7-note scales don't
// need any of this (see the `byPosition` fast path in diatonicChords below,
// which exact-degree-skips instead and is strictly more reliable for n=7),
// but a scale that isn't a 1-to-1 match against 7 reference degrees — the 3
// EXTRA_SCALES above, or any future addition — has no such fixed skip
// pattern to lean on, so each chord tone has to be picked by what's actually
// closest to "a third above the previous tone."
//
// 3rd slot: 3 > ♭3 > sus4 > sus2 (first available wins; sus2/sus4 only
// offered when a real 5th backs them up — a suspended chord with no 5th at
// all isn't really "suspending" anything).
// 5th slot: a real 5th if present; otherwise an altered 5th that actually
// resolves to a *named* triad given the 3rd already chosen (♯5 with a major
// 3rd -> augmented; ♭5 with a minor 3rd -> diminished); otherwise borrow a
// 6th/♭7/7th and drop the notion of a 5th entirely (flagged `approximate`,
// since it's a stand-in rather than a textbook triad); last resort,
// whichever altered 5th is left.
function buildTriad(set, root) {
  const hasInterval = iv => set.some(pc => mod12(pc - root) === iv);

  let third;
  if (hasInterval(4)) third = 4;
  else if (hasInterval(3)) third = 3;
  else if (hasInterval(7) && hasInterval(5)) return { tones: [0, 5, 7], approximate: false };
  else if (hasInterval(7) && hasInterval(2)) return { tones: [0, 2, 7], approximate: false };
  else return { tones: null, approximate: false };

  if (hasInterval(7)) return { tones: [0, third, 7], approximate: false };
  const matchingAltered5 = third === 4 ? 8 : 6;
  if (hasInterval(matchingAltered5)) return { tones: [0, third, matchingAltered5], approximate: false };
  if (hasInterval(9))  return { tones: [0, third, 9],  approximate: true }; // borrow 6, omit the 5th
  if (hasInterval(10)) return { tones: [0, third, 10], approximate: true }; // borrow ♭7
  if (hasInterval(11)) return { tones: [0, third, 11], approximate: true }; // borrow 7
  const otherAltered5 = third === 4 ? 6 : 8;
  if (hasInterval(otherAltered5)) return { tones: [0, third, otherAltered5], approximate: true };
  return { tones: null, approximate: false };
}

// 4-note extension of buildTriad — always the triad plus one more note,
// never an independent recomputation. Clean triad (a real or
// matching-altered 5th): extend with a 7th, preferring ♭7 > 7 > 6 *among
// whichever of those actually names a recognized tetrad* — plain ♭7>7>6 by
// itself (spicemap's original priority, tuned for major/minor triads where
// ♭7/7 always do name one) picks the wrong note for a diminished triad: a
// °7's defining tone is the "6th slot" (interval 9), but ♭7/7 rank above it
// in the fixed order, and when the scale happens to also contain a 7 (as
// octatonic's half-whole scale does) that fixed order lands on "diminished
// triad + major 7th" — not a recognized shape — instead of the °7 sitting
// right there. Falls back to the first available candidate if none of them
// name anything (e.g. an already-unusual triad where nothing will).
// A triad that already had to borrow a 6th/♭7/7th for its "5th slot" reads
// as "1 (♭)3 (♭)7" with no true 5th — whatever's added on top of THAT is an
// upper extension (9th/11th/13th), not a plain 6th, hence `extended: true`.
function buildSeventhChord(set, root) {
  const triad = buildTriad(set, root);
  if (!triad.tones) return null;
  const hasInterval = iv => set.some(pc => mod12(pc - root) === iv);
  const used = new Set(triad.tones);

  if (!triad.approximate) {
    const candidates = [10, 11, 9].filter(iv => hasInterval(iv) && !used.has(iv));
    if (candidates.length === 0) return null;
    const named = candidates.find(iv => !qualityOf([...triad.tones, iv]).fallback);
    const iv = named != null ? named : candidates[0];
    return { tones: [...triad.tones, iv], approximate: false, extended: false };
  }

  for (const iv of [5, 2, 9, 10, 11]) {
    if (hasInterval(iv) && !used.has(iv)) {
      return { tones: [...triad.tones, iv], approximate: true, extended: true };
    }
  }
  return null;
}

// Extends a chord past its 7th (9th/11th/13th) by walking the scale and
// picking whichever member sits closest to a "plausible third" above the
// previous tone (2-5 semitones, a window wide enough to admit the 4ths that
// thirds through a sparse scale usually turn out to be). Degenerate case (no
// scale member within that window, e.g. a genuinely large gap) widens the
// search to the whole scale and flags the result `approximate`.
function pickStackTone(set, prevAbs) {
  function gather() {
    const out = [];
    for (const pc of set) {
      let cand = pc;
      while (cand <= prevAbs) cand += 12;
      const interval = cand - prevAbs;
      if (interval >= 2 && interval <= 5) out.push({ cand, interval, score: Math.abs(interval - 3.5) });
    }
    return out;
  }
  let cands = gather();
  let approximate = false;
  if (cands.length === 0) {
    approximate = true;
    for (const pc of set) {
      let cand = pc;
      while (cand <= prevAbs) cand += 12;
      cands.push({ cand, interval: cand - prevAbs, score: Math.abs(cand - prevAbs - 3.5) });
    }
  }
  let best = cands[0];
  for (const c of cands.slice(1)) {
    const better = c.score < best.score - 1e-9;
    const tied = Math.abs(c.score - best.score) < 1e-9;
    if (better || (tied && c.interval < best.interval)) best = c;
  }
  return { tone: best.cand, approximate };
}

// Tertian-stack diatonic chords for `set` (ascending pitch-class offsets
// from the scale root, any length n >= 3), at every degree, extended to
// `depth` tones.
//
// With exactly 7 notes, exact-degree-skipping (every other of the 7
// reference degrees) is mathematically the textbook stacked-thirds
// definition, with no searching or tie-breaking needed — verified against
// every mode in the catalog, including harmonic-minor/major, where a naive
// "closest third" search can pick the wrong one of two simultaneously
// available 3rds. For any other length, that guarantee doesn't hold, so
// each degree instead goes through buildTriad/buildSeventhChord (exact
// where the scale supports it) and, past the 7th, pickStackTone.
function diatonicChords(set, depth) {
  const n = set.length;
  const byPosition = n === MAJOR_REF.length;

  return Array.from({ length: n }, (_, i) => {
    let tones, approximate = false, extended = false;
    if (byPosition) {
      const stackOffsets = Array.from({ length: depth }, (_, k) => 2 * k); // scale-step skips: 0,2,4,6,8,10,12
      const absTones = stackOffsets.map(s => { const idx = i + s; return set[idx % n] + 12 * Math.floor(idx / n); });
      tones = absTones.map(t => t - absTones[0]);
    } else {
      const built = depth >= 4 ? buildSeventhChord(set, set[i]) : buildTriad(set, set[i]);
      tones = built && built.tones ? built.tones.slice() : null;
      if (built) { approximate = built.approximate; extended = built.extended || false; }
      if (!tones) tones = [0];
      for (let k = tones.length; k < depth; k++) {
        const picked = pickStackTone(set, set[i] + tones[k - 1]);
        tones.push(picked.tone - set[i]);
        approximate = approximate || picked.approximate;
      }
    }
    const triadTones = tones.slice(0, 3);
    const tetradTones = tones.slice(0, Math.min(4, tones.length));
    const baseQ = qualityOf(tetradTones.length >= 3 ? tetradTones : triadTones);
    let symbol = baseQ.symbol;
    if (depth >= 5 && !baseQ.fallback) {
      // A tertian stack always includes every lower extension by
      // construction (depth 7 necessarily passed through the 9th and 11th
      // to get there) — list all of them present, not just the highest, to
      // match nameExtendedChord's convention for a hand-built freeform
      // selection with the same note content (e.g. "9/11/13", not "13").
      const stripped = symbol.replace(/7$/, '');
      const extLabels = ['9', '11', '13'].slice(0, depth - 4);
      symbol = stripped + extLabels.join('/');
    }
    return {
      degreeIndex: i,
      roman: romanNumeralFor(i, triadTones),
      rootOffset: set[i],  // this chord's root, as a semitone offset from the scale root
      tones,               // ascending, relative to chord root: [0, 3rd, 5th, 7th?, 9th?, 11th?, 13th?]
      tags: DEGREE_TAGS.slice(0, tones.length),
      quality: baseQ,
      symbol,
      approximate,
      extended,
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

// A CHORD_QUALITY/EXTRA_QUALITY exact-key lookup only ever covers up to a
// plain 7th chord (4 distinct tones) or a couple of hand-picked 5-tone
// shapes — a genuine 9/11/13 stack (5-7 tones) has no literal table entry at
// all, so a note-set like "every note of the scale" used to come back with
// no name whatsoever even though it's a completely ordinary extended chord.
// Named the same way diatonicChords itself builds one: a recognized
// triad/7th base PLUS whichever of the 9th/11th/13th (semitones 2/5/9 from
// root) are present — listing exactly the ones present (not just the
// highest, the way "G13" implies 9/11 for free) since a hand-built freeform
// selection may deliberately include some and not others.
const EXTENSION_INTERVAL = [2, 5, 9];
const EXTENSION_NAME = { 2: '9', 5: '11', 9: '13' };
function nameExtendedChord(rel) {
  const present = new Set(rel);
  const extPresent = EXTENSION_INTERVAL.filter(iv => present.has(iv));
  if (extPresent.length === 0) return null; // nothing extended — the plain exact-key lookup already covers this
  const base = rel.filter(iv => !EXTENSION_INTERVAL.includes(iv));
  const baseQ = CHORD_QUALITY[base.join(',')];
  if (!baseQ || baseQ.fallback) return null;
  const extLabels = extPresent.map(iv => EXTENSION_NAME[iv]);
  if (base.length === 4) {
    // has its own 7th — standard extension naming: strip the bare "7", append whichever of 9/11/13 are present
    return { symbol: baseQ.symbol.replace(/7$/, '') + extLabels.join('/'), name: `${baseQ.name}, extended (${extLabels.join('/')})` };
  }
  if (base.length === 3) {
    // triad only, no 7th — each extension reads as its own "add" (an "add9"
    // implies nothing about a 7th; a bare "9" does)
    return { symbol: baseQ.symbol + extLabels.map(l => `add${l}`).join(''), name: `${baseQ.name}, ${extLabels.map(l => 'added ' + l).join('/')}` };
  }
  return null;
}

// Name an arbitrary absolute pitch-class set by trying EVERY note in it as
// a candidate root and checking for an exact tertian-table match, then
// nameExtendedChord for anything with 9/11/13-range tones on top of a
// recognized base (no partial/subset fallback beyond that, unlike
// reinterpretFromRoot — free-build is about naming exactly what the user
// built, not approximating it). Returns every match found; a note-set can
// legitimately match under more than one assumed root (e.g. C-E-G-A =
// Cadd6 rooted on C, or Am7 rooted on A) — that ambiguity is surfaced as a
// list, never silently resolved to one.
function nameNoteSet(pcSet) {
  const pcs = Array.from(pcSet);
  const matches = [];
  for (const rootPc of pcs) {
    const rel = pcs.map(pc => mod12(pc - rootPc)).sort((a, b) => a - b);
    const key = rel.join(',');
    const q = CHORD_QUALITY[key] || EXTRA_QUALITY[key] || nameExtendedChord(rel);
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
