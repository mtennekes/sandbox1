// ── §-1 chrome theme (background/text tokens only — see :root in <style>) ────
// Not exposed in the GUI — edit this constant to try a different chrome
// theme: 'indigo' (default), 'slate', or 'paper' (see the :root[data-theme]
// blocks in <style> above). Does not touch the separate note-color system
// (PAL/icolor) used by the abacus/fretboard/piano.
const THEME = 'slate';
if (THEME !== 'indigo') document.documentElement.dataset.theme = THEME;

// ── §0 shared music-logic core ─────────────────────────────────────────────────
// Pure functions, no DOM. Single source of truth the renderers read from.

function intervalSet(positions) {
  const set = new Set(positions.map(p => ((p % 12) + 12) % 12));
  return Array.from(set).sort((a, b) => a - b);
}

function rotateToDegree(set, k) {
  const d = set[k];
  return set.map(x => ((x - d) % 12 + 12) % 12).sort((a, b) => a - b);
}

// PAL/colorOf/textColorFor/BLACK_TEXT_FUNCTIONS/NOTE_NAMES/FLAT_NAMES/
// MAJOR_REF/TABLE_LABELS/ROMAN/FAMILIES/mk/accidental/degreeDist/
// assignDegreeIndices/degreeLabelAt now live in ../shared/theory.js (loaded
// before this file — see index.html) so masalamap/fusionmap/spicemap share
// one copy instead of three. `functionOf`/`icolor` are spicemap's own
// naming for the same shared `mod12`/`colorOf` — kept as thin aliases so
// the rest of this file didn't need touching everywhere they're used.
const functionOf = mod12;
const icolor = colorOf;

// ── note-color palettes ──────────────────────────────────────────────────
//
// Every drawing in the app (abacus beads, fretboard/piano markers, the
// reference list's dot strips, the legend) colors notes through colorOf(),
// which reads whichever palette setPalette() last installed — so switching
// one here re-skins the whole app with no per-renderer work. Label text
// contrast is computed from the color itself (see textColorFor in
// theory.js), which is what makes a user-defined palette safe: no preset
// list of "which degrees take black text" to keep in sync.
//
// Index = semitones above the root: 0=R, 1=♭2, 2=2, 3=♭3, 4=3, 5=4, 6=♭5,
// 7=5, 8=♭6, 9=6, 10=♭7, 11=7.
const DIM = '#808690'; // "not highlighted" grey for the reduced palettes
const PALETTES = {
  sentiment12: {
    label: 'Sentiment12',
    colors: PAL.slice(), // the shipped default — one color per degree, see theory.js
  },
  rootonly: {
    label: 'RootOnly',
    // Just where home is — every other scale note the same grey.
    colors: ['#FFFFFF', DIM, DIM, DIM, DIM, DIM, DIM, DIM, DIM, DIM, DIM, DIM],
  },
  thirdsfive: {
    label: 'ThirdsFive',
    // Root, the 5th, and the ♭3/3 that decides minor vs major — the
    // skeleton of a triad. The thirds keep their Sentiment12 colors; the
    // 5th borrows Sentiment12's blue (its own grey there would vanish
    // among the dimmed notes here).
    colors: ['#FFFFFF', DIM, DIM, PAL[3], PAL[4], DIM, DIM, PAL[2], DIM, DIM, DIM, DIM],
  },
  rainbow: {
    label: 'Rainbow',
    // A color wheel run once round the octave: neighbouring notes get
    // neighbouring hues, so shapes read as smooth or jumpy, with no
    // meaning attached to any one color.
    colors: ['#2791B7', '#109789', '#259A50', '#768D12', '#A8780D', '#A8780D',
             '#C65F33', '#D94261', '#DD26A4', '#C53BE0', '#9A61F4', '#5F80E3'],
  },
  custom: {
    label: 'Choose your own colors!',
    // Seeded from Sentiment12 the first time, then whatever the user edits
    // (see the swatch row in the Setup dialog). Persisted separately from
    // the choice of palette, so switching away and back doesn't lose it.
    colors: (() => {
      try {
        const saved = JSON.parse(localStorage.getItem('n4a-custom-palette') || 'null');
        if (Array.isArray(saved) && saved.length === 12) return saved;
      } catch (_) { /* malformed storage — fall through to the default */ }
      return PAL.slice();
    })(),
  },
};

// 'spice' was Sentiment12's old key; any other retired palette (color
// blind, chord tones) falls back to the default too.
let paletteName = localStorage.getItem('n4a-palette') || 'sentiment12';
if (paletteName === 'spice' || !PALETTES[paletteName]) paletteName = 'sentiment12';

// Installs the palette and redraws everything that paints notes. Called on
// load (before the first render) and on every change from the picker.
function applyPalette(name, { rerender = true } = {}) {
  if (!PALETTES[name]) return;
  paletteName = name;
  localStorage.setItem('n4a-palette', name);
  setPalette(PALETTES[name].colors);
  if (rerender) {
    render();
    renderTable();
  }
}

function setCustomPaletteColor(idx, hex) {
  PALETTES.custom.colors[idx] = hex;
  localStorage.setItem('n4a-custom-palette', JSON.stringify(PALETTES.custom.colors));
  // Editing a swatch while Custom is the active palette should show up
  // immediately; editing it while another palette is showing shouldn't
  // yank the view out from under you.
  if (paletteName === 'custom') applyPalette('custom');
}


// The current screen arrangement (see applyLayout) — null until the first
// applyLayout() call near the end of this file. Declared up here because
// renderInstrumentView() reads it and first runs long before that.
let currentLayout = null;

// "A three-note scale is just a chord" — chordMode swaps which catalog the
// note-count buttons/reference table offer, reusing every other mechanism
// (abacus, fretboard highlighting, nameScale) completely unchanged. See
// the §2 scale reference table section further down for the rest of that
// story; declared this early because the abacus's own labelFn (chordAwareBeadLabel, defined further
// down) reads it, and that first runs during createAbacus()'s own
// construction-time render(), long before line ~1700 would otherwise run.
let chordMode = localStorage.getItem('n4a-chord-mode') === 'true';

// TABLE_LABELS/MAJOR_REF/accidental/degreeDist/assignDegreeIndices/
// degreeLabelAt now live in shared/theory.js (ported verbatim — see there
// for the full rationale on the degree-assignment algorithm).

// 'relative' (1, ♭3, 4, ...) or 'absolute' (actual note names, C, E♭, F, ...)
// — applies everywhere a degree label is shown (abacus beads, formula,
// reference table cells) since they all route through formulaOf/
// beadLabelAt below. The Setup toggle that used to switch this has been
// removed outright (see the note in #synth-dialog in index.html, where it
// last lived) — the abacus's own axis row
// always shows the OTHER of the two beside whichever this is (see the
// "Complements whatever the beads are showing" comment in abacus.js), so
// both readings are visible side by side regardless of which is "the"
// mode, and a toggle between two things you can already see at once had
// nothing left to do. Relative is the default (tried absolute first —
// less intuitive in practice, since seeing the actual degree/chord-tone
// number, e.g. spotting a chord's own ♭9/13, is more useful than the bare
// note name most of the time). Hardcoded rather than read from
// localStorage now that there's no control left to write a different
// value there — no stale value from earlier testing can silently override
// this. Advanced only — Beginner mode still always forces absolute
// (setViewMode below), a separate, deliberate choice for that audience.
let labelMode = 'relative';

// 'beginner' (the curated short list, no mode-stepper or note-counts) or
// 'advanced' (the full catalog) — a permanent, visible toggle rather than
// a dev-only switch, since people may want to flip between the two
// depending on mood. Surfaced as a single lamp labelled "Basic" (lit =
// beginner); the internal names stay as they are, since they're threaded
// through a lot of call sites and renaming them buys nothing.
//
// Defaults to 'advanced' — i.e. the lamp starts unlit. The trade-off cuts
// both ways (someone new lands in the full catalog with no shortlist to
// ease in on) but this is the owner's own call for their own app, and a
// player who knows what they're looking for shouldn't have to find and
// flip a switch before the catalog they came for is visible.
let viewMode = localStorage.getItem('n4a-view-mode') || 'advanced';

// 'free' or 'paid' — set via ?tier=free|paid in the URL, then persisted so
// it sticks across visits without needing the param every time. No visible
// in-app switcher (there's no real payment gate yet, just the feature
// difference) — defaults to 'paid' so today's behavior is unchanged for
// anyone who never passes the param.
const urlTier = new URLSearchParams(location.search).get('tier');
if (urlTier === 'free' || urlTier === 'paid') localStorage.setItem('n4a-tier', urlTier);
let tier = localStorage.getItem('n4a-tier') || 'paid';

// formulaOf/beadLabelAt now live in shared/theory.js, parameterized
// (labelMode/rootPitchClass passed explicitly instead of read off globals,
// so multiple abacus instances can each label independently) — call sites
// below now pass `labelMode, rootPitchClass` explicitly.
function bitmaskOf(set) { return set.reduce((m, s) => m | (1 << s), 0); }

// ── scale dictionary ────────────────────────────────────────────────────────────

const FAMILY_LABEL = {
  major:         'Major (diatonic)',
  melodicMinor:  'Melodic minor',
  harmonicMinor: 'Harmonic minor',
  harmonicMajor: 'Harmonic major',
  doubleHarmonic: 'Double harmonic major',
};

// FAMILIES now lives in shared/theory.js (identical base/modes; it also
// carries a `label` field spicemap doesn't read, harmless).

const EXOTIC = {
  doubleHarmonic: {
    base: [0,1,4,5,7,8,11],
    modes: ['Double harmonic major','Lydian ♯2 ♯6','Ultraphrygian','Hungarian minor','Oriental','Ionian ♯2 ♯5','Locrian 𝄫3 𝄫7']
  }
};

const EXTRA_SINGLE = {
  'Neapolitan minor': [0,1,3,5,7,8,11],
  'Neapolitan major': [0,1,3,5,7,9,11],
};

const SCALE_DICT = {};   // bitmask -> entry
const CHORD_DICT = {};   // bitmask -> entry — kept separate from SCALE_DICT
// rather than sharing it, because a chord and a scale can be the exact same
// note-set (e.g. a 6/9 chord IS the major-pentatonic scale, note for note —
// confirmed by their bitmasks colliding when this was one shared dict) and
// SCALE_DICT only ever holds one entry per bitmask. Kept apart, both names
// stay reachable — nameScale() below picks which dict to check first based
// on chordMode, since which reading is "the" name is genuinely mode-dependent.
const DICT_ENTRIES = []; // insertion-ordered list, for fallback search

// `kind` (Increment 3 §2) determines which rules an entry follows:
//  - 'stepwise'  (default): ordinary necklace.
//  - 'symmetric': invariant under transposition by some k<12 — affects
//    rotation naming (not spelling: the general alignment algorithm spells
//    these correctly on its own).
//  - 'composite': a parent scale + added chromatic tone(s), e.g. flamenco
//    fusion (Phrygian + ♮3) or the bebop scales — `parentName` is kept
//    around for the reference table's "parent + added tone" description.
//    Spelling/bead rendering treats every note the same regardless of
//    kind: all formulas/labels come from the same assignDegreeIndices() run
//    over the full set, so the abacus always matches the reference table.
function addDictEntry(name, family, set, tier, opts) {
  opts = opts || {};
  const kind = opts.kind || 'stepwise';
  const entry = { name, family, set, tier, kind, isChord: !!opts.chord };
  if (opts.parentName) entry.parentName = opts.parentName;
  if (opts.addedTones) entry.addedTones = opts.addedTones;
  if (opts.addedRole) entry.addedRole = opts.addedRole;
  // Which of this chord's own semitone offsets are 9th/11th/13th extensions
  // — see chordVoicingOctaveUp() below for why this has to be per-entry
  // data rather than a general rule (an altered extension like ♭9/♯9 can
  // have a *lower* raw semitone value than the 3rd/5th it sits above, so
  // "the Nth note in ascending order" doesn't reliably mean "the Nth
  // functional degree"; only the chord's own definition knows which is which).
  if (opts.voicingOctaveUp) entry.voicingOctaveUp = opts.voicingOctaveUp;
  (opts.chord ? CHORD_DICT : SCALE_DICT)[bitmaskOf(set)] = entry;
  DICT_ENTRIES.push(entry);
  return entry;
}
// Chord entries (see below) are ordinary addDictEntry calls, just routed
// into CHORD_DICT instead of SCALE_DICT — this wrapper is only so the call
// sites read as chord definitions rather than a stray {chord:true} option.
function addChordEntry(name, family, set, tier, voicingOctaveUp) {
  return addDictEntry(name, family, set, tier, { chord: true, voicingOctaveUp });
}

Object.entries(FAMILIES).forEach(([famKey, fam]) => {
  fam.modes.forEach((modeName, k) => addDictEntry(modeName, famKey, rotateToDegree(fam.base, k), 'core'));
});
Object.entries(EXOTIC).forEach(([famKey, fam]) => {
  fam.modes.forEach((modeName, k) => addDictEntry(modeName, famKey, rotateToDegree(fam.base, k), 'exotic'));
});
Object.entries(EXTRA_SINGLE).forEach(([name, set]) => addDictEntry(name, 'exotic', set, 'exotic'));

// ── Increment 3: 5/6/8-note scales ───────────────────────────────────────────

// 5 notes — the modes of the major-pentatonic necklace, named by the
// traditional Chinese scale-degree terms (a real, citable naming system,
// safer than inventing English labels). assignDegreeIndices spells every
// mode correctly (Gong "1 2 3 5 6", Yu/minor-pentatonic "1 ♭3 4 5 ♭7", etc.).
// Hirajoshi/In/Kumoi (non-rotations of this necklace, not modes of it) are
// left out of v1 — their exact note-sets vary between sources and need
// verifying before locking into the catalog.
const PENTATONIC = {
  base: [0, 2, 4, 7, 9],
  // Common Western names alongside the Chinese ones where one exists (Jue
  // doesn't have a standard English name).
  modes: ['Gong (Major pentatonic)', 'Shang (Suspended pentatonic)', 'Jue', 'Zhi (Dominant pentatonic)', 'Yu (Minor pentatonic)']
};
PENTATONIC.modes.forEach((name, k) => addDictEntry(name, 'pentatonic', rotateToDegree(PENTATONIC.base, k), 'core'));

// 6 notes. Whole-tone and augmented are `symmetric` (affects rotation
// naming, not spelling — see below); blues is
// ordinary `stepwise`. All three, including blues' repeated-degree blue
// note (both a natural 4 and a raised 4 next to a plain 5), spell correctly
// through assignDegreeIndices' skip/repeat moves — no fixed spelling needed
// for any of them (an earlier version of this hardcoded fixed strings for
// exactly this reason; the alignment algorithm replaces that entirely).
addDictEntry('Whole-tone', 'wholeTone', [0, 2, 4, 6, 8, 10], 'core', { kind: 'symmetric' });
// The whole-tone necklace has only one shape (period 2 semitones → the 6
// rotations alternate between just 2 *transpositions* of that one shape),
// so a single catalog entry already covers every rotation you'll land on.

addDictEntry('Augmented', 'augmented', [0, 3, 4, 7, 8, 11], 'core', { kind: 'symmetric' });
addDictEntry('Augmented (inverse)', 'augmented', [0, 1, 4, 5, 8, 9], 'core', { kind: 'symmetric' });
// Augmented has period 4 (2 distinct shapes, 4 transpositions total) — both
// shapes need their own entry since rotating the abacus can land on either.

addDictEntry('Blues', 'blues', [0, 3, 5, 6, 7, 10], 'core');

// 8 notes — octatonic (symmetric) + composite (parent + added tone).
addDictEntry('Octatonic (half-whole)', 'octatonic', [0, 1, 3, 4, 6, 7, 9, 10], 'core', { kind: 'symmetric' });
addDictEntry('Octatonic (whole-half)', 'octatonic', [0, 2, 3, 5, 6, 8, 9, 11], 'core', { kind: 'symmetric' });
// Period 3 (2 distinct shapes, 3 transpositions each) — same reasoning as augmented.

// Composite scales: parent set + added chromatic tone(s), merged into one
// plain set. `addedRole` describes how the added tone(s) relate to the
// parent set:
//  - 'passing' (default): a connector between two parent tones (e.g. bebop's
//    passing tones filling the gap so the beat lands on a chord tone) —
//    never displaces a parent tone when stacking thirds.
//  - 'alteration': a chromatic clash against one specific parent degree
//    (e.g. flamenco's added ♮3 against Phrygian's own ♭3) — may win a
//    same-slot tie against that parent tone when stacking, since that's
//    the entire point of the added tone.
function addCompositeEntry(name, parentName, parentSet, addedTones, opts) {
  opts = opts || {};
  const fullSet = intervalSet([...parentSet, ...addedTones]);
  return addDictEntry(name, 'composite', fullSet, 'exotic', {
    kind: 'composite', parentName, addedTones, addedRole: opts.role || 'passing'
  });
}

// Parent sets below are existing family rotations, spelled out directly
// rather than looked up, to avoid coupling to FAMILIES' iteration order:
//   Mixolydian       = major, mode 5        = [0,2,4,5,7,9,10]
//   Ionian            = major, mode 1        = [0,2,4,5,7,9,11]
//   Phrygian          = major, mode 3        = [0,1,3,5,7,8,10]  (minor 3rd, i.e. ♭3)
addCompositeEntry('Bebop dominant', 'Mixolydian', [0, 2, 4, 5, 7, 9, 10], [11]);   // + natural 7, passing
addCompositeEntry('Bebop major', 'Ionian', [0, 2, 4, 5, 7, 9, 11], [8]);            // + ♯5/♭6, passing
// Flamenco fusion: the spec text says "Phrygian dominant + ♮3", but Phrygian
// dominant already HAS a natural 3rd (it's the defining feature of that
// mode) — adding one again would be a no-op. The scale this actually
// describes — and the real "flamenco mode" sound, a ♭3/♮3 clash resolving
// over the i chord — is plain Phrygian (natural minor 3rd) with a natural
// 3rd added alongside it. Using that reading; flag if this doesn't match
// what you originally described.
addCompositeEntry('Flamenco fusion', 'Phrygian', [0, 1, 3, 5, 7, 8, 10], [4], { role: 'alteration' }); // + natural 3, alteration

// ── Chord mode (3/4/5 notes) ─────────────────────────────────────────────
// "A three-note scale is just a chord" — these are ordinary SCALE_DICT
// entries like everything above, not a separate system. nameScale() does an
// exact bitmask lookup before anything else, so once a chord's interval set
// is registered here, selecting exactly those notes on the abacus names and
// tables it automatically — the same mechanism that names "Major" or
// "Dorian" today, just with chord vocabulary in the `name` string and a
// 3/4/5-note set instead of 5-8. No new naming or lookup code needed.
//
// Scope is deliberately the same chord families as the project's original
// 2020 chord chart (.claude/chart_righthanded.pdf) — major/minor/dim/aug
// triads, the usual 7th-chord family, and the altered/extended 9th chords
// (7♭9, 7♯9 in particular) that chart named but this app never has, until
// now. 11ths/13ths are 6-7 notes — out of scope for the 3/4/5 bucket here.
addChordEntry('Major triad',        'chordTriad',  [0, 4, 7]);
addChordEntry('Minor triad',        'chordTriad',  [0, 3, 7]);
addChordEntry('Diminished triad',   'chordTriad',  [0, 3, 6]);
addChordEntry('Augmented triad',    'chordTriad',  [0, 4, 8]);
addChordEntry('Suspended 2nd',      'chordTriad',  [0, 2, 7]);
addChordEntry('Suspended 4th',      'chordTriad',  [0, 5, 7]);

addChordEntry('Major 7th',          'chordSeventh', [0, 4, 7, 11]);
addChordEntry('Dominant 7th',       'chordSeventh', [0, 4, 7, 10]);
addChordEntry('Minor 7th',          'chordSeventh', [0, 3, 7, 10]);
addChordEntry('Half-diminished 7th','chordSeventh', [0, 3, 6, 10]);
addChordEntry('Diminished 7th',     'chordSeventh', [0, 3, 6, 9]);
addChordEntry('Minor-major 7th',    'chordSeventh', [0, 3, 7, 11]);
addChordEntry('Augmented major 7th','chordSeventh', [0, 4, 8, 11]);
addChordEntry('Dominant 7♯5',       'chordSeventh', [0, 4, 8, 10]);
addChordEntry('Dominant 7♭5',       'chordSeventh', [0, 4, 6, 10]);
addChordEntry('Major 6th',          'chordSeventh', [0, 4, 7, 9]);
addChordEntry('Minor 6th',          'chordSeventh', [0, 3, 7, 9]);
// Real pop/rock notation ("Cadd9") — a plain triad plus a 9th, with NO 7th
// at all, distinguishing it from an actual 9th chord (which implies one).
// A user found this gap directly: C,D,E,G ("no common name") is exactly
// this shape. voicingOctaveUp tags the added note as a genuine 9 (not a
// bare 2) for the same reason a real 9th chord's own 9 is — an add9 chord
// gets its whole identity from that note being voiced as an upper
// extension, not a cluster tone next to the root.
addChordEntry('Major add9',         'chordSeventh', [0, 2, 4, 7], undefined, [2]);
addChordEntry('Minor add9',         'chordSeventh', [0, 2, 3, 7], undefined, [2]);

// Trailing array: which offsets are the 9th/11th/13th extension(s) — see
// chordVoicingOctaveUp()/addDictEntry's voicingOctaveUp comment above. Core
// tones (root/3rd/5th/7th) are left alone; only genuine "stacked past the
// 7th" extensions get voiced an octave up at playback.
addChordEntry('Major 9th',          'chordNinth',  [0, 2, 4, 7, 11], undefined, [2]);
addChordEntry('Dominant 9th',       'chordNinth',  [0, 2, 4, 7, 10], undefined, [2]);
addChordEntry('Dominant 7♭9',       'chordNinth',  [0, 1, 4, 7, 10], undefined, [1]);
addChordEntry('Dominant 7♯9',       'chordNinth',  [0, 3, 4, 7, 10], undefined, [3]); // 3 is the ♯9 here, not a minor 3rd — the natural 3rd (4) is also present, same as any real "Hendrix chord" voicing
addChordEntry('Minor 9th',          'chordNinth',  [0, 2, 3, 7, 10], undefined, [2]);
addChordEntry('Minor 11th',         'chordNinth',  [0, 3, 5, 7, 10], undefined, [5]); // common voicing: root ♭3 5 ♭7 11, 9th omitted — same note-set as the Yu/minor-pentatonic scale, kept in CHORD_DICT (not SCALE_DICT) precisely so both names stay reachable
// Same "add the 9th" extension as Minor 9th above, but built on Minor-major
// 7th's own natural 7 instead of Minor 7th's ♭7 — added so a near-miss
// match against a minor-family chord with a natural 7 present has an actual
// same-family catalog entry to land on, instead of the closest available
// ♭7-family entry (e.g. Minor 9th) forcing a "♯7" alteration suffix onto
// what's really just a different, named chord family. See Minor-major 11th
// (full)/13th below for the fuller story (that's the one a user actually
// hit — this 5-note version exists for the same reason at its own count).
addChordEntry('Minor-major 9th',    'chordNinth',  [0, 2, 3, 7, 11], undefined, [2]);
addChordEntry('Major 6/9',          'chordNinth',  [0, 2, 4, 7, 9], undefined, [2]);  // same note-set as Gong/major-pentatonic — see above. The 6th (9) stays in the base octave — conventionally voiced close, not stacked like a true upper extension.
addChordEntry('Minor 6/9',          'chordNinth',  [0, 2, 3, 7, 9], undefined, [2]);

// A full 13th chord is theoretically 7 notes (root 3 5 7 9 11 13), but the
// 11th almost always gets dropped in practice — it clashes with the 3rd —
// leaving 6. These are exactly the "omit some notes" shapes any real guitar
// voicing of the chart's own 11/13 entries already has to be.
addChordEntry('Major 13th',    'chordThirteenth', [0, 2, 4, 7, 9, 11], undefined, [2, 9]);  // 9th and 13th; the 7th (11) is a core seventh-chord tone, not bumped
addChordEntry('Dominant 13th', 'chordThirteenth', [0, 2, 4, 7, 9, 10], undefined, [2, 9]);
addChordEntry('Minor 13th',    'chordThirteenth', [0, 2, 3, 7, 9, 10], undefined, [2, 9]);
addChordEntry('Minor 11th (full)',   'chordThirteenth', [0, 2, 3, 5, 7, 10], undefined, [2, 5]); // 9th and 11th
// Minor-major 13th/11th (full): same relationship to Minor 13th/Minor 11th
// (full) as Minor-major 9th has to Minor 9th just above — natural 7 instead
// of ♭7. A user loaded F,G,G#,A#,C#,E (root F, relative 0,2,3,5,8,11 — a
// minor triad + 9 + 11 + a NATURAL 7, i.e. exactly this shape with a raised
// 5th) and got "F Minor 11th (full) ♯5 ♯7": self-contradictory in the same
// way "Dominant 13th ♭13" was (a prior fix) — ♯7 claims the parent's own
// ♭7 got sharped, when what's actually true is this chord belongs to a
// DIFFERENT, already-named family (minor-major, i.e. "FmMaj7" — see
// CHORD_SYMBOL below) rather than being Minor 11th (full) with an
// alteration bolted on. With this entry present, that same note-set now
// matches it with exactly ONE real alteration (♯5, the genuinely altered
// note) instead of forcing a two-alteration, wrong-family fallback match.
addChordEntry('Minor-major 13th',    'chordThirteenth', [0, 2, 3, 7, 9, 11], undefined, [2, 9]);
addChordEntry('Minor-major 11th (full)', 'chordThirteenth', [0, 2, 3, 5, 7, 11], undefined, [2, 5]); // 9th and 11th
addChordEntry('Dominant 9♯11',           'chordThirteenth', [0, 2, 4, 6, 7, 10], undefined, [2, 6]); // 9th and ♯11th
addChordEntry('Dominant 13♭9', 'chordThirteenth', [0, 1, 4, 7, 9, 10], undefined, [1, 9]); // ♭9th and 13th

// Common shorthand for the chord reference table (addRow's 3rd arg) — most
// reuse the exact symbol strings theory.js's own CHORD_QUALITY/EXTRA_QUALITY
// already use elsewhere (masalamap), for consistency rather than inventing
// new abbreviations. Triads with no real shorthand beyond their own short
// name (Major/Minor/Diminished/Augmented triad) are left out on purpose.
const CHORD_SYMBOL = {
  'Suspended 2nd': 'sus2', 'Suspended 4th': 'sus4',
  'Major 7th': 'maj7', 'Dominant 7th': '7', 'Minor 7th': 'm7',
  'Half-diminished 7th': 'ø7', 'Diminished 7th': '°7', 'Minor-major 7th': 'mMaj7',
  'Augmented major 7th': '+maj7', 'Dominant 7♯5': '7♯5', 'Dominant 7♭5': '7♭5',
  'Major 6th': '6', 'Minor 6th': 'm6', 'Major add9': 'add9', 'Minor add9': 'madd9',
  'Major 9th': 'maj9', 'Dominant 9th': '9', 'Dominant 7♭9': '7♭9', 'Dominant 7♯9': '7♯9',
  'Minor 9th': 'm9', 'Minor 11th': 'm11', 'Major 6/9': '6/9', 'Minor 6/9': 'm6/9',
  'Major 13th': 'maj13', 'Dominant 13th': '13', 'Minor 13th': 'm13',
  'Minor 11th (full)': 'm11', 'Dominant 9♯11': '9♯11', 'Dominant 13♭9': '13♭9',
  'Minor-major 9th': 'mMaj9', 'Minor-major 13th': 'mMaj13', 'Minor-major 11th (full)': 'mMaj11',
};

// The 12-note row in the library replaces what used to be a separate
// "Chromatic" toggle with its own on/off state; this
// is the same SCALE_DICT mechanism as everything else, so nameScale() names
// it "<root> Chromatic" for free.
addDictEntry('Chromatic', 'chromatic', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'core');

function dictEntryByName(name) { return DICT_ENTRIES.find(e => e.name === name); }

// Beginner view's curated reference table — the 5 scales most people reach
// for, deliberately labeled without any "mode" terminology (Major/Minor
// rather than Ionian/Aeolian) even though they're drawn from the same
// catalog entries as the advanced view.
// `chord: true` on the two triads matters beyond labeling them correctly —
// clicking one sets chordMode to match (see renderTable's beginner branch),
// which is what keeps the mode-stepper's "Mode"/"Inversion" label and the
// (Advanced-only) note-count buttons in sync with whatever's actually
// loaded, rather than trusting whatever chordMode happened to be set to
// before Beginner was entered.
const BEGINNER_SCALES = [
  { label: 'Major',            set: FAMILIES.major.base },                    // Ionian
  { label: 'Minor',             set: rotateToDegree(FAMILIES.major.base, 5) }, // Aeolian
  { label: 'Major pentatonic',  set: PENTATONIC.base },                        // Gong
  { label: 'Minor pentatonic',  set: rotateToDegree(PENTATONIC.base, 4) },     // Yu
  { label: 'Blues',             set: dictEntryByName('Blues').set },
  // All 12. Not a scale anyone plays through as such, but it's the one
  // that shows what every other row is a SELECTION FROM — which is
  // exactly the point a beginner needs, and why it belongs in this list
  // rather than only behind Advanced's note-count 12.
  { label: 'Chromatic',         set: dictEntryByName('Chromatic').set },
  // Chords. Major/Minor triad were the only two here for a while, which a
  // user read as "there are no chords in Beginner" — two rows at the
  // bottom of a scale list don't announce themselves as a category. The
  // set below is the smallest one that covers most of what a beginner
  // actually meets in real songs: the two triads, the three seventh
  // chords that between them harmonise a whole major key (maj7 on I/IV,
  // m7 on ii/iii/vi, dominant 7th on V), and sus4 as the one non-tertian
  // shape that turns up constantly in pop and folk. Deliberately NOT the
  // diminished/augmented/altered end of the catalogue — that's what
  // Advanced is for.
  { label: 'Major triad',       set: dictEntryByName('Major triad').set, chord: true },
  { label: 'Minor triad',       set: dictEntryByName('Minor triad').set, chord: true },
  { label: 'Suspended 4th',     set: dictEntryByName('Suspended 4th').set, chord: true },
  { label: 'Dominant 7th',      set: dictEntryByName('Dominant 7th').set, chord: true },
  { label: 'Major 7th',         set: dictEntryByName('Major 7th').set, chord: true },
  { label: 'Minor 7th',         set: dictEntryByName('Minor 7th').set, chord: true },
];

// ── §3 interactive scale naming ──────────────────────────────────────────────

function semitoneDist(a, b) { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); }
function alterationSign(e, m) { return (((e - m) % 12 + 12) % 12) === 1 ? '♯' : '♭'; }

// Find a perfect matching between `extra` (notes only in current scale) and
// `missing` (notes only in the candidate parent), where every pair is exactly
// one semitone apart. Supports 1 or 2 alterations.
//
// Degree numbers come from the SAME reference-slot assignment bead labels
// use (assignDegreeIndices/MAJOR_REF) — NOT the note's own ordinal position
// (rank) within parentSet, which an earlier version of this used instead.
// Rank and true degree only coincide for a plain 7-note diatonic set (a
// scale's own 1st/2nd/3rd... note IS scale-degree 1/2/3...) — which is
// exactly the case this was originally written and tested against. Chords
// skip degrees (a triad has no 2nd or 4th at all), so for anything else
// they diverge: Dominant 13th's set [0,2,4,7,9,10] has 7 (a true 5th) as
// its 4th-ranked note and 9 (a true 6th/13th) as its 5th-ranked one — rank-
// based numbering was mislabeling an altered 13th as "♭5", a real bug a
// user caught (loaded [0,2,4,7,8,10], named "Dominant 13th ♭5" while its
// own beads correctly read R 2 3 5 ♭6 ♭7 — two different, contradictory
// degree numbers for the exact same altered note).
//
// entry: the full candidate DICT_ENTRIES object (not just its .set) — its
// OWN voicingOctaveUp (see addDictEntry above) decides, per note, whether
// that note's degree number should print as a compressed 2nd/4th/6th or
// an extended 9th/11th/13th, the SAME data playback and exact-match bead
// labels (chordAwareBeadLabel) already use for this. That per-note nuance
// matters: a 6/9 chord's own 6th is deliberately voiced close (NOT an
// extension — see that entry's own comment above), even though it sits in
// the same reference slot a 13th would. An earlier version of this used a
// blanket "chords with 5+ notes always extend slots 1/3/5" rule instead,
// which correctly fixed a 13-chord case but then wrongly turned an
// altered 6/9 chord's own ♭6 into a nonsensical "♭13" — falling back to
// that same blanket rule only when the candidate has no voicingOctaveUp
// of its own to consult (a plain scale, or a chord under 5 notes, where
// the concept doesn't apply at all).
function matchAlterations(extra, missing, entry) {
  const parentSet = entry.set;
  const assign = assignDegreeIndices(parentSet);
  const extendChordDegrees = entry.isChord && parentSet.length >= 5;
  const degreeOf = m => {
    const slot = assign[parentSet.indexOf(m)];
    const num = slot + 1;
    const shouldExtend = entry.voicingOctaveUp
      ? entry.voicingOctaveUp.includes(m)
      : extendChordDegrees && (slot === 1 || slot === 3 || slot === 5);
    return shouldExtend ? num + 7 : num;
  };
  if (extra.length === 0 || extra.length !== missing.length || extra.length > 2) return null;
  if (extra.length === 1) {
    if (semitoneDist(extra[0], missing[0]) !== 1) return null;
    return [{ degree: degreeOf(missing[0]), symbol: alterationSign(extra[0], missing[0]), missing: missing[0], extra: extra[0] }];
  }
  const [e1, e2] = extra, [m1, m2] = missing;
  if (semitoneDist(e1, m1) === 1 && semitoneDist(e2, m2) === 1) {
    return [{ degree: degreeOf(m1), symbol: alterationSign(e1, m1), missing: m1, extra: e1 },
            { degree: degreeOf(m2), symbol: alterationSign(e2, m2), missing: m2, extra: e2 }];
  }
  if (semitoneDist(e1, m2) === 1 && semitoneDist(e2, m1) === 1) {
    return [{ degree: degreeOf(m2), symbol: alterationSign(e1, m2), missing: m2, extra: e1 },
            { degree: degreeOf(m1), symbol: alterationSign(e2, m1), missing: m1, extra: e2 }];
  }
  return null;
}

// For a near-miss/altered chord (no exact catalog identity of its own):
// which of ITS OWN notes should be treated as 9th/11th/13th extensions,
// for the bead labels and octave-bump playback that show/sound this exact
// set — reusing the SAME reasoning matchAlterations already used to pick
// the chord's alteration suffix, rather than each of those three places
// (name, label, playback) recomputing this independently and risking
// landing on three different answers for the same note (a user caught
// exactly this: a chord named "...(♭6)" whose own bead showed "♭13"
// instead, and whose 9th played back as a plain, un-bumped 2nd). An
// unaltered/shared note extends exactly when the matched parent's own
// data (voicingOctaveUp, or its general slot rule) says so; an altered
// note extends exactly when matchAlterations already decided to print its
// degree as an extension (degree > 7).
function fallbackExtensionOffsets(rooted, best) {
  const { entry, alterations } = best;
  const alteredExtras = new Set(alterations.filter(a => a.degree > 7).map(a => a.extra));
  const assign = assignDegreeIndices(entry.set);
  const extendGeneral = entry.set.length >= 5; // entry.isChord already guaranteed by the caller
  const out = [];
  rooted.forEach(note => {
    if (alteredExtras.has(note)) { out.push(note); return; }
    const idxInParent = entry.set.indexOf(note);
    if (idxInParent === -1) return; // shouldn't happen for a non-altered note, but don't guess if it does
    const slot = assign[idxInParent];
    const shouldExtend = entry.voicingOctaveUp
      ? entry.voicingOctaveUp.includes(note)
      : extendGeneral && (slot === 1 || slot === 3 || slot === 5);
    if (shouldExtend) out.push(note);
  });
  return out.length ? out : null;
}

// A chord's own trailing number ("...13th") is a factual claim — the
// natural 13th really is one of its notes. If the one alteration found
// against it happens to replace exactly that note, keeping the claim in
// the name while ALSO saying that same note is altered reads as
// self-contradictory ("Dominant 13th ♭13" — do we have a natural 13th or
// not?) even though the alteration math itself is correct (a user caught
// exactly this: "we have a 13 chord, but alter the 13 by adding the
// ♭13?"). Real chord-symbol practice resolves this by dropping to the
// next extension that IS still fully intact and writing the altered tone
// as a parenthesized addition instead — "Dominant 9th (♭13)", not
// "Dominant 13th ♭13".
//
// Rather than parse the entry's own name and guess a "one number down"
// replacement (which broke for chords that aren't a clean stack-of-thirds
// chain — a 6/9 chord minus its 6 isn't "a 9th chord", it's a plain triad
// plus an added 9th, a different shape entirely), this looks for a REAL
// catalog chord whose own note-set is EXACTLY "this entry's notes, minus
// the altered one" — an exact bitmask match, not a name-based guess. If
// no such chord exists (as for the 6/9 case above), this correctly
// declines to demote at all, leaving the honest plain-suffix name instead
// of inventing a misleading one.
function demotedChordName(entry, alterations) {
  if (!entry.isChord || alterations.length !== 1) return null;
  const { degree, symbol, missing } = alterations[0];
  const remaining = entry.set.filter(x => x !== missing);
  const demoted = DICT_ENTRIES.find(e => e.isChord && e !== entry && bitmaskOf(e.set) === bitmaskOf(remaining));
  return demoted ? `${demoted.name} (${symbol}${degree})` : null;
}

function nameScale(positions) {
  const rooted = intervalSet(positions);
  // Always computed fresh (never cached on the catalog entry) so it stays
  // correct as rootPitchClass/labelMode change — see formulaOf.
  const formula = formulaOf(rooted, labelMode, rootPitchClass);

  // Exact catalog hit — pass `kind`/`entry` through so bead rendering can
  // apply the right treatment (hollow "added" bead for composite scales,
  // see renderAbacus). Checks whichever of SCALE_DICT/CHORD_DICT the current
  // mode favors first, falling back to the other — a few note-sets (e.g. a
  // 6/9 chord and the major-pentatonic scale) are the exact same notes and
  // exist in both dicts, so mode decides which name wins when both apply;
  // the fallback just means a name is never missed outside that overlap.
  const mine = chordMode ? CHORD_DICT : SCALE_DICT, other = chordMode ? SCALE_DICT : CHORD_DICT;
  const exact = mine[bitmaskOf(rooted)] || other[bitmaskOf(rooted)];
  // extensionOffsets: which of THIS set's own raw offsets should be shown/
  // played as 9th/11th/13th extensions — the single shared answer
  // chordAwareBeadLabel and chordVoicingOctaveUp both read, instead of
  // each re-deriving it their own way (which is exactly how the label,
  // the chord name's own alteration suffix, and playback previously
  // ended up disagreeing about the very same note).
  if (exact) {
    return {
      exact: true, name: exact.name, formula, kind: exact.kind, entry: exact,
      extensionOffsets: (exact.isChord && exact.voicingOctaveUp) || null, alterations: null,
    };
  }

  const card = rooted.length;
  let best = null;
  for (const e of DICT_ENTRIES) {
    // Also mode-filtered, same reasoning as the exact-match dict choice
    // above — a near-miss scale shouldn't get named against the chord
    // catalog's closest shape, or vice versa.
    if (e.set.length !== card || !!e.isChord !== chordMode) continue;
    const extra   = rooted.filter(x => !e.set.includes(x));
    const missing = e.set.filter(x => !rooted.includes(x));
    const alterations = matchAlterations(extra, missing, e);
    if (!alterations) continue;
    if (!best || alterations.length < best.alterations.length) {
      best = { entry: e, alterations };
      if (alterations.length === 1) break; // can't do better than one alteration
    }
  }
  if (best) {
    // best.entry.isChord is guaranteed === chordMode by the loop's own
    // filter above, so this is really just "skip the concept for scales".
    const extensionOffsets = best.entry.isChord ? fallbackExtensionOffsets(rooted, best) : null;
    const demoted = demotedChordName(best.entry, best.alterations);
    if (demoted) return { exact: false, name: demoted, formula, parent: best.entry.name, kind: 'stepwise', extensionOffsets, alterations: best.alterations };
    const labels = best.alterations.slice().sort((a, b) => a.degree - b.degree)
      .map(a => `${a.symbol}${a.degree}`).join(' ');
    return { exact: false, name: `${best.entry.name} ${labels}`, formula, parent: best.entry.name, kind: 'stepwise', extensionOffsets, alterations: best.alterations };
  }
  return { exact: false, name: 'no common name', formula, kind: 'stepwise', extensionOffsets: null, alterations: null };
}

// mk()/SVG_NS now live in shared/theory.js (identical implementation).

// ── data model ────────────────────────────────────────────────────────────────

let scaleOffsets = [0, 2, 4, 5, 7, 9, 11]; // major / Ionian, relative to root
let rootPitchClass = 0;                     // 0 = C

const semitone = pc => ((pc - rootPitchClass) % 12 + 12) % 12;

// Real key signatures split the 12 keys roughly in half by which accidental
// they conventionally use — C/D/E/G/A/B (the natural-letter keys, plus B)
// are written with sharps; F and the 5 remaining accidental keys (Db/Eb/
// Gb/Ab/Bb) are written with flats — matching the real fake-book convention
// (Eb major, not D# major; F major, not... F has no enharmonic twin, it's
// just the one flat key among the naturals). This is deliberately different
// from absoluteNoteName() in theory.js, which spells each SCALE MEMBER by
// its own relative-degree accidental (so a Phrygian ♭2 reads as a flat
// regardless of key) — that per-note logic doesn't apply to fixed,
// scale-independent reference labels like the piano's key names or the
// fretboard's open-string tuner labels, which instead should all agree
// with the CURRENT KEY's own overall sharp/flat leaning, the way a real
// instrument method book stays consistent across an entire fixed diagram.
const FLAT_LEANING_KEYS = new Set([1, 3, 5, 6, 8, 10]); // Db Eb F Gb Ab Bb
function keyAwareNoteName(pc) {
  return FLAT_LEANING_KEYS.has(rootPitchClass) ? FLAT_NAMES[pc] : NOTE_NAMES[pc];
}

// armband state: the 7 absolute pitch classes of the current collection
// (fixed during a rotation gesture) and which of them is currently the root.
let armPCs = [];
let armRootIdx = 0;

// A genuine bug lived in the ".sort((a,b) => a-b)" this used to end with:
// sorting by raw absolute pitch class (0-11, with C = 0 as an arbitrary
// zero point) scrambles the collection's own ascending-from-root order
// whenever some note's absolute pitch class wraps below the root's own
// number — e.g. D Dominant 7th (D,F#,A,C) has C=0 sitting numerically
// BELOW D=2, even though C is the chord's own ♭7 (its last/highest note,
// not its first). That silently made armPCs[0] the ♭7 instead of the
// root, so armRootIdx (found via indexOf(rootPitchClass) in that scrambled
// order) came out as 1, not 0 — "Inversion 2/4" on a freshly-loaded,
// entirely unrotated chord, and every stepMode() press one full inversion
// further off than its own label claimed (a user caught this reporting
// "can't select 1st inversion, it jumps to 2nd"). Only ever invisible for
// a C-rooted chord/scale, where root=0 already sorts first by coincidence
// — which is probably why nothing caught it until testing a different key.
//
// scaleOffsets is ALREADY exactly the right order with no sort needed:
// it's kept ascending-from-the-CURRENT-root by construction (see
// applyArmRotation's own re-sort after every rotation), so mapping it to
// absolute pitch class here, in place, preserves "root, then each next
// chord tone/scale degree in turn" — which is both the correct definition
// of a scale's modal rotation order AND a chord's inversion order.
//
// But that fix introduced a NEW bug of its own, caught immediately after
// shipping it: since a freshly-rotated scaleOffsets is ALWAYS re-sorted to
// start at 0 relative to whichever note is now root (applyArmRotation's
// own doing), rebuilding armPCs from it HERE, unconditionally, on every
// single render() — including the render() applyArmRotation itself
// triggers right after carefully setting armRootIdx to the step just
// taken — always recomputes armRootIdx back to 0. A user caught this as
// "stepping from 1/4 to 2/4 immediately snaps the label back to 1/4 (with
// the new key)" — correctly diagnosing that the CHORD had genuinely
// rotated, just not the label.
//
// The fix: armPCs/armRootIdx are this collection's own STABLE identity —
// they should only be rebuilt from scratch when the collection itself is
// actually a different set of notes (a fresh load: a library pick, a
// dragged bead, a new note-count/mode). A same-membership call (any
// ordinary re-root — stepMode, or this render() firing right after it)
// leaves them alone entirely, trusting whatever applyArmRotation already
// set. bitmaskOf ignores order/rotation and only cares about MEMBERSHIP,
// which is exactly the right equality check here.
function syncArmband() {
  const currentPCs = scaleOffsets.map(o => (o + rootPitchClass) % 12);
  if (bitmaskOf(currentPCs) === bitmaskOf(armPCs)) return;
  armPCs = currentPCs;
  armRootIdx = armPCs.indexOf(rootPitchClass);
}

// ── root selector ─────────────────────────────────────────────────────────────

// NOTE_NAMES/FLAT_NAMES/absoluteNoteName now live in shared/theory.js —
// absoluteNoteName there takes rootPitchClass as an explicit 4th param
// instead of reading it off this file's global (see call sites below).

// Common practice (matching most keyboards/DAWs/tuners) is to show both
// enharmonic spellings for the 5 accidental root notes — "C♯/D♭" rather
// than picking one arbitrarily — since which one's "correct" depends on
// the key/scale context a root picker doesn't know yet. Natural notes have
// no such ambiguity, so they stay a single letter.
function rootLabel(i) {
  const sharp = NOTE_NAMES[i];
  return sharp.includes('#') ? sharp.replace('#', '♯') + '/' + FLAT_NAMES[i] : sharp;
}

function renderRoot() {
  const div = document.getElementById('root-selector');
  div.innerHTML = '';
  NOTE_NAMES.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'root-btn' + (i === rootPitchClass ? ' active' : '');
    b.textContent = rootLabel(i);
    b.onclick = () => { rootPitchClass = i; render(); };
    div.appendChild(b);
  });

  // Custom dropdown (see wireDropdown) — not a native <select>,
  // which ignores author CSS for its own colors on iOS/WKWebView
  // regardless of appearance:none/color-scheme (both tried, reported
  // still light gray both times). Options are rebuilt only once (same
  // "only if the count changed" guard the old <select> version had) —
  // render() runs on every interaction, and root-picking is rare enough
  // that rebuilding the list every time would be pure waste.
  const list = document.getElementById('root-select-list');
  if (list.children.length !== NOTE_NAMES.length) {
    list.innerHTML = '';
    NOTE_NAMES.forEach((name, i) => {
      const opt = document.createElement('div');
      opt.className = 'dropdown-option';
      opt.setAttribute('role', 'option');
      opt.dataset.pc = i;
      opt.textContent = rootLabel(i);
      opt.addEventListener('click', () => {
        rootPitchClass = i;
        closeRootSelectMobile();
        render();
      });
      list.appendChild(opt);
    });
  }
  list.querySelectorAll('.dropdown-option').forEach(opt => {
    const active = Number(opt.dataset.pc) === rootPitchClass;
    opt.classList.toggle('active', active);
    opt.setAttribute('aria-selected', active);
  });
  document.getElementById('root-select-value').textContent = rootLabel(rootPitchClass);
}

// The Relative/Absolute buttons this used to keep in sync are gone from
// the DOM entirely now (see the note where they used to sit in the Setup
// dialog) — both readings are always visible at once, so there was nothing
// left for them to switch. Only setViewMode's own "Beginner forces
// relative" call reaches this any more; it stays because that's still a
// real state change the abacus/name/table all have to be told about.
function setLabelMode(mode) {
  labelMode = mode;
  localStorage.setItem('n4a-label-mode', mode);
  abacusController.setLabelMode(mode);
  renderName();
  renderTable();
}

// Beginner view swaps in a curated 5-scale reference table (no "modes"
// vocabulary) and hides the mode-stepper — the abacus itself and
// scale-name readout stay fully interactive in both views, so
// beginners can still drag beads into "exotic" shapes.
function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('n4a-view-mode', mode);
  const modeSwitch = document.getElementById('view-mode-switch');
  modeSwitch.setAttribute('aria-checked', mode === 'beginner' ? 'true' : 'false');
  modeSwitch.querySelectorAll('.mode-switch-opt').forEach(o => o.classList.toggle('active', o.dataset.mode === mode));
  // Only the library changes — the mode stepper and voicing stay on the
  // main screen in both, which is why the switch lives in the library.
  // Beginner keeps #notecount-group (the Scale/Chord toggle, which
  // Beginner needs too — see the split in renderTable's beginner branch).
  document.getElementById('notecount-group').style.display = '';
  document.querySelector('.ref-controls').style.display = mode === 'beginner' ? 'none' : '';
  // The Relative/Absolute group this used to show/hide per view mode no
  // longer exists at all — nothing left to toggle here either way.
  // Both views split their list by the Scale/Chord toggle now, so the
  // library's own title can say which one you're looking at in both.
  syncChordModeUI();
  // Relative degree numbers (R, 2, ♭3...) read as a teaching tool — seeing
  // a scale's own shape/formula, not just which raw notes it happens to
  // land on — which is exactly the point in Beginner mode. Was forced to
  // absolute instead; flipped once relative turned out to be the more
  // intuitive default overall (see labelMode's own declaration comment).
  if (mode === 'beginner') setLabelMode('relative'); // also re-renders table/abacus/etc.
  else renderTable();
}

// ── abacus ────────────────────────────────────────────────────────────────────

const AB_L  = 40;    // track left x
const AB_R  = 720;   // track right x
const AB_TY = 42;    // track y centre
const AB_BR = 15;    // bead radius
// Standing upright (see setVertical below) the abacus is a touch target in
// a narrow column, not a display spanning a wide row — a bit bigger reads
// better there, per the user's own on-device report.
const AB_BR_VERTICAL = 19;
const AB_STEP = (AB_R - AB_L) / 12;

const atX    = pos => AB_L + pos * AB_STEP;
const aXtoP  = x   => (x - AB_L) / AB_STEP;

// Rendering + drag interaction now live in ../shared/abacus.js (so
// masalamap/fusionmap can each create their own instance) — this file just
// configures one instance with spicemap's own geometry/audio, and keeps
// AB_L/AB_R/AB_TY/AB_BR/AB_STEP/atX/aXtoP above as plain constants/pure
// functions (unchanged) since the mode-stepping code below positions itself
// off the exact same values, and `abacusController`
// itself is configured with these same numbers so the two stay pixel-
// aligned automatically.
const abacusController = createAbacus(document.getElementById('abacus'), {
  scaleOffsets, rootPitchClass, labelMode,
  left: AB_L, right: AB_R, y: AB_TY, beadRadius: AB_BR, width: 760,
  tickInactiveColor: getComputedStyle(document.documentElement).getPropertyValue('--panel-solid').trim(),
  // Tap an empty spot to add a note, drag a bead off the track to remove
  // it — how the number of notes is changed now (the old 5/6/7/8/12
  // buttons became the library's filter).
  resizable: true,
  onChange(newOffsets) { scaleOffsets = newOffsets; render(); },
  onBeadPlay(offset, hypotheticalSet) { playScaleDegree(offset, hypotheticalSet); },
  labelFn: chordAwareBeadLabel,
});

// ── scale name display ───────────────────────────────────────────────────────

function renderName() {
  const r = nameScale(scaleOffsets);
  // Beginner view avoids mode terminology — when the current shape is
  // exactly one of the curated 5 (the common case, picked straight from
  // the reference table), show its plain name instead of the catalog's
  // modal one (e.g. "Major" not "Ionian"). A shape reached by dragging
  // beads into something else entirely still falls through to the normal
  // catalog name — that's the user's own exploration, not the curated set.
  let name = r.name;
  if (viewMode === 'beginner') {
    const rooted = intervalSet(scaleOffsets);
    const match = BEGINNER_SCALES.find(b => bitmaskOf(b.set) === bitmaskOf(rooted));
    if (match) name = match.label;
  }
  const el = document.getElementById('scale-name');
  const label = name === 'no common name' ? name : `${NOTE_NAMES[rootPitchClass]} ${name}`;
  // No note-name/degree formula line here — that's already shown live on
  // the abacus beads themselves, so repeating it under the name was
  // redundant.
  el.innerHTML = `<span class="name${r.exact ? '' : ' fallback'}">${label}</span>`;
}

// ── §1 root cycling — animated mode stepping on the abacus itself ───────────
//
// Stepping to the next/previous mode re-roots the same 7-pitch-class
// collection (armPCs). Every bead's position shifts by the same signed
// semitone delta; exactly one bead (the one crossing the track boundary)
// "wraps" — it fades out, jumps invisibly to the opposite edge, then fades
// back in sliding to its target. Colors and labels (which encode function,
// not pitch) only update once every bead has arrived.

function applyArmRotation(newIdx) {
  const n = armPCs.length;
  armRootIdx = ((newIdx % n) + n) % n;
  rootPitchClass = armPCs[armRootIdx];
  scaleOffsets = armPCs.map(pc => ((pc - rootPitchClass) % 12 + 12) % 12).sort((a, b) => a - b);
  render();
}

// Mechanically identical in both modes (re-root the same absolute-pitch
// collection, see applyArmRotation above) — but "Mode" is scale-specific
// vocabulary that doesn't mean anything for a chord. "Inversion" is the
// nearest chord-literate term for "which chord tone is currently treated as
// root," even though it's not textbook-precise (a real inversion is about
// which tone is in the bass, not which is the interval reference). Shared
// by renderModeLabel and stepMode's own mid-animation label update — that
// second call site used to hardcode "Mode", which is why the label used to
// flash back to "Mode" for the ~650ms of a rotation before settling back to
// "Inversion" in chord mode.
function modeLabelText(idx, total) {
  return `${chordMode ? 'Inversion' : 'Mode'} ${idx + 1}/${total}`;
}

function renderModeLabel() {
  document.getElementById('mode-label').textContent = modeLabelText(armRootIdx, armPCs.length);
}

let animating = false;

function setModeControlsDisabled(v) {
  document.getElementById('mode-prev').disabled = v;
  document.getElementById('mode-next').disabled = v;
}

function stepMode(dir) {
  if (animating) return;
  const n = armPCs.length;
  const newIdx = ((armRootIdx + dir) % n + n) % n;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    applyArmRotation(newIdx);
    return;
  }

  const newRootPC = armPCs[newIdx];
  let delta = ((newRootPC - rootPitchClass) % 12 + 12) % 12; // old position of the new root
  if (dir < 0) delta -= 12;                                   // small negative shift for "prev"

  const moves = abacusController.beads.map((bead, i) => {
    const oldPos = scaleOffsets[i];
    let newPos = oldPos - delta;
    let wrap = false;
    if (newPos < 0)  { newPos += 12; wrap = true; }
    if (newPos > 11) { newPos -= 12; wrap = true; }
    return { bead, idx: i, newPos, wrap };
  });

  animating = true;
  setModeControlsDisabled(true);
  document.getElementById('mode-label').textContent = modeLabelText(newIdx, n);

  const FADE = 120, SLIDE = 260, COLOR = 180;

  moves.forEach(({ bead, newPos, wrap }) => {
    if (!wrap) {
      bead.circle.style.transition = `cx ${SLIDE}ms ease`;
      bead.lbl.style.transition = `x ${SLIDE}ms ease`;
      bead.circle.setAttribute('cx', atX(newPos));
      bead.lbl.setAttribute('x', atX(newPos));
      return;
    }
    // wrapping bead: fade out in place, jump off-canvas past the far edge, fade back in sliding home
    const phantomPos = dir > 0 ? newPos + 12 : newPos - 12;
    bead.circle.style.transition = `opacity ${FADE}ms ease`;
    bead.lbl.style.transition = `opacity ${FADE}ms ease`;
    bead.circle.style.opacity = '0';
    bead.lbl.style.opacity = '0';
    setTimeout(() => {
      bead.circle.style.transition = 'none';
      bead.lbl.style.transition = 'none';
      bead.circle.setAttribute('cx', atX(phantomPos));
      bead.lbl.setAttribute('x', atX(phantomPos));
      bead.circle.getBoundingClientRect(); // force reflow so the jump isn't transitioned
      bead.circle.style.transition = `cx ${SLIDE - FADE}ms ease, opacity ${SLIDE - FADE}ms ease`;
      bead.lbl.style.transition = `x ${SLIDE - FADE}ms ease, opacity ${SLIDE - FADE}ms ease`;
      bead.circle.setAttribute('cx', atX(newPos));
      bead.lbl.setAttribute('x', atX(newPos));
      bead.circle.style.opacity = '1';
      bead.lbl.style.opacity = '1';
    }, FADE);
  });

  setTimeout(() => {
    moves.forEach(({ bead, idx, newPos }) => {
      bead.circle.style.transition = `fill ${COLOR}ms ease`;
      bead.circle.setAttribute('fill', icolor(newPos));
      bead.lbl.setAttribute('fill', textColorFor(newPos));
      bead.lbl.textContent = chordAwareBeadLabel(idx, newPos, scaleOffsets, labelMode, rootPitchClass);
    });
    setTimeout(() => {
      applyArmRotation(newIdx); // commits state and does a clean, already-settled re-render
      animating = false;
      setModeControlsDisabled(false);
    }, COLOR);
  }, SLIDE);
}

// ── §4 fretboard (with handedness + player's-eye perspective) ───────────────
//
// Two perspective cues, layered:
//  1. Frets use the real equal-temperament spacing formula (they bunch up
//     toward the body) instead of being evenly spaced.
//  2. Each string's fret positions are compressed toward the nut by a
//     different amount: the string nearest the player's eye (low E) is
//     compressed the least and reads as "longer"; the far string (high E)
//     is compressed the most and reads as "shorter". Same idea as the
//     per-string divisor in R/fretboard.R's pos_x(), reworked for this SVG's
//     coordinate system rather than ported line-for-line.

// Tunings, top→bottom in SVG (highest string index 0, lowest string last).
// Every fretted instrument shares this one renderer — only the tuning array
// (and therefore string count/spacing/thickness) changes; all the taper/
// perspective math below is generic and doesn't know or care which
// instrument it's drawing.
const TUNINGS = {
  // nutT/nutB: vertical span the strings are spread across — same center
  // (124) throughout, just a narrower or wider span depending on string
  // count, not strictly proportional (more strings still get a bit more
  // breathing room per string, not less).
  // openMidi: the *real* absolute MIDI note of each open string (same order
  // as openPc — high-string-first). Used for actual playback so a fret
  // click sounds at its true physical pitch; openPc alone (a bare 0-11
  // pitch class) is kept for scale-membership/coloring, which only cares
  // about pitch class and would otherwise be unaffected by this. Reentrant
  // tunings (ukulele's G string, banjo's 5th "drone" string) fall out
  // correctly here since these are real absolute notes, not derived from a
  // monotonic string-to-string interval.
  // Baseline is standard 6-string tuning with the low E dropped (a real,
  // sometimes-used simplification); "Jacob Collier" is a named preset
  // below, not the baseline, since it's a specific alternate tuning, not
  // "the" 5-string guitar tuning.
  guitar5: { openPc: [4, 11, 7, 2, 9],            openMidi: [64, 59, 55, 50, 45],                 thickness: [0.8, 3.0], nutT: 58,   nutB: 190 },  // E4 B3 G3 D3 A2
  guitar:  { openPc: [4, 11, 7, 2, 9, 4],         openMidi: [64, 59, 55, 50, 45, 40],             thickness: [0.8, 3.0], nutT: 49,   nutB: 199 },  // E4 B3 G3 D3 A2 E2
  guitar7: { openPc: [4, 11, 7, 2, 9, 4, 11],     openMidi: [64, 59, 55, 50, 45, 40, 35],         thickness: [0.8, 3.0], nutT: 43,   nutB: 205 },  // adds low B1
  guitar8: { openPc: [4, 11, 7, 2, 9, 4, 11, 6],  openMidi: [64, 59, 55, 50, 45, 40, 35, 30],     thickness: [0.7, 3.0], nutT: 43.5, nutB: 204.5 }, // adds low B1, F#1
  bass:    { openPc: [7, 2, 9, 4],                openMidi: [43, 38, 33, 28],                     thickness: [1.6, 4.6], nutT: 72,   nutB: 177 },  // G2 D2 A1 E1
  bass5:   { openPc: [7, 2, 9, 4, 11],            openMidi: [43, 38, 33, 28, 23],                 thickness: [1.5, 4.6], nutT: 58,   nutB: 190 },  // adds low B0
  bass6:   { openPc: [0, 7, 2, 9, 4, 11],         openMidi: [48, 43, 38, 33, 28, 23],             thickness: [1.4, 4.6], nutT: 49,   nutB: 199 },  // adds high C3, low B0
  ukulele: { openPc: [7, 0, 4, 9],                openMidi: [67, 60, 64, 69],                     thickness: [0.7, 1.1], nutT: 79,   nutB: 169 },  // G4 C4 E4 A4 (reentrant: the G is genuinely higher than the C next to it)
  mandolin:{ openPc: [4, 9, 2, 7],                openMidi: [76, 69, 62, 55],                     thickness: [0.6, 1.0], nutT: 85,   nutB: 163 },  // E5 A4 D4 G3
  banjo:   { openPc: [7, 2, 11, 7, 2],            openMidi: [67, 62, 59, 55, 50],                 thickness: [0.7, 2.0], nutT: 68,   nutB: 180 }   // 5-string open G (g4 D4 B3 G3 D3), 5th "drone" string approximated full-length — see SPEC discussion
};
const INSTRUMENT_FAMILY = {
  guitar5: 'guitar', guitar: 'guitar', guitar7: 'guitar', guitar8: 'guitar',
  bass: 'bass', bass5: 'bass', bass6: 'bass',
  ukulele: 'ukulele', mandolin: 'mandolin', banjo: 'banjo', piano: 'piano'
};
const INSTRUMENT_LABEL = {
  guitar5: 'Guitar (5-string)', guitar: 'Guitar', guitar7: 'Guitar (7-string)', guitar8: 'Guitar (8-string)',
  bass: 'Bass', bass5: 'Bass (5-string)', bass6: 'Bass (6-string)',
  ukulele: 'Ukulele', mandolin: 'Mandolin', banjo: 'Banjo', piano: 'Piano'
};
function stringsOf(instr) {
  const m = instr.match(/\d+$/);
  if (m) return Number(m[0]);
  return instr === 'guitar' ? 6 : instr === 'bass' ? 4 : null;
}

let instrument = localStorage.getItem('n4a-instrument') || 'guitar'; // any TUNINGS key, or 'piano'
if (!TUNINGS[instrument] && instrument !== 'piano') instrument = 'guitar'; // guard against a stale/unknown stored key
// Free tier only has guitar/piano — fall back if a stale localStorage value
// (from a previous paid session, or a different tier) points elsewhere.
if (tier === 'free' && !['guitar', 'guitar7', 'guitar8', 'piano'].includes(instrument)) instrument = 'guitar';
if (tier === 'free') localStorage.setItem('n4a-keyboard-sound', 'piano'); // organ is paid-only

// Last-used string count per family, so switching Guitar -> Bass -> Guitar
// comes back to whichever guitar variant you had, not always the 6-string.
let guitarStrings = INSTRUMENT_FAMILY[instrument] === 'guitar' ? stringsOf(instrument) : (Number(localStorage.getItem('n4a-guitar-strings')) || 6);
let bassStrings   = INSTRUMENT_FAMILY[instrument] === 'bass'   ? stringsOf(instrument) : (Number(localStorage.getItem('n4a-bass-strings')) || 4);
// Free tier has no 7/8-string guitar.
if (tier === 'free' && guitarStrings !== 6) { guitarStrings = 6; instrument = 'guitar'; }

// The keyboard can sound as a piano or an organ — one instrument
// ('piano') as far as drawing and fingering go, two buttons in the
// Instrument menu. The organ also looks different (see renderPiano).
let keyboardSound = localStorage.getItem('n4a-keyboard-sound') === 'organ' ? 'organ' : 'piano';
function setKeyboardSound(v) {
  keyboardSound = v;
  localStorage.setItem('n4a-keyboard-sound', v);
}

function resolveInstrumentKey(family) {
  if (family === 'guitar') return guitarStrings === 6 ? 'guitar' : 'guitar' + guitarStrings;
  if (family === 'bass')   return bassStrings === 4 ? 'bass' : 'bass' + bassStrings;
  return family; // ukulele, mandolin, banjo, piano map 1:1
}

let OPEN_PC = TUNINGS[instrument === 'piano' ? 'guitar' : instrument].openPc.slice();
let OPEN_MIDI = TUNINGS[instrument === 'piano' ? 'guitar' : instrument].openMidi.slice();
let STRING_COUNT = OPEN_PC.length;

// Per-string manual retuning (the "<E>" tuner next to the nut), in semitones
// away from OPEN_PC's standard tuning. Resets whenever the instrument/string
// count changes — an offset array sized for a 6-string guitar wouldn't mean
// anything once you're looking at a 4-string bass.
let tuningOffset = new Array(STRING_COUNT).fill(0);
function effectiveOpenPc(s) { return ((OPEN_PC[s] + (tuningOffset[s] || 0)) % 12 + 12) % 12; }
// Real (non-folded) absolute MIDI of string s with its current tuning offset
// applied — this is what playback should use, unlike effectiveOpenPc which
// throws the octave away on purpose for coloring/scale-membership.
function effectiveOpenMidi(s) { return OPEN_MIDI[s] + (tuningOffset[s] || 0); }
function adjustTuning(s, delta) {
  tuningOffset[s] = (tuningOffset[s] || 0) + delta;
  renderFretboard();
  updateInstrumentUI(); // label + preset dropdown need to reflect the new (likely "custom") tuning
}

// Named tuning presets, same tuningOffset convention (index 0 = highest
// string ... last = lowest, in semitones from OPEN_PC's standard tuning).
// Guitar/bass alternates are well-established practice; the ones for
// ukulele/mandolin/banjo are real but less universally standardized —
// worth double-checking against a source you trust before treating them as
// gospel the way the guitar/bass ones can be.
const TUNING_PRESETS = {
  // 'Jacob Collier' is D2 A2 E3 A3 D4 low to high — a symmetric tuning
  // spanning exactly 2 octaves (5th, 5th, 4th, 4th between strings), given
  // directly by the user rather than sourced independently; offsets here
  // are that tuning's distance from this baseline (E4 B3 G3 D3 A2).
  guitar5:  { 'Standard': [0, 0, 0, 0, 0],
              // 'Collier (open D)' is the same DAEAD shape with just the middle
              // string raised a whole step (E -> F#, making a D major triad
              // out of D-F#-A instead of DAEAD's stacked 5th/4th) — the lowest
              // string's offset is kept at Jacob Collier's own -7 (not the
              // nearer-to-zero +5 that also reaches the same pitch class) so
              // it lands an octave lower, same as that preset, instead of
              // crossing above the string next to it.
              'Keith Richards Open G': [-2, 0, 0, 0, -2], 
              'Jacob Collier': [-2, -2, -3, -5, -7], 
              'Jacob Collier (key of A)': [0, -2, -3, -5, -5],
              'Jacob Collier (open D)': [-2, -2, -1, -5, -7] },
  guitar:   { 'Standard': [0, 0, 0, 0, 0, 0], 'Drop D': [0, 0, 0, 0, 0, -2], 'Drop C': [-2, -2, -2, -2, -2, -4],
              'Open G': [-2, 0, 0, 0, -2, -2], 'Open D': [-2, -2, -1, 0, 0, -2], 'DADGAD': [-2, -2, 0, 0, 0, -2],
              'Half-Step Down': [-1, -1, -1, -1, -1, -1], 'Full-Step Down': [-2, -2, -2, -2, -2, -2],
              'Open E': [0, 0, 1, 2, 2, 0], 'Open A': [0, 2, 2, 2, 0, 0], 'Open C': [0, 1, 0, -2, -2, -4] },
  guitar7:  { 'Standard': [0, 0, 0, 0, 0, 0, 0], 'Drop A': [0, 0, 0, 0, 0, 0, -2],
              'Half-Step Down 7': [-1, -1, -1, -1, -1, -1, -1], 'Drop G# / Ab': [-1, -1, -1, -1, -1, -1, -3],
              'Full-Step Down 7': [-2, -2, -2, -2, -2, -2, -2], 'Drop G': [-2, -2, -2, -2, -2, -2, -4],
              'Open A7': [0, -2, -3, -1, 0, 0, -2] },
  guitar8:  { 'Standard': [0, 0, 0, 0, 0, 0, 0, 0], 'Drop E': [0, 0, 0, 0, 0, 0, 0, -2],
              'Meshuggah / F Standard': [-1, -1, -1, -1, -1, -1, -1, -1], 'Drop Eb': [-1, -1, -1, -1, -1, -1, -1, -3],
              'Drop D8': [-2, -2, -2, -2, -2, -2, -2, -4],
              // "High-A 8" isn't a low string added below standard 7 (like
              // every other 8-string preset here) — it's standard 7's own
              // B1-E2-A2-D3-G3-B3-E4 shifted up a fourth (a major third for
              // the G->B string specifically, matching standard tuning's one
              // non-fourth interval) across all 8 strings, landing an extra
              // high A on top instead of an extra low string on the bottom.
              'High-A 8': [5, 5, 4, 5, 5, 5, 5, 5],
              // "Low-A 8" needs the full-octave-down reading on every string
              // (-9/-10, not the nearer +2/+3 same-pitch-class alternative) to
              // actually land on A0 at the bottom — the nearer option would
              // tune it *up*, contradicting "extreme low-end".
              'Low-A 8': [-9, -9, -10, -9, -9, -9, -9, -9] },
  bass:     { 'Standard': [0, 0, 0, 0], 'Drop D': [0, 0, 0, -2], 'Drop C': [-2, -2, -2, -4] },
  bass5:    { 'Standard': [0, 0, 0, 0, 0], 'Drop A': [0, 0, 0, 0, -2] },
  bass6:    { 'Standard': [0, 0, 0, 0, 0, 0], 'Drop A': [0, 0, 0, 0, 0, -2] },
  ukulele:  { 'Standard': [0, 0, 0, 0], 'D-tuning': [2, 2, 2, 2] }, // whole step up from GCEA
  mandolin: { 'Standard': [0, 0, 0, 0], 'Open G (old-time)': [-2, -2, 0, 0] },
  banjo:    { 'Standard': [0, 0, 0, 0, 0], 'Double C': [0, 0, 1, 0, -2] },
};
function tuningPresetsFor(instr) {
  return TUNING_PRESETS[instr] || { 'Standard': new Array(STRING_COUNT).fill(0) };
}
function matchingTuningPreset() {
  const presets = tuningPresetsFor(instrument);
  return Object.entries(presets).find(([, offs]) => offs.every((o, i) => o === (tuningOffset[i] || 0)));
}
// What the fretboard label shows for the current tuning state.
function currentTuningLabel() {
  const match = matchingTuningPreset();
  if (!match) return 'custom tuning';
  return match[0] === 'Standard' ? 'standard tuning' : `${match[0]} tuning`;
}
function refreshTuningPresetSelect() {
  const select = document.getElementById('tuning-preset');
  const presets = tuningPresetsFor(instrument);
  select.innerHTML = '';
  Object.keys(presets).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = '';
  customOpt.textContent = '(custom)';
  select.appendChild(customOpt);

  const match = matchingTuningPreset();
  select.value = match ? match[0] : '';
}
function applyTuningPreset(name) {
  const presets = tuningPresetsFor(instrument);
  if (!presets[name]) return;
  tuningOffset = presets[name].slice();
  renderFretboard();
  updateInstrumentUI();
}

const NUT_X = 110;
// How many frets to draw, per orientation (Instrument menu > Frets).
// Upright the default is fewer: a 15-fret neck fitted to a phone's height
// comes out only ~100pt wide — far under a comfortable touch target — and
// fewer frets over the same height is a proportionally wider neck. Fret
// *spacing* is unaffected (it's anchored to REF_FRET/REF_X below), so this
// lengthens or shortens the neck rather than rescaling it.
const FRET_OPTIONS_H = [12, 15, 17, 19, 22, 24], FRET_OPTIONS_V = [5, 7, 10, 12, 15];
let FRETS_HORIZONTAL = Number(localStorage.getItem('n4a-frets-h')) || 15;
let FRETS_VERTICAL = Number(localStorage.getItem('n4a-frets-v')) || 10;
function setFretCount(n) {
  if (verticalInstrumentMode()) { FRETS_VERTICAL = n; localStorage.setItem('n4a-frets-v', n); }
  else { FRETS_HORIZONTAL = n; localStorage.setItem('n4a-frets-h', n); }
  renderInstrumentView();
  refreshInstrumentSizeControls();
}
// Upright, the neck's own natural (undistorted) proportions — long and
// thin — are nowhere close to a phone's portrait cell (short and wide, by
// comparison), and forcing a fit with preserveAspectRatio:none stretched X
// and Y by different amounts to close that gap, which is exactly what made
// round beads render as ellipses and text glyphs look "fat" (a non-uniform
// scale distorts anything that isn't itself axis-aligned to it). Widening
// the neck for real, in its own coordinate space, instead of faking it with
// a post-hoc stretch, gets the drawing's actual aspect ratio close enough
// to the cell's that a uniform preserveAspectRatio:meet already fills it
// with only a small, honest margin — and never distorts a circle or a
// glyph. Bonus: string spacing (a touch target) grows with this too.
const NECK_SQUEEZE_VERTICAL = 1.7;
// Landscape's "instrument" row ended up with more height available than a
// 15-fret neck's own (very wide/flat) natural aspect ratio needs — since
// preserveAspectRatio:meet fits BOTH dimensions, that spare height went
// unused rather than the neck growing into it, and the resulting scale
// factor (set by height, not width) left the same margin unused on both
// left and right — a letterboxing side effect, not a padding/safe-area
// issue (confirmed: the margin persisted after cutting body's own padding
// to near-zero). Stretching the neck vertically raises its own aspect
// ratio toward the container's, so width becomes the binding dimension
// instead and the neck actually fills the row edge to edge.
const NECK_STRETCH_HORIZONTAL = 1.25;
let FRET_COUNT = FRETS_HORIZONTAL;
let NECK_SQUEEZE = 1;
const REF_FRET = 12, REF_X = 870; // anchors the scale length (fret 12 sits at x=870, same as the original 12-fret layout) independently of how many frets are drawn, so changing FRET_COUNT adds/removes neck rather than rescaling frets 1-12
let NUT_T = TUNINGS[instrument === 'piano' ? 'guitar' : instrument].nutT;
let NUT_B = TUNINGS[instrument === 'piano' ? 'guitar' : instrument].nutB; // y bounds of the string spread, measured at the nut
const OPEN_GAP = 42;             // canonical x-gap for the open-string column

let orientation = localStorage.getItem('n4a-orientation') || 'right';

// Geometry is always computed in canonical (right-handed) space; `mirror`
// flips only the final x-coordinate so text glyphs are never CSS-flipped.
function mirror(x) { return orientation === 'left' ? (NUT_X + END_X - x) : x; }

// Canonical fret position: real equal-temperament spacing — fret 12 sits at
// the halfway point of scale length, etc. Every string shares a fret's x, so
// fret wires and the nut draw perfectly straight.
function fretFrac(f) { return 1 - Math.pow(2, -f / 12); }
const FRET_SCALE = (REF_X - NUT_X) / fretFrac(REF_FRET);
const fbFX = f    => NUT_X + fretFrac(f) * FRET_SCALE;
const fbMX = fret => fret === 0
  ? NUT_X - OPEN_GAP                             // open strings: left of nut
  : (fbFX(fret - 1) + fbFX(fret)) / 2;           // centered between fret wires

let END_X = fbFX(FRET_COUNT); // position of the last drawn fret
// The effective fan actually applied to the drawing — see FRET_FAN below.
// Kept separate from the user's own stored FRET_FAN preference so rotating
// back to landscape restores it instead of forgetting it.
let EFFECTIVE_FRET_FAN = 0;
// Neck taper's own effective value, mirroring EFFECTIVE_FRET_FAN just below
// — but unlike fan (which is simply switched off upright, see the comment
// there), taper stays a perspective cue worth keeping in both orientations,
// just at independently user-set amounts (NECK_TAPER_V/_H below): a user
// found the landscape amount they liked looked wrong carried over to the
// upright/portrait neck, and wanted "no taper at all" there specifically —
// not a blanket rule for every user, hence its own slider rather than a
// hardcoded 0.
let EFFECTIVE_NECK_TAPER = 0;
function syncNeckMetrics() {
  const vertical = verticalInstrumentMode();
  FRET_COUNT = vertical ? FRETS_VERTICAL : FRETS_HORIZONTAL;
  NECK_SQUEEZE = vertical ? NECK_SQUEEZE_VERTICAL : NECK_STRETCH_HORIZONTAL;
  // Fret fan reads as "the low string reaches farther than the high one" —
  // a cue that depends on seeing the strings run left-to-right, side by
  // side. Standing upright in a narrow column that comparison isn't legible
  // the same way, and fanning also unevens the neck's own left/right edges,
  // which reads badly once preserveAspectRatio has to fit that shape into a
  // tall, narrow cell. Neck taper (the width cue) has no such problem, so
  // it stays on.
  EFFECTIVE_FRET_FAN = vertical ? 0 : FRET_FAN;
  EFFECTIVE_NECK_TAPER = vertical ? NECK_TAPER_V : NECK_TAPER_H;
  BASE_MARKER_R = vertical ? BASE_MARKER_R_VERTICAL : BASE_MARKER_R_HORIZONTAL;
  END_X = fbFX(FRET_COUNT);
}

// A real neck is narrower at the nut and widens toward the body. NECK_TAPER
// is how much wider the last fret is than the nut, and the strings fan out
// with it, so the neck's two long edges diverge symmetrically — 0 draws
// perfectly parallel edges instead. User-adjustable (Setup… > Fretboard >
// Neck taper), since reasonable people differ on how much of it looks
// right — 0.06 as the shipped default (was 0.08, before NECK_STRETCH_
// HORIZONTAL above made the base spread this taper multiplies taller —
// same proportion looked more pronounced applied to a bigger base, so
// dialed back to land in the same visual place, not a change of opinion
// about how much taper looks right).
//
// This replaces an earlier per-string compression of the fret positions,
// which pulled each string's frets toward fret 9 by a different amount. That
// slanted the nut and the far edge in *opposite* directions, which reads as
// a skew rather than a taper — especially once the neck is stood upright.
// Independent per-orientation amounts (see EFFECTIVE_NECK_TAPER above) — a
// portrait/upright neck and a landscape one read differently enough that
// "0.06 looks right lying down, 0 looks right standing up" is a real,
// reported preference, not a bug. Landscape keeps the original 0.06
// shipped default; portrait's own default is 0 (no taper) until a user
// dials it up themselves.
let NECK_TAPER_H = Number(localStorage.getItem('n4a-neck-taper-h')) || 0.06;
let NECK_TAPER_V = Number(localStorage.getItem('n4a-neck-taper-v')) || 0;
function taperAt(x) { return 1 + EFFECTIVE_NECK_TAPER * (x - NUT_X) / (END_X - NUT_X); }

// A second, independent perspective cue, orthogonal to NECK_TAPER above:
// NECK_TAPER fans the neck's WIDTH (perpendicular to the strings); this
// fans its LENGTH (parallel to the strings) — how far each string's own
// frets reach before the last one. TUNINGS' openMidi ordering puts s=0 at
// the high e (thin, near/top of the drawing) and s=last at the low E
// (thick, far/bottom) — a real guitarist looking down at their own neck
// sees the string nearest their own body (the low E, in normal playing
// position) read bigger and reach farther, and the far string (the high e)
// read smaller and end sooner, the same kind of foreshortening NECK_TAPER
// already applies across the neck's width. Positive FRET_FAN compresses
// the high-e end of this and stretches the low-E end; 0 (default) leaves
// every string's frets landing at the same canonical x, as before. Both
// this and NECK_TAPER are independently adjustable (Setup… > Fretboard)
// and apply simultaneously — one taper doesn't require or exclude the
// other, they're perpendicular effects that happen to both read as "more
// realistic perspective."
let FRET_FAN = Number(localStorage.getItem('n4a-fret-fan')) || 0;
function fanFactor(s) {
  const norm = STRING_COUNT > 1 ? s / (STRING_COUNT - 1) : 0.5; // 0 = high e, 1 = low E
  return 1 + EFFECTIVE_FRET_FAN * (norm - 0.5);
}
// Real fanned-fret instruments pivot around a "perpendicular fret" partway
// up the neck, not the nut — the strings converge there, diverging toward
// BOTH the nut and the body, rather than only in one direction from a fixed
// nut. "Symmetric" means equal *perceived* divergence on both sides, which
// doesn't necessarily land on the fret with equal pixel-distance either
// side (that pencils out to fret 6, but on-device fret 6 still read as
// slightly nut-heavy — string thickness/marker size and the width-taper's
// own asymmetry both stack on top of the raw pixel math) — fret 5, set by
// eye on the actual device, is what looks right. The nut is consequently
// slightly fanned too, same as the far end, which is why the nut-bar/
// headstock polygon below are per-string now rather than assuming a single
// shared NUT_X.
const FRET_FAN_PIVOT = 5;
const FAN_PIVOT_X = fbFX(FRET_FAN_PIVOT);
// Per-string fret x — reduces to exactly fbFX/fbMX when FRET_FAN is 0.
const fbFXs = (f, s) => FAN_PIVOT_X + (fbFX(f) - FAN_PIVOT_X) * fanFactor(s);
const fbMXs = (fret, s) => fret === 0
  ? fbFXs(0, s) - OPEN_GAP * fanFactor(s)
  : (fbFXs(fret - 1, s) + fbFXs(fret, s)) / 2;

// y of a (possibly fractional) string index at a given point along the neck.
// Spread is exact at the nut and widens from there, about the neck's centre
// line, so the taper is symmetric.
const STRING_Y = (s, x = NUT_X) => {
  const centre = (NUT_T + NUT_B) / 2;
  const atNut = NUT_T + s * (NUT_B - NUT_T) / (STRING_COUNT - 1);
  return centre + (atNut - centre) * taperAt(x) * NECK_SQUEEZE;
};

// Per-string size factor: the nearest/lowest string reads slightly larger,
// the farthest/highest slightly smaller — same perspective cue as the taper,
// just applied to marker radius. Centered on the middle string so it's a
// gentle ±10% spread rather than an overall size shift.
const stringSizeFactor = s => 1 + (s - (STRING_COUNT - 1) / 2) * 0.04;

// Constant radius across all frets (matches what fret 10 rendered at under
// the old per-fret taper) — only the per-string factor varies size now.
// Upright the neck is wider (see NECK_SQUEEZE_VERTICAL) with more room per
// string, so the bead can grow with it — set alongside NECK_SQUEEZE in
// syncNeckMetrics(), same orientation-driven pattern.
const BASE_MARKER_R_HORIZONTAL = 9.6, BASE_MARKER_R_VERTICAL = 12;
let BASE_MARKER_R = BASE_MARKER_R_HORIZONTAL;
function fbR(s) { return BASE_MARKER_R * stringSizeFactor(s); }

let lastFretboardBBoxKey = null; // instrument+orientation the current viewBox was measured for

// The upright layout (html.lay-v — a portrait phone, or a bigger screen
// rotated that way with the Rotate button) stands the instrument up: the
// fretboard becomes an upright neck with the nut at the top (a double bass
// rather than a guitar lying on a table), and the keyboard a vertical
// manual with the low notes at the top (an accordion's treble side).
// Rather than maintaining a second set of coordinates for every element,
// the finished drawing is rotated as a whole and each text glyph
// counter-rotated about its own anchor, so labels stay upright and
// unmirrored.
//
// Read from the html class (set before first paint by index.html, then by
// applyLayout) so the drawing and the CSS can never disagree.
function verticalInstrumentMode() {
  return document.documentElement.classList.contains('lay-v');
}

// Left-handed rotates the other way. The horizontal layout already mirrors
// itself along the fret axis (see mirror()); rotating that mirrored drawing
// by -90° instead of +90° lands the nut at the top for both handednesses
// while flipping which side the low string sits on — i.e. the upright view
// mirrors exactly the way the horizontal one does.
function verticalRotation() { return orientation === 'left' ? -90 : 90; }

function wrapVertical(svg, rot) {
  const g = mk('g', { transform: `rotate(${rot})` });
  while (svg.firstChild) g.appendChild(svg.firstChild);
  svg.appendChild(g);
  g.querySelectorAll('text').forEach(t => {
    t.setAttribute('transform', `rotate(${-rot}, ${t.getAttribute('x')}, ${t.getAttribute('y')})`);
  });
}

// Every fretboard note goes through here: it sounds (noteOn), its bead
// shivers, and its string visibly vibrates.
function playFret(s, f) {
  shakeFretBead(s, f);
  vibrateString(s, f);
  return noteOn(effectiveOpenMidi(s) + f);
}
function shakeFretBead(s, f) {
  const bead = document.querySelector(`#fretboard .fb-bead[data-s="${s}"][data-f="${f}"]`);
  if (!bead) return;
  bead.classList.remove('fb-shake');
  void bead.getBoundingClientRect(); // restart the animation if it's still running
  bead.classList.add('fb-shake');
}
// A plucked string bends into a shallow triangle between the fret it's
// stopped at and the far end, swinging back and forth and dying away. The
// real line is hidden while a temporary polyline draws that shape.
// Everything is in the drawing's own (pre-rotation) coordinates, where a
// string runs along x — so the swing along y is across the string in both
// layouts.
const stringVibes = new Map(); // string index -> { frame, path, line }
function vibrateString(s, f) {
  const line = document.querySelector(`#fretboard .fb-string[data-s="${s}"]`);
  if (!line || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const prev = stringVibes.get(s);
  if (prev) { cancelAnimationFrame(prev.frame); prev.path.remove(); }
  const x1 = +line.getAttribute('x1'), y1 = +line.getAttribute('y1');
  const x2 = +line.getAttribute('x2'), y2 = +line.getAttribute('y2');
  // Where the string is stopped: the fret wire (or the nut for an open string).
  const xs = mirror(fbFXs(f, s));
  const ts = Math.max(0, Math.min(1, (xs - x1) / (x2 - x1)));
  const at = t => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  const [sx, sy] = at(ts), [ax, ay] = at(ts + (1 - ts) / 2);
  const path = mk('polyline', {
    fill: 'none', stroke: line.getAttribute('stroke'), 'stroke-width': line.getAttribute('stroke-width'),
    'pointer-events': 'none',
  });
  line.parentNode.insertBefore(path, line.nextSibling);
  line.style.opacity = '0';
  const start = performance.now();
  const entry = { path, line, frame: 0 };
  stringVibes.set(s, entry);
  const amp = 3 + Number(line.getAttribute('stroke-width'));
  const finish = () => {
    cancelAnimationFrame(entry.frame);
    path.remove();
    if (stringVibes.get(s) === entry) { stringVibes.delete(s); line.style.opacity = ''; }
  };
  // Backstop: animation frames don't run while the app is in the
  // background, and the real string must never be left hidden.
  setTimeout(finish, 800);
  (function frame(now) {
    const t = (now - start) / 1000;
    if (t > 0.7 || !path.isConnected) { finish(); return; }
    const off = amp * Math.cos(2 * Math.PI * 11 * t) * Math.exp(-t / 0.2);
    path.setAttribute('points', `${x1},${y1} ${sx},${sy} ${ax},${ay + off} ${x2},${y2}`);
    entry.frame = requestAnimationFrame(frame);
  })(start);
}

// Instrument menu > Playing (stringed instruments).
//   moveBeads — dragging a fretboard bead along its string changes the
//               scale (on by default); off, beads only play.
//   strumMode — what a strum sounds on each string: 'scale' = the scale/
//               chord note nearest to where the finger crosses; 'exact' =
//               whatever fret it crosses at, in the scale or not.
let moveBeads = localStorage.getItem('n4a-move-beads') !== 'false';
let strumMode = localStorage.getItem('n4a-strum-mode') === 'exact' ? 'exact' : 'scale';
function refreshPlayingControls() {
  document.getElementById('move-beads-toggle').checked = moveBeads;
  document.querySelectorAll('#strum-mode-toggle [data-strum]').forEach(b =>
    b.classList.toggle('active', b.dataset.strum === strumMode));
}
document.getElementById('move-beads-toggle').addEventListener('change', e => {
  moveBeads = e.target.checked;
  localStorage.setItem('n4a-move-beads', moveBeads);
  renderFretboard();
});
document.querySelectorAll('#strum-mode-toggle [data-strum]').forEach(b => b.addEventListener('click', () => {
  strumMode = b.dataset.strum;
  localStorage.setItem('n4a-strum-mode', strumMode);
  refreshPlayingControls();
}));
refreshPlayingControls();

// ── strumming ──
// Swiping across the strings strums them: each string the finger crosses
// sounds, like dragging a pick across. Which fret it sounds at depends on
// strumMode: 'exact' — the fret it crosses at; 'scale' — the note of the
// current scale/chord nearest to where it crosses that string (within two
// frets; a string with none nearby stays silent), so in chord mode a swipe
// near a chord shape plays that chord. Tracked on
// the <svg> itself, on top of whatever the finger first touched (a bead,
// an empty fret, bare wood); events from those bubble up here.
const fretStrums = new Map(); // pointerId -> { u, last, active, notes }
function isStrumming(pointerId) {
  const st = fretStrums.get(pointerId);
  return !!(st && st.active);
}
// Pointer -> canonical fretboard coordinates (undoing the upright
// rotation and the left-handed mirror the drawing was given).
function fretCanonicalPoint(svg, e) {
  const m = svg.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  let x = p.x, y = p.y;
  if (verticalInstrumentMode()) [x, y] = verticalRotation() === 90 ? [p.y, -p.x] : [-p.y, p.x];
  return { x: mirror(x), y }; // mirror() is its own inverse
}
// Fractional string index under a point: 0 = the first string, 1 = the
// next, … (the spread is linear in the string index at any one x).
function stringIndexAt(pt) {
  const y0 = STRING_Y(0, pt.x), y1 = STRING_Y(1, pt.x);
  return (pt.y - y0) / (y1 - y0);
}
function strumNote(s, x) {
  let fret = 0, best = Infinity;
  for (let f = 0; f <= FRET_COUNT; f++) {
    const d = Math.abs(fbMX(f) - x);
    if (d < best) { best = d; fret = f; }
  }
  if (strumMode === 'exact') return playFret(s, fret);
  for (let d = 0; d <= 2; d++) {
    for (const f of [fret - d, fret + d]) {
      if (f < 0 || f > FRET_COUNT) continue;
      if (scaleOffsets.includes(semitone((effectiveOpenPc(s) + f) % 12))) return playFret(s, f);
    }
  }
  return null;
}
(function wireFretboardStrum() {
  const svg = document.getElementById('fretboard');
  svg.addEventListener('pointerdown', e => {
    const pt = fretCanonicalPoint(svg, e);
    if (!pt) return;
    const u = stringIndexAt(pt);
    fretStrums.set(e.pointerId, { u, last: Math.round(u), active: false, notes: [] });
    // Keep hearing about this finger if it started on bare wood. Not when it
    // started on a bead or fret spot: that one captures the finger itself,
    // and grabbing it here first could make the spot's own capture fail —
    // which is what silently stopped out-of-scale notes from playing.
    if (!e.target.classList.contains('fb-hit')) {
      try { svg.setPointerCapture(e.pointerId); } catch (_) { /* not a live pointer */ }
    }
  }, true);
  svg.addEventListener('pointermove', e => {
    const st = fretStrums.get(e.pointerId);
    if (!st) return;
    const pt = fretCanonicalPoint(svg, e);
    if (!pt) return;
    const u = stringIndexAt(pt);
    const lo = Math.min(st.u, u), hi = Math.max(st.u, u);
    // Every string line passed since the last move, in the order passed.
    const crossed = [];
    for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) if (k >= 0 && k < STRING_COUNT) crossed.push(k);
    if (u < st.u) crossed.reverse();
    crossed.forEach(k => {
      if (k === st.last) return;
      st.last = k;
      st.active = true;
      const note = strumNote(k, pt.x);
      if (note) st.notes.push(note);
    });
    st.u = u;
  });
  const end = e => {
    const st = fretStrums.get(e.pointerId);
    if (!st) return;
    st.notes.forEach(n => n.release());
    // Removed after the bead's own pointerup has had its look (isStrumming).
    setTimeout(() => fretStrums.delete(e.pointerId), 0);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
})();

// A fretboard spot that plays for as long as it's held (see noteOn) —
// starting on pointerdown rather than click, which only fires on release.
function holdToPlay(el, s, f) {
  let note = null;
  const lift = () => { if (note) { note.release(); note = null; } };
  el.classList.add('fb-hit');
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    lift();
    note = playFret(s, f); // sound first — nothing below may stop it
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* not a live pointer */ }
  });
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
  el.addEventListener('lostpointercapture', lift); // e.g. redrawn away mid-hold
}

function renderFretboard() {
  const svg = document.getElementById('fretboard');
  svg.innerHTML = '';
  syncNeckMetrics();
  const vertical = verticalInstrumentMode();

  const last = STRING_COUNT - 1, mid = last / 2;
  const openX = fbMX(0); // canonical (unfanned) — used only as STRING_Y's width-taper reference
  // Neck edges. Y (width-taper) is measured at the canonical x, same for
  // every string — that's NECK_TAPER's job, independent of fanning. X (the
  // fan) is per-string — fbFXs(FRET_COUNT, 0) for the high-e corner,
  // fbFXs(FRET_COUNT, last) for the low-E one — so the far edge slants
  // when FRET_FAN is nonzero instead of staying a straight vertical.
  const padNutT = STRING_Y(0, NUT_X) - 12,  padNutB = STRING_Y(last, NUT_X) + 12;
  const padEndT = STRING_Y(0, END_X) - 12,  padEndB = STRING_Y(last, END_X) + 12;
  const padOpenT = STRING_Y(0, openX) - 12, padOpenB = STRING_Y(last, openX) + 12;
  const endXHigh = fbFXs(FRET_COUNT, 0), endXLow = fbFXs(FRET_COUNT, last);
  const openXHigh = fbMXs(0, 0), openXLow = fbMXs(0, last);
  // The nut itself fans too now that the pivot (FRET_FAN_PIVOT) isn't at
  // fret 0 — a real fanned-fret build's nut is slightly angled for exactly
  // this reason, rather than one straight bar.
  const nutXHigh = fbFXs(0, 0), nutXLow = fbFXs(0, last);

  // neck outline — a trapezoid for the width-taper, both the near and far
  // edges additionally slanted by the fan
  svg.appendChild(mk('polygon', {
    points: `${mirror(nutXHigh)},${padNutT} ${mirror(endXHigh)},${padEndT} ${mirror(endXLow)},${padEndB} ${mirror(nutXLow)},${padNutB}`,
    fill: '#2d1f0e'
  }));

  // open-string headstock area — continues the same taper (and fan) past the nut
  svg.appendChild(mk('polygon', {
    points: `${mirror(openXHigh)},${padOpenT} ${mirror(nutXHigh)},${padNutT} ${mirror(nutXLow)},${padNutB} ${mirror(openXLow)},${padOpenB}`,
    fill: '#1a1209'
  }));

  // inlay dots — single at 3, 5, 7, 9, 15, 17, 19, 21; double at 12 and 24
  // (centered between strings), as on a real neck.
  // Kept subtle (soft, semi-transparent, no outline) so they read as a quiet
  // neck marking rather than competing with the scale-highlight note dots.
  // (guarded by FRET_COUNT — portrait's shorter neck stops before 9 and 12)
  [3, 5, 7, 9, 15, 17, 19, 21].filter(f => f <= FRET_COUNT).forEach(f => {
    const x = fbMX(f); // canonical, for the width-taper at this point along the neck
    svg.appendChild(mk('circle', {
      cx: mirror(fbMXs(f, mid)), cy: STRING_Y(mid, x), r: 4.5,
      fill: 'rgba(143, 124, 90, 0.4)'
    }));
  });
  [12, 24].filter(f => f <= FRET_COUNT).forEach(f => {
    const xf = fbMX(f);
    [mid - 1, mid + 1].forEach(si => {
      svg.appendChild(mk('circle', {
        cx: mirror(fbMXs(f, si)), cy: STRING_Y(si, xf), r: 4.5,
        fill: 'rgba(143, 124, 90, 0.4)'
      }));
    });
  });

  // nut bar — same per-string fan as the outline above
  svg.appendChild(mk('polygon', {
    points: `${mirror(nutXHigh - 4)},${padNutT} ${mirror(nutXHigh + 3)},${padNutT} ${mirror(nutXLow + 3)},${padNutB} ${mirror(nutXLow - 4)},${padNutB}`,
    fill: '#d4c890'
  }));

  // per-string tuner — "<E>": click the arrows to retune that string up/down
  // a semitone. Drawn on the headstock (peg) side of the nut, clear of the
  // open-string note dot. The string's own anchor point (cx) is computed in
  // canonical space and mirrored like everything else on the neck, but the
  // arrangement around it is fixed in already-mirrored screen space — unlike
  // fret positions, these are UI controls, not a physical layout that should
  // flip with handedness.
  //
  // Upright, the pair stacks *along* the neck rather than sitting either side
  // of the note name, and canonical +x points down the screen — so the arrows
  // become ∧/∨ and trade places, otherwise "raise pitch" would sit below
  // "lower pitch".
  const downGlyph = vertical ? '∨' : '<', upGlyph = vertical ? '∧' : '>';
  // The along-neck DX below only lands ∧ above ∨ on screen for ONE of the
  // two rotation directions verticalRotation() uses (+90 for right-handed,
  // -90 for left) — rotating a fixed local offset by -90° instead of +90°
  // flips the sign of the resulting screen-y difference, so a DX pair tuned
  // for right-handed silently reversed the stack for left-handed. vSign
  // cancels that out so ∧ ends up on top either way.
  const vSign = orientation === 'left' ? -1 : 1;
  // Bigger in portrait (18/22, not 15/17) — a user found the arrows small
  // and cramped against the note name there specifically (landscape wasn't
  // a complaint). DX grows to match so the wider glyphs don't crowd the
  // (already portrait-enlarged, see the CSS tuner-note-name rule) name
  // between them.
  const arrowDist = vertical ? 20 : 15;
  const arrowFontSize = vertical ? 27 : 17;
  // Pinned to ~17 on-screen px like the rest of the drawing's text (see
  // syncSvgTextScale), never bigger than the size it was drawn for.
  const arrowStyle = `font-size: min(calc(17px / var(--k, 1)), ${arrowFontSize}px)`;
  // Portrait only, both of these: a user found the knobs small and a
  // little dim there while being happy with them in landscape, which is
  // why every one of these is a vertical? ... : <unchanged landscape value>.
  const arrowFill = vertical ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.55)';
  // Upright, this pair stacks ALONG the neck, and canonical +x points down
  // the screen there — so the 2px the up/raise arrow was asked to move
  // "up" is 2 more units of canonical -x, i.e. a slightly wider offset for
  // that one arrow only. vSign carries it because portrait rotates -90°
  // for a left-handed layout and +90° for right-handed, which flips which
  // screen direction a local -x actually points.
  const downDX = vertical ? arrowDist * vSign : -arrowDist;
  const upDX = vertical ? -(arrowDist + 2) * vSign : arrowDist;
  // Clearance between the tuner and the open-string note dot: wide enough
  // that the nearer arrow sits outside the dot's own (enlarged) touch area
  // — at the old 36/26 they touched, and playing an open string kept
  // retuning it by accident.
  const tunerClearance = vertical ? 50 : 38;
  for (let s = 0; s < STRING_COUNT; s++) {
    const y = STRING_Y(s, openX);
    // Clearance from the open-string note dot scales with that dot's own
    // radius (fbR), so thicker/larger markers (bass, near strings) don't
    // crowd the tuner even though the flat part of the gap is the same.
    // Uses this string's own fanned open-x, not the canonical one, so the
    // tuner cluster sits with its actual (possibly fanned) note dot.
    const vcx = mirror(fbMXs(0, s) - fbR(s) - tunerClearance);

    // Free tier keeps the tuning knobs visible but non-functional — grayed
    // out, "not-allowed" cursor, and a native SVG <title> tooltip explaining
    // why, rather than removing them outright.
    {
      const down = mk('text', {
        x: vcx + downDX, y: y + 4, 'text-anchor': 'middle', 'font-weight': 'bold', style: arrowStyle,
        fill: arrowFill, cursor: tier === 'free' ? 'not-allowed' : 'pointer',
        class: tier === 'free' ? 'locked' : ''
      }, downGlyph);
      if (tier === 'free') down.appendChild(mk('title', {}, PAID_FEATURE_MESSAGE));
      // Arrow direction = pitch direction: ∨ (portrait) / < (landscape)
      // tunes the string down a semitone, ∧ / > tunes it up.
      else down.addEventListener('click', () => adjustTuning(s, -1));
      svg.appendChild(down);
    }

    svg.appendChild(mk('text', {
      x: vcx, y: y + 4, 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 'bold',
      fill: 'rgba(255,255,255,0.9)', 'pointer-events': 'none', class: 'tuner-note-name'
    }, keyAwareNoteName(effectiveOpenPc(s))));

    {
      const up = mk('text', {
        x: vcx + upDX, y: y + 4, 'text-anchor': 'middle', 'font-weight': 'bold', style: arrowStyle,
        fill: arrowFill, cursor: tier === 'free' ? 'not-allowed' : 'pointer',
        class: tier === 'free' ? 'locked' : ''
      }, upGlyph);
      if (tier === 'free') up.appendChild(mk('title', {}, PAID_FEATURE_MESSAGE));
      else up.addEventListener('click', () => adjustTuning(s, 1));
      svg.appendChild(up);
    }
  }

  const fretNotes = [];
  for (let s = 0; s < STRING_COUNT; s++) {
    for (let f = 0; f <= FRET_COUNT; f++) {
      const pc = (effectiveOpenPc(s) + f) % 12;
      const st = semitone(pc);
      // Real ascending MIDI note for this string/fret — unlike pc (folded
      // to 0-11 for coloring), this keeps climbing past 12 as f increases,
      // so higher frets on the same string actually sound higher, and the
      // same fret on a lower string actually sounds lower.
      const midi = effectiveOpenMidi(s) + f;
      // x is this string's own (possibly fanned) position, used for drawing;
      // cx is the canonical (unfanned) position, used only as STRING_Y's
      // width-taper reference — keeping NECK_TAPER and FRET_FAN independent
      // of each other rather than letting the fan subtly nudge the taper.
      fretNotes.push({ s, f, x: fbMXs(f, s), cx: fbMX(f), pc, st, midi, inScale: scaleOffsets.includes(st) });
    }
  }
  const visibleNotes = fretNotes.filter(n => n.inScale);
  // Fret numbers sit just outside the low string (string `last`), following
  // both the width-taper (canonical x) and the fan (this string's own x)
  // outward so they keep a constant gap from the neck edge. 30 (was 22) —
  // NECK_STRETCH_HORIZONTAL widened the string spread after this offset
  // was tuned, so the low-E bead's own radius started eating into what used
  // to be a comfortable gap.
  const numberY = x => STRING_Y(last, x) + 30;

  // fret wires — a straight vertical when FRET_FAN is 0 (every string
  // shares a fret's canonical x, as before); slanted between this fret's
  // high-e and low-E positions otherwise, spanning the neck's tapered
  // width at that point — + numbers, positioned at the low string's own
  // (fanned) x, matching where its wire actually lands
  for (let n = 1; n <= FRET_COUNT; n++) {
    const x = fbFX(n); // canonical, for the width-taper at this point along the neck
    svg.appendChild(mk('line', {
      x1: mirror(fbFXs(n, 0)), y1: STRING_Y(0, x) - 2,
      x2: mirror(fbFXs(n, last)), y2: STRING_Y(last, x) + 2,
      stroke: '#5a4a2e', 'stroke-width': 2
    }));
    const nxLow = fbMXs(n, last);
    svg.appendChild(mk('text', {
      x: mirror(nxLow), y: numberY(fbMX(n)), class: 'fret-num',
      'text-anchor': 'middle', 'font-size': 11, fill: '#ffffff'
    }, String(n)));
  }

  // fret "0" label under open-string column
  svg.appendChild(mk('text', {
    x: mirror(fbMXs(0, last)), y: numberY(openX), class: 'fret-num',
    'text-anchor': 'middle', 'font-size': 11, fill: '#ffffff'
  }, '0'));

  // strings (thicker toward the nearest/lowest string) — each fans outward
  // with the width-taper AND the length-fan, from its own (possibly fanned)
  // open position to its own (possibly fanned) last-fret position. Thickness
  // range comes from the tuning (bass strings are visibly chunkier than
  // guitar's).
  const [thinMin, thinMax] = TUNINGS[instrument].thickness;
  for (let s = 0; s < STRING_COUNT; s++) {
    svg.appendChild(mk('line', {
      x1: mirror(fbMXs(0, s)), y1: STRING_Y(s, openX),
      x2: mirror(fbFXs(FRET_COUNT, s)), y2: STRING_Y(s, END_X),
      stroke: '#8a8a8a', 'stroke-width': (thinMin + s * (thinMax - thinMin) / last).toFixed(2),
      class: 'fb-string', 'data-s': s
    }));
  }

  // A note bead's own local coordinate space (its cx/cy attributes) is the
  // SAME canonical, pre-rotation space every fret position above is
  // computed in — wrapVertical() (already applied by this point in
  // horizontal mode... actually before it in vertical, see call site
  // below) only ever adds an ANCESTOR transform, never touches a circle's
  // own attributes. getScreenCTM() on the circle folds in that whole
  // ancestor chain (viewBox scaling, the vertical-mode rotate, mirroring —
  // whatever's currently in effect), so its inverse maps a raw screen
  // point straight back into that same canonical space with no separate
  // vertical/horizontal or left/right-handed case to write.
  function svgPointFromEvent(el, evt) {
    const ownerSvg = el.ownerSVGElement;
    const ctm = el.getScreenCTM();
    if (!ownerSvg || !ctm) return null;
    const pt = ownerSvg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(ctm.inverse());
  }

  // Every fret on string `s` that scaleOffsets[idx] (the degree currently
  // sitting at this bead) could validly move to — "validly" meaning the
  // same rule the abacus enforces when dragging its own bead: land
  // strictly between this degree's two immediate neighbors, never crossing
  // or landing on one (which would silently reorder or collide two
  // degrees). Paired with each candidate's own canonical (pre-mirror)
  // point, for nearest-fret hit-testing while dragging.
  //
  // originFret restricts this to frets within one octave of where the
  // note actually started (Math.abs(f2 - originFret) < 12) — a real bug a
  // user found: a degree can appear MORE THAN ONCE on the same string
  // when FRET_COUNT spans past 12 (the same semitone, an octave apart, is
  // still "valid" by the min/max check above at both positions), and the
  // nearest-candidate search in pointermove has no memory of which
  // occurrence you actually grabbed — a tiny finger movement could jump
  // the bead a full octave to the OTHER valid occurrence if that happened
  // to be marginally closer. Dragging is about nudging a note within its
  // own local neighborhood, not teleporting to any other place it also
  // happens to be correct.
  function fretDragCandidates(s, idx, originFret) {
    const minOffset = scaleOffsets[idx - 1] + 1; // idx>=1 here (root, idx 0, is never draggable) and scaleOffsets[0] is always 0, so this is just "the previous degree, plus one"
    const maxOffset = idx < scaleOffsets.length - 1 ? scaleOffsets[idx + 1] - 1 : 11;
    const out = [];
    for (let f2 = 0; f2 <= FRET_COUNT; f2++) {
      if (Math.abs(f2 - originFret) >= 12) continue;
      const newSt = semitone((effectiveOpenPc(s) + f2) % 12);
      if (newSt < minOffset || newSt > maxOffset) continue;
      out.push({ f: f2, st: newSt, x: mirror(fbMXs(f2, s)), y: STRING_Y(s, fbMX(f2)), midi: effectiveOpenMidi(s) + f2 });
    }
    return out;
  }

  // note markers — draggable along their own string, except the root:
  // dragging one to a new fret shifts that scale degree by a semitone,
  // exactly the edit dragging the matching abacus bead would make (both
  // ultimately just set scaleOffsets[idx] and re-render) — every OTHER
  // occurrence of that same degree, on every string, updates together on
  // the next render, since they all come from the one scaleOffsets entry.
  // The root (idx 0) stays play-only, same as the abacus's own fixed root
  // bead — a scale/chord is always defined relative to it, so it has
  // nowhere valid to move to.
  visibleNotes.forEach(({ s, f, x, cx, pc, st, midi }) => {
    const y = STRING_Y(s, cx);
    const r = fbR(s);
    const idx = scaleOffsets.indexOf(st);

    const circle = mk('circle', {
      cx: mirror(x), cy: y, r,
      fill: icolor(st), opacity: 1, class: 'fb-bead', 'data-s': s, 'data-f': f,
      stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 1.5,
      'pointer-events': 'none', // the invisible hit circle below is what actually receives touches
    });
    svg.appendChild(circle);

    // Invisible, larger touch target — same idea (and roughly the same
    // reasoning) as the abacus's own beadHitRadius: the visible bead's
    // radius is tuned to look right, not to be reliably tappable at the
    // scale a real phone screen shrinks this whole SVG down to. Sized as a
    // flat multiple of the visible radius rather than the abacus's own
    // neighbor-aware sizing, since a fretboard string's next VISIBLE bead
    // is usually several frets away (most frets aren't in the current
    // scale at all) — there's little to actually collide with.
    const hit = mk('circle', {
      cx: mirror(x), cy: y, r: Math.max(r * 2.2, 16), class: 'fb-hit',
      fill: 'transparent', cursor: 'pointer',
      // touch-action: none is what makes a drag start the instant the
      // finger moves, rather than after a delay — without it, the browser
      // first has to decide whether this touch is trying to scroll the
      // page before it commits to firing move events for us to read,
      // which is exactly the "have to hold it for half a second" delay
      // this was reported as. (The abacus's own draggable hit circles set
      // this same style for the same reason.)
      style: 'touch-action: none;',
    });

    // The root never moves (a scale is defined relative to it); with Move
    // beads off, none of them do.
    if (idx === 0 || !moveBeads) {
      holdToPlay(hit, s, f);
      svg.appendChild(hit);
      return;
    }

    const candidates = fretDragCandidates(s, idx, f);
    let drag = null;

    // Plays immediately on press, not on click — matches the abacus's own
    // beadDown, which fires onBeadPlay before it's known whether a drag
    // will follow at all.
    hit.addEventListener('pointerdown', e => {
      e.preventDefault();
      drag = { startX: e.clientX, startY: e.clientY, moved: false, lastMidi: midi, result: null, note: playFret(s, f) };
      try { hit.setPointerCapture(e.pointerId); } catch (_) { /* not a live pointer */ }
    });
    hit.addEventListener('pointermove', e => {
      if (!drag || !candidates.length) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) drag.moved = true;
      if (!drag.moved) return;
      const pt = svgPointFromEvent(hit, e);
      if (!pt) return;
      let best = candidates[0], bestDist = Infinity;
      for (const c of candidates) {
        const d = (c.x - pt.x) ** 2 + (c.y - pt.y) ** 2;
        if (d < bestDist) { bestDist = d; best = c; }
      }
      // Live preview only — the same "don't touch the data model mid-drag"
      // split the abacus itself uses, committing to scaleOffsets on
      // release instead. Both the visible bead and its (now-offset) hit
      // target move together, so the touch target stays under the finger.
      circle.setAttribute('cx', best.x);
      circle.setAttribute('cy', best.y);
      circle.setAttribute('fill', icolor(best.st));
      hit.setAttribute('cx', best.x);
      hit.setAttribute('cy', best.y);
      drag.result = best;
      if (best.midi !== drag.lastMidi) {
        drag.lastMidi = best.midi;
        drag.note.release();
        drag.note = playFret(s, best.f);
      }
    });
    hit.addEventListener('pointerup', e => {
      if (!drag) return;
      const result = drag.moved ? drag.result : null;
      drag.note.release();
      drag = null;
      // A strum that happened to start on this bead isn't a drag of it.
      if (isStrumming(e.pointerId)) { if (result) renderFretboard(); return; }
      if (result && result.st !== st) { scaleOffsets[idx] = result.st; render(); }
    });
    ['pointercancel', 'lostpointercapture'].forEach(type => hit.addEventListener(type, () => {
      if (!drag) return;
      drag.note.release();
      drag = null;
    }));
    svg.appendChild(hit);
  });

  // Click-to-play on every other fret/string position too (not just the
  // in-scale bubbles) — same idea as the piano's always-clickable keys.
  // Invisible hit target, same size/position a bubble would use.
  fretNotes.filter(n => !n.inScale).forEach(({ s, f, x, cx, midi }) => {
    const hit = mk('circle', {
      cx: mirror(x), cy: STRING_Y(s, cx), r: fbR(s),
      fill: 'transparent', cursor: 'pointer', style: 'touch-action: none;'
    });
    holdToPlay(hit, s, f);
    svg.appendChild(hit);
  });

  // Trim the viewBox to what's actually drawn, instead of the fixed
  // 1110×250 canvas. That fixed canvas has to be wide enough for the
  // widest case (8-string bass with full tuning-knob margin), so anything
  // narrower — e.g. 6-string guitar — left dead space on one side. For
  // left-handed orientation that dead space mirrors to the *left*,
  // reading as wasted margin rather than a bigger-looking neck. getBBox()
  // measures the true drawn extent for this specific render (instrument,
  // string count, and orientation are all already baked into every
  // coordinate above), so every combination uses exactly the space it
  // needs — paired with the CSS max-width:100%/height:auto rule, this is
  // also what lets the whole thing shrink to fit instead of scrolling.
  //
  // getBBox() forces a synchronous layout reflow — cheap once, but
  // renderFretboard() itself re-runs on *every* render() (clicking a note,
  // changing the root, anything), even when the neck's actual shape
  // hasn't changed at all. Only instrument and orientation affect the
  // drawn extent, so only recompute when one of those actually changed;
  // otherwise reuse the viewBox already set (content still redraws fine —
  // every coordinate above is in the same fixed canonical space regardless
  // of which viewBox window is currently looking at it).
  if (vertical) wrapVertical(svg, verticalRotation());

  // Includes NECK_TAPER: dragging the Setup… taper slider changes the drawn
  // extent (a wider taper reaches further at the far end) without changing
  // instrument/orientation, so leaving it out of the key would leave a
  // stale viewBox — clipped or with dead margin — until something else
  // happened to invalidate the cache.
  const bboxKey = instrument + '|' + orientation + '|' + (vertical ? 'v' : 'h') + '|' + EFFECTIVE_NECK_TAPER + '|' + EFFECTIVE_FRET_FAN + '|' + FRET_COUNT;
  if (bboxKey !== lastFretboardBBoxKey) {
    const bboxPad = 8;
    const bbox = svg.getBBox();
    svg.setAttribute('viewBox', `${bbox.x - bboxPad} ${bbox.y - bboxPad} ${bbox.width + bboxPad * 2} ${bbox.height + bboxPad * 2}`);
    svg.setAttribute('width', Math.round(bbox.width + bboxPad * 2));
    svg.setAttribute('height', Math.round(bbox.height + bboxPad * 2));
    lastFretboardBBoxKey = bboxKey;
  }

  // Always uniform (meet): see NECK_SQUEEZE_VERTICAL above for how the
  // upright neck gets close to the cell's own proportions without needing
  // a non-uniform stretch, which was distorting beads into ellipses and
  // fattening text.
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

function renderHandToggle() {
  document.getElementById('hand-left').classList.toggle('active', orientation === 'left');
  document.getElementById('hand-right').classList.toggle('active', orientation === 'right');
}

function setOrientation(o) {
  orientation = o;
  localStorage.setItem('n4a-orientation', o);
  renderHandToggle();
  renderFretboard();
}

// ── instrument switching (guitar / bass / piano) ─────────────────────────────

function setInstrument(instr) {
  instrument = instr;
  localStorage.setItem('n4a-instrument', instr);
  if (instr !== 'piano') {
    OPEN_PC = TUNINGS[instr].openPc.slice();
    OPEN_MIDI = TUNINGS[instr].openMidi.slice();
    STRING_COUNT = OPEN_PC.length;
    NUT_T = TUNINGS[instr].nutT;
    NUT_B = TUNINGS[instr].nutB;
    // Every other instrument defaults to plain Standard (all-zero offsets)
    // — guitar5 is the one exception, defaulting to the Jacob Collier
    // preset instead, since that's the actual reason it exists.
    tuningOffset = instr === 'guitar5'
      ? TUNING_PRESETS.guitar5['Jacob Collier'].slice()
      : new Array(STRING_COUNT).fill(0);
  }
  updateInstrumentUI();
  renderInstrumentView();
  // Kick off loading this family's samples immediately on switch, rather
  // than waiting for the first note click — by the time you actually play
  // something the fetch has had a head start instead of adding its own
  // delay after the click.
  currentNoteSampler();
}

// The instrument drawings are SVGs scaled to fit the screen, so a font
// size inside them is in drawing units, not screen pixels — the same
// number came out ~15px on a phone and ~30px on an iPad. This measures
// each drawing's current px-per-unit and hands it to CSS as --k, which the
// text rules divide by to land on fixed on-screen sizes (see the type
// scale at the top of style.css). Re-run whenever a drawing is redrawn or
// resized.
function syncSvgTextScale() {
  ['abacus', 'fretboard', 'piano'].forEach(id => {
    const svg = document.getElementById(id);
    const m = svg.getScreenCTM();
    const k = m ? Math.hypot(m.a, m.b) : 0;
    if (k > 0) svg.style.setProperty('--k', k);
  });
}

function renderInstrumentView() {
  if (instrument === 'piano') renderPiano(); else renderFretboard();
  // Upright with the library sidebar, the instrument's column is sized to
  // its own drawing (see sizeLibrarySidebar) — a different instrument or
  // string count changes that.
  if (currentLayout) sizeLibrarySidebar();
  syncSvgTextScale();
}

// Instrument menu > Frets / Octaves (+ Key length for the piano). The
// options and the current value are per orientation (see FRETS_VERTICAL/
// PIANO_OCT_V), so the caption says which one is being edited — same as
// Setup's neck-taper slider does.
function refreshInstrumentSizeControls() {
  const piano = instrument === 'piano', vertical = verticalInstrumentMode();
  const opts = piano ? PIANO_OCTAVE_OPTIONS : (vertical ? FRET_OPTIONS_V : FRET_OPTIONS_H);
  const cur = piano ? (vertical ? PIANO_OCT_V : PIANO_OCT_H) : (vertical ? FRETS_VERTICAL : FRETS_HORIZONTAL);
  document.getElementById('instrument-size-label').textContent =
    `${piano ? 'Octaves' : 'Frets'} (${vertical ? 'upright' : 'lying down'})`;
  const group = document.getElementById('instrument-size-toggle');
  group.replaceChildren(...opts.map(n => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hand-btn' + (n === cur ? ' active' : '');
    b.textContent = n;
    b.addEventListener('click', () => (piano ? setPianoOctaves : setFretCount)(n));
    return b;
  }));
  document.getElementById('piano-keys-field').hidden = !piano;
  document.querySelectorAll('#piano-keys-toggle [data-keys]').forEach(b =>
    b.classList.toggle('active', b.dataset.keys === PIANO_KEY_LENGTH));
}
document.querySelectorAll('#piano-keys-toggle [data-keys]').forEach(b =>
  b.addEventListener('click', () => setPianoKeyLength(b.dataset.keys)));

function setInstrumentFamily(family) {
  setInstrument(resolveInstrumentKey(family));
}

function setGuitarStrings(n) {
  if (tier === 'free' && n !== 6) return; // 7/8-string is a locked, paid-only button
  guitarStrings = n;
  localStorage.setItem('n4a-guitar-strings', n);
  setInstrument(resolveInstrumentKey('guitar'));
}

function setBassStrings(n) {
  bassStrings = n;
  localStorage.setItem('n4a-bass-strings', n);
  setInstrument(resolveInstrumentKey('bass'));
}

// Free tier: only guitar (6-string) + piano — the other families/strings
// stay in the DOM (simplest, since every wiring path is by getElementById)
// but are hidden, and never selectable.
const FREE_TIER_FAMILIES = ['guitar', 'piano'];
const PAID_FEATURE_MESSAGE = 'This feature is available in the paid version';

function updateInstrumentUI() {
  const family = INSTRUMENT_FAMILY[instrument];
  ['guitar', 'bass', 'ukulele', 'mandolin', 'banjo', 'piano'].forEach(f => {
    const btn = document.getElementById('instr-' + f);
    btn.classList.toggle('active', family === f && !(f === 'piano' && keyboardSound === 'organ'));
    btn.style.display = (tier === 'free' && !FREE_TIER_FAMILIES.includes(f)) ? 'none' : '';
  });
  const organBtn = document.getElementById('instr-organ');
  organBtn.classList.toggle('active', family === 'piano' && keyboardSound === 'organ');
  organBtn.style.display = tier === 'free' ? 'none' : '';
  document.getElementById('pedals').hidden = family !== 'piano';
  document.getElementById('playing-group').style.display = family === 'piano' ? 'none' : '';
  document.getElementById('fretboard-wrap').classList.toggle('keys', family === 'piano');

  document.getElementById('guitar-strings-wrap').style.display = family === 'guitar' ? 'flex' : 'none';
  document.getElementById('bass-strings-wrap').style.display = family === 'bass' ? 'flex' : 'none';
  [5, 6, 7, 8].forEach(n => {
    const btn = document.getElementById('guitar-strings-' + n);
    btn.classList.toggle('active', guitarStrings === n);
    const locked = tier === 'free' && n !== 6;
    btn.classList.toggle('locked', locked);
    btn.title = locked ? PAID_FEATURE_MESSAGE : '';
  });
  [4, 5, 6].forEach(n => document.getElementById('bass-strings-' + n).classList.toggle('active', bassStrings === n));

  document.getElementById('fretboard').style.display = family === 'piano' ? 'none' : 'block';
  document.getElementById('piano').style.display = family === 'piano' ? 'block' : 'none';
  document.getElementById('handedness-group').style.display = family === 'piano' ? 'none' : '';
  // #instrument-label sits in the compact quickbar (see
  // applyInstrumentLabelPlacement) as a short "Instrument" button rather
  // than a caption — the full instrument/tuning detail is one tap away in
  // the popup it opens.
  document.getElementById('instrument-label').innerHTML =
    '<span class="btn-icon" aria-hidden="true">🎸🎹</span><span class="btn-label">Instrument</span>';

  const showTuningPreset = family !== 'piano' && tier !== 'free';
  refreshInstrumentSizeControls();
  // The whole "Tuning" field (caption included), not just its select —
  // hiding only the select left a bare "Tuning" word behind for piano.
  document.getElementById('tuning-preset').closest('label').style.display = showTuningPreset ? '' : 'none';
  document.querySelector('#instrument-hand-row .string-tuning-row').style.display = family === 'piano' ? 'none' : '';
  // Perspective (Setup) only applies to the fretboard.
  document.getElementById('perspective-section').hidden = family === 'piano';
  if (showTuningPreset) refreshTuningPresetSelect();

  document.getElementById('synth-settings-btn').style.display = tier === 'free' ? 'none' : '';
  refreshSampleLoadingIndicator();
}

// ── piano (top-down keyboard, slight angle) ──────────────────────────────────
//
// The angle meant here: sitting in front of and slightly above the piano —
// the near/front edge of the keys (closest to the player, where fingers
// actually land) reads at full width, and the far/back edge (near the
// fallboard, where the black keys stop) reads slightly narrower and pulled
// toward the horizontal center — a converging trapezoid, not a sideways
// parallelogram shift. Geometry is computed directly (not a CSS/SVG transform
// on the whole group) so markers stay circular and text stays upright, same
// reasoning as the fretboard's handedness mirroring.

const pianoHeld = new Map(); // pointerId -> { midi, note } — see "playing the piano" below
const PIANO_BLACK_HIT_EXTRA = 3; // see the black-key hit areas in renderPiano

// How many octaves to draw, per orientation (Instrument menu > Octaves),
// same per-orientation split as the fretboard's fret count.
const PIANO_OCTAVE_OPTIONS = [2, 3, 4, 5];
let PIANO_OCT_H = Number(localStorage.getItem('n4a-piano-oct-h')) || 3;
let PIANO_OCT_V = Number(localStorage.getItem('n4a-piano-oct-v')) || 3;
// Key length (Instrument menu > Keys): 'short' is the compact drawing this
// app has always used; 'long' is a real keyboard's proportions — a white
// key's visible length is ~6.4× its width (150 × 23.5 mm), a black key
// ~0.63 of that. Widths are real either way: a black key is ~0.58 of a
// white key's width on an actual piano, which 27/46 already matches.
let PIANO_KEY_LENGTH = localStorage.getItem('n4a-piano-keys') === 'long' ? 'long' : 'short';
const PIANO_WHITE_W = 46, PIANO_BLACK_W = 27;
const PIANO_LENGTHS = { short: [170, 105], long: [294, 185] }; // [white, black] key length
// All set by syncPianoMetrics() from the options above before each draw.
let PIANO_OCTAVES = 3, PIANO_BASE_OCTAVE = 3, PIANO_H = 170, PIANO_BLACK_H = 105;
let PIANO_TOTAL_WHITE = 22, PIANO_CENTER_X = 0;
function syncPianoMetrics() {
  PIANO_OCTAVES = verticalInstrumentMode() ? PIANO_OCT_V : PIANO_OCT_H;
  // Leftmost white key is a C; real per-key MIDI climbs from there. Up to
  // 3 octaves start at C3 (so 3 spans C3-C6, middle C — MIDI 60, the same
  // shared center every other playback path uses — at the start of the
  // middle octave); 4-5 octaves reach one octave lower, C2.
  PIANO_BASE_OCTAVE = PIANO_OCTAVES >= 4 ? 2 : 3;
  [PIANO_H, PIANO_BLACK_H] = PIANO_LENGTHS[PIANO_KEY_LENGTH];
  PIANO_TOTAL_WHITE = PIANO_OCTAVES * 7 + 1;
  PIANO_CENTER_X = PIANO_TOTAL_WHITE * PIANO_WHITE_W / 2;
}
function setPianoOctaves(n) {
  if (verticalInstrumentMode()) { PIANO_OCT_V = n; localStorage.setItem('n4a-piano-oct-v', n); }
  else { PIANO_OCT_H = n; localStorage.setItem('n4a-piano-oct-h', n); }
  renderInstrumentView();
  refreshInstrumentSizeControls();
}
function setPianoKeyLength(v) {
  PIANO_KEY_LENGTH = v;
  localStorage.setItem('n4a-piano-keys', v);
  renderInstrumentView();
  refreshInstrumentSizeControls();
}
// Fraction narrower at the far/back edge vs. the near/front edge — the
// piano's own equivalent of the fretboard's Neck taper/Fret fan. Used to be
// user-adjustable (Setup… > Piano > Key fan) with a nonzero shipped
// default; a user found the perspective read wrong on the piano
// specifically, in both orientations, so it's a flat 0 (no recession) now
// and the control's been removed rather than left at a dead default no
// one wants.
const PIANO_RECEDE = 0;
const PIANO_WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11];   // semitone per white key within an octave
const PIANO_BLACK_AFTER = new Set([0, 1, 3, 4, 5]); // white-key index (within octave) with a black key right after it
// (PIANO_CENTER_X — the convergence point, at the near/front edge's own
// center — is set by syncPianoMetrics above.)

// 1 at the near/front edge (y = PIANO_H, true/unscaled), (1-PIANO_RECEDE) at
// the far/back edge (y = 0) — everything scales toward PIANO_CENTER_X as y
// decreases, which is what "receding into the distance" looks like from above.
const pianoScaleAt = y => 1 - PIANO_RECEDE * (1 - y / PIANO_H);
const pianoX = (xNear, y) => PIANO_CENTER_X + (xNear - PIANO_CENTER_X) * pianoScaleAt(y);

function pianoKeyPoints(xLeftNear, w, yTop, yBottom) {
  const xRightNear = xLeftNear + w;
  const bl = pianoX(xLeftNear, yBottom),  br = pianoX(xRightNear, yBottom);
  const tl = pianoX(xLeftNear, yTop),     tr = pianoX(xRightNear, yTop);
  return `${bl},${yBottom} ${br},${yBottom} ${tr},${yTop} ${tl},${yTop}`;
}

// Portrait rotates the whole drawing 90° (see wrapVertical below), which
// turns this "front-to-back key length" axis into the keyboard's own
// on-screen WIDTH — a user found the rotated keys read as too narrow/
// cramped there specifically (landscape, where this axis stays vertical
// key-length exactly as drawn, wasn't a complaint). 10% only in portrait,
// not landscape, for that reason — same "independent per orientation"
// pattern as the fretboard's own NECK_TAPER_V/_H split.
const PIANO_LENGTH_STRETCH_VERTICAL = 1.1;

function renderPiano() {
  const svg = document.getElementById('piano');
  svg.innerHTML = '';
  syncPianoMetrics();
  const vertical = verticalInstrumentMode();
  const H = vertical ? PIANO_H * PIANO_LENGTH_STRETCH_VERTICAL : PIANO_H;
  const BH = vertical ? PIANO_BLACK_H * PIANO_LENGTH_STRETCH_VERTICAL : PIANO_BLACK_H;
  const width = PIANO_TOTAL_WHITE * PIANO_WHITE_W;
  const height = H + 6;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  // The organ is drawn with its key colors swapped — dark naturals, light
  // sharps — the way harpsichords and many church and chamber organs are
  // built, so it reads as a different instrument at a glance (style.css).
  svg.classList.toggle('organ', keyboardSound === 'organ');

  function markerStyle(pc) {
    const st = semitone(pc);
    if (!scaleOffsets.includes(st)) return null;
    return { fill: icolor(st), opacity: 1 };
  }

  // white keys — real per-key MIDI (octave = PIANO_BASE_OCTAVE + which of the
  // PIANO_OCTAVES groups of 7 this key falls in) so the leftmost/rightmost
  // C's actually sound three octaves apart instead of every C-key on the
  // keyboard collapsing to the same pitch.
  const whiteKeys = [];
  for (let i = 0; i < PIANO_TOTAL_WHITE; i++) {
    const idx = i % 7;
    const pc = PIANO_WHITE_STEPS[idx];
    const octave = PIANO_BASE_OCTAVE + Math.floor(i / 7);
    const midi = (octave + 1) * 12 + pc;
    const x = i * PIANO_WHITE_W;
    whiteKeys.push({ pc, midi, x });
    const poly = mk('polygon', {
      points: pianoKeyPoints(x, PIANO_WHITE_W, 0, H),
      class: 'piano-key piano-key-white', 'data-midi': midi
    });
    svg.appendChild(poly);
  }

  // black keys (drawn after, so they sit visually in front of the white keys)
  const blackKeys = [];
  for (let i = 0; i < PIANO_TOTAL_WHITE - 1; i++) {
    const idx = i % 7;
    if (!PIANO_BLACK_AFTER.has(idx)) continue;
    const pc = (PIANO_WHITE_STEPS[idx] + 1) % 12;
    const octave = PIANO_BASE_OCTAVE + Math.floor(i / 7);
    const midi = (octave + 1) * 12 + pc;
    const x = (i + 1) * PIANO_WHITE_W - PIANO_BLACK_W / 2;
    blackKeys.push({ pc, midi, x });
    svg.appendChild(mk('polygon', {
      points: pianoKeyPoints(x, PIANO_BLACK_W, 0, BH),
      class: 'piano-key piano-key-black', 'data-midi': midi
    }));
  }

  // note-name labels — absolute, fixed reference, same idea as the fretboard's fret numbers.
  //
  // Portrait rotates this whole drawing 90° (see wrapVertical below), which
  // maps raw (x, y) to displayed (-y, x) — so this axis (the key's own
  // front-to-back "length", where these y-offsets live) becomes the
  // on-screen HORIZONTAL axis there, and a SMALLER y here reads as further
  // RIGHT once rotated (closer to the y=0/far edge, i.e. displayed x=0).
  // A user found the label sitting noticeably left-of and above the bead
  // in portrait once rotated; labelXNudge (added to the shared x/y-becomes-
  // vertical-after-rotation coordinate) reads as "move down" there for the
  // same reason, and is 0 in landscape so this doesn't touch that layout
  // at all. Reused for both label rows below.
  const labelXNudge = vertical ? 6 : 0;
  whiteKeys.forEach(({ pc, x }) => {
    // 8 (landscape) vs 24 (portrait): portrait's label sits much closer to
    // its own bead (H-38) than landscape's does — see labelXNudge above for
    // why portrait needs its own, smaller gap here to read as "aligned
    // with the bead" once rotated, instead of the far-apart pairing
    // landscape's bigger gap would become sideways.
    const y = H - (vertical ? 24 : 8);
    svg.appendChild(mk('text', {
      x: pianoX(x + PIANO_WHITE_W / 2 + labelXNudge, y), y, class: 'piano-white-label',
      'text-anchor': 'middle', 'font-size': 12, fill: '#000000', 'pointer-events': 'none'
    }, keyAwareNoteName(pc)));
  });
  // Black keys previously had no note-name label at all — white text (dark
  // key background) near the bottom tip, same relative position (below the
  // scale marker) as the white keys' own label-below-marker layout.
  // (piano-white-label/piano-black-label classes: same technique as the
  // fretboard's fret-num/tuner-note-name classes — an inline font-size
  // here is just the desktop default, overridden per-breakpoint below.)
  blackKeys.forEach(({ pc, x }) => {
    // 8 (landscape, moved up from a too-low 2) vs 20 (portrait, brought
    // in close to its own bead at BH-30 — same "aligned once rotated"
    // reasoning as the white label above).
    const y = BH - (vertical ? 20 : 8);
    svg.appendChild(mk('text', {
      x: pianoX(x + PIANO_BLACK_W / 2 + labelXNudge, y), y, class: 'piano-black-label',
      'text-anchor': 'middle', 'font-size': 9, fill: '#ffffff', 'pointer-events': 'none'
    }, keyAwareNoteName(pc)));
  });

  // scale markers — a colored dot near the bottom of every in-scale key.
  // Landscape (38/30) is unchanged from the last round — pushed 8px
  // further from the label than the original touching-the-label report,
  // and left alone since. Portrait's labels are now right where they
  // should be, but the beads there wanted more of the same "smaller y"
  // move, twice now (42/34, then another 4px to 46/38) — smaller y reads
  // as further from the near/front edge where the label sits, which is
  // "move up" in landscape (this axis stays vertical there) and "move
  // right" in portrait (this axis becomes horizontal once rotated — see
  // wrapVertical below).
  whiteKeys.forEach(({ pc, x }) => {
    const m = markerStyle(pc);
    if (!m) return;
    const y = H - (vertical ? 46 : 38);
    svg.appendChild(mk('circle', {
      cx: pianoX(x + PIANO_WHITE_W / 2, y), cy: y, r: 9,
      fill: m.fill, opacity: m.opacity, stroke: 'rgba(0,0,0,0.6)', 'stroke-width': 1.5,
      'pointer-events': 'none'
    }));
  });
  blackKeys.forEach(({ pc, x }) => {
    const m = markerStyle(pc);
    if (!m) return;
    // The big 65 jump last round confirmed the mechanism works and was
    // clearly too far — dialed to 42, the requested landing point.
    const y = BH - (vertical ? 42 : 30);
    svg.appendChild(mk('circle', {
      cx: pianoX(x + PIANO_BLACK_W / 2, y), cy: y, r: 7,
      fill: m.fill, opacity: m.opacity, stroke: 'rgba(255,255,255,0.85)', 'stroke-width': 1.5,
      'pointer-events': 'none'
    }));
  });

  // Black keys are narrow targets for a fingertip on glass, so each gets
  // an invisible hit area a little wider than the key itself (drawn last,
  // so it wins over the white keys underneath). Only a little: players do
  // reach up between the black keys for a white one (any chord mixing the
  // two), and the white key's strip there is only ~19 units wide to begin
  // with — +3 on each side still leaves it 13.
  blackKeys.forEach(({ midi, x }) => {
    svg.appendChild(mk('polygon', {
      points: pianoKeyPoints(x - PIANO_BLACK_HIT_EXTRA, PIANO_BLACK_W + 2 * PIANO_BLACK_HIT_EXTRA, 0, BH),
      class: 'piano-key-hit', 'data-midi': midi, fill: 'transparent'
    }));
  });

  // Upright manual in portrait — always +90° (unlike the fretboard there's
  // no handedness here), which puts the low notes at the top, matching an
  // accordion's treble keyboard. rotate(90) maps (x,y) -> (-y,x), so the
  // drawn box lands at x ∈ [-height, 0], y ∈ [0, width] — computed rather
  // than measured with getBBox(), which would force a reflow every redraw.
  if (vertical) {
    wrapVertical(svg, 90);
    svg.setAttribute('viewBox', `${-height} 0 ${height} ${width}`);
    svg.setAttribute('width', height);
    svg.setAttribute('height', width);
  }
  // Keys still held across a redraw (e.g. a scale change mid-chord) keep
  // their pressed look.
  pianoHeld.forEach(({ midi }) => setPianoKeyPressed(midi, true));
}

// ── playing the piano ──
// Like a real keyboard: a key sounds the moment it's pressed (pointerdown,
// not click — click only fires on release), keeps sounding while held, and
// is released when the finger lifts (never sooner than the Sustain setting,
// so a quick tap still rings). Sliding a finger across the keys plays each
// key it passes over (a glissando). Each finger is tracked separately, so
// chords work. All handled once on the <svg> itself, which is why the keys
// carry data-midi rather than their own listeners.
function setPianoKeyPressed(midi, on) {
  const key = document.querySelector(`#piano .piano-key[data-midi="${midi}"]`);
  if (key) key.classList.toggle('pressed', on);
}
function pianoMidiAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest('#piano') && el.dataset.midi ? Number(el.dataset.midi) : null;
}
function pianoPress(pointerId, midi) {
  pianoHeld.set(pointerId, { midi, note: noteOn(midi) });
  setPianoKeyPressed(midi, true);
}
function pianoLift(pointerId) {
  const held = pianoHeld.get(pointerId);
  if (!held) return;
  pianoHeld.delete(pointerId);
  held.note.release();
  // Another finger may still be on the same key (a glissando crossing it).
  if (![...pianoHeld.values()].some(h => h.midi === held.midi)) setPianoKeyPressed(held.midi, false);
}
(function wirePiano() {
  const svg = document.getElementById('piano');
  svg.addEventListener('pointerdown', e => {
    const midi = e.target.dataset && e.target.dataset.midi ? Number(e.target.dataset.midi) : null;
    if (midi == null) return;
    e.preventDefault();
    // Capture so a slide keeps reporting to us even past the edge of the
    // key it started on; which key is under the finger is then looked up
    // by position (pianoMidiAt).
    try { svg.setPointerCapture(e.pointerId); } catch (_) { /* not a live pointer */ }
    pianoPress(e.pointerId, midi);
  });
  svg.addEventListener('pointermove', e => {
    const held = pianoHeld.get(e.pointerId);
    if (!held) return;
    const midi = pianoMidiAt(e.clientX, e.clientY);
    if (midi == null || midi === held.midi) return;
    pianoLift(e.pointerId);
    pianoPress(e.pointerId, midi);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type =>
    svg.addEventListener(type, e => pianoLift(e.pointerId)));
})();

// ── §2 scale reference table ─────────────────────────────────────────────────

let refRowMode = 'modes';   // 'families' | 'modes' — Modes is the default: it shows a scale's own character, with the family it belongs to still labeled via each group's own header
// The library's note-count filter: 'all', or one count (scales 5/6/7/8/12,
// chords 3/4/5/6). Only filters the list — see #lib-count-toggle.
let libCount = 'all';
const LIB_SCALE_COUNTS = [5, 6, 7, 8, 12], LIB_CHORD_COUNTS = [3, 4, 5, 6];
const LIB_COUNT_NAMES = {
  scale: { 5: 'pentatonic', 6: 'hexatonic', 7: 'heptatonic', 8: 'octatonic', 12: 'chromatic' },
  chord: { 3: 'triads', 4: 'sevenths & sixths', 5: 'ninths', 6: 'elevenths & thirteenths' },
};
// "A three-note scale is just a chord" — chordMode swaps which catalog the
// library offers, reusing every other mechanism (abacus, fretboard
// highlighting, nameScale) completely unchanged.
// (chordMode itself is declared near the top of the file — see the comment
// there — since the abacus's own labelFn also reads it, and that first
// runs during createAbacus()'s own construction-time render(), well before
// this point in the file would otherwise run.)

// Updates every control that reflects chordMode's *current* value — split
// out from setChordMode so a view-mode switch (see setViewMode) can re-sync
// the UI to whatever chordMode already is (e.g. after clicking a triad in
// Beginner) without also resetting the currently-loaded scale/chord the way
// setChordMode itself does.
function syncChordModeUI() {
  const on = chordMode;
  document.getElementById('mode-scale-btn').classList.toggle('active', !on);
  document.getElementById('mode-chord-btn').classList.toggle('active', on);

  // Both views now list one kind at a time, so this title is accurate in
  // both (it used to say a neutral "Browse" in Beginner, back when that
  // list mixed scales and chords together).
  document.getElementById('ref-library-label').textContent = on ? 'Browse chords' : 'Browse scales';
  // Families/Modes has no chord-mode equivalent (see the HTML comment) —
  // hidden rather than left showing a control that does nothing.
  document.getElementById('rowmode-switch').hidden = on;
  // Voicing is a chord-only concept (see applyVoicing) — same reasoning.
  document.getElementById('voicing-select').hidden = !on;
}

// Switching Scale/Chord loads a sensible starting point for that kind —
// the major scale, or a dominant 7th — and resets the library filter.
function setChordMode(on) {
  chordMode = on;
  localStorage.setItem('n4a-chord-mode', chordMode);
  syncChordModeUI();
  libCount = 'all';
  scaleOffsets = on ? dictEntryByName('Dominant 7th').set.slice() : [0, 2, 4, 5, 7, 9, 11];
  render();
  renderTable();
}

function renderTable() {
  const wrap = document.getElementById('ref-table-wrap');
  wrap.innerHTML = '';

  const countToggle = document.getElementById('lib-count-toggle');
  countToggle.replaceChildren(...['all', ...(chordMode ? LIB_CHORD_COUNTS : LIB_SCALE_COUNTS)].map(n => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hand-btn' + (n === libCount ? ' active' : '');
    b.textContent = n === 'all' ? 'All' : n;
    b.addEventListener('click', () => { libCount = n; renderTable(); });
    return b;
  }));

  // A plain scrollable list, one card per scale/chord, each showing its
  // shape as a compact strip of colored dots — the exact same per-interval
  // colors (colorOf) the abacus/fretboard use, so it reads as "a small
  // abacus preview". (A bordered 12-column grid used to be the desktop
  // version; the card list replaced it everywhere, sidebar and popup alike.)
  const list = document.createElement('div');
  list.className = 'ref-list';
  const container = list;

  // The mobile list's own column header. The dot strip dropped the desktop
  // grid's borders and column headings, which reads cleanly but leaves
  // nothing saying WHICH degree each of the 12 slots is — labelling every
  // dot on every row was tried instead and is far too dense (see
  // addMobileCard). One header row says it once for the whole list, and
  // sticks to the top of the popup while the list scrolls under it, so it's
  // still answering the question thirty rows down.
  //
  // Built out of the same .ref-card/.ref-card-info/.ref-card-dots classes
  // a real row uses, with the play button and name replaced by same-sized
  // spacers, precisely so the 12 label columns land on the same flex
  // tracks as the 12 dots below them rather than being separately
  // hand-aligned (which would need re-tuning every time a row's padding or
  // the play button's size changed).
  {
    const head = document.createElement('div');
    head.className = 'ref-card ref-head';
    const btnSpacer = document.createElement('span');
    btnSpacer.className = 'ref-head-btn-spacer';
    head.appendChild(btnSpacer);
    const headInfo = document.createElement('div');
    headInfo.className = 'ref-card-info';
    const nameSpacer = document.createElement('div');
    nameSpacer.className = 'ref-card-name ref-head-name-spacer';
    headInfo.appendChild(nameSpacer);
    const headDots = document.createElement('div');
    headDots.className = 'ref-card-dots';
    // TABLE_LABELS is the same fixed R/♭2/2/♭3… sequence the desktop
    // table's own column headings use — these are positions on the
    // 12-semitone track, not members of any one scale, so they don't vary
    // per row (which is exactly why one shared header works at all).
    TABLE_LABELS.forEach(lbl => {
      const cell = document.createElement('span');
      cell.className = 'ref-head-label';
      cell.textContent = lbl;
      headDots.appendChild(cell);
    });
    headInfo.appendChild(headDots);
    head.appendChild(headInfo);
    list.appendChild(head);
  }

  // symbol (chord mode only): a common shorthand — "m7" for "Minor 7th" —
  // shown dim/small after the name rather than replacing it, so both a
  // symbol-literate jazz player and someone who isn't can read the row.
  function addRow(label, set, symbol) {
    const el = addMobileCard(label, set, symbol);
    // Highlights whichever row's own note-set exactly matches what's
    // CURRENTLY loaded — both are always stored the same way (ascending
    // semitone offsets from root, root included as 0), so a direct
    // bitmask comparison is exact and mode-safe: a scale row is only ever
    // compared while scale rows are the ones being listed (chordMode
    // already decides that above), so this can't cross-match a chord and
    // scale that happen to share a bitmask (e.g. a 6/9 chord and the
    // major-pentatonic scale — the same reason CHORD_DICT/SCALE_DICT are
    // kept separate in the first place).
    if (bitmaskOf(set) === bitmaskOf(scaleOffsets)) el.classList.add('ref-row-current');
    return el;
  }

  // One row = one card: play button, name(+symbol), and a 12-slot dot
  // strip standing in for the whole bordered grid — filled, colored dots
  // at the scale's own notes (same colorOf() palette as everywhere else in
  // the app), small dim ticks at the rest, always showing the full
  // 12-position shape (a whole-tone scale's evenly-spaced look vs harmonic
  // minor's characteristic gap is the whole point of showing all 12 slots,
  // not just the filled ones).
  // No per-row degree labels on the dots: tried on every row (too dense —
  // it turned a quick-scan shape into dense reading), then on just the
  // family rows (a user asked for those to go too). What replaced both is
  // a single sticky column header for the whole list — see buildListHeader
  // below; the labels are the same 12 either way, so one row of them at
  // the top says it for every row underneath.
  function addMobileCard(label, set, symbol) {
    const card = document.createElement('div');
    card.className = 'ref-card';
    card.onclick = () => { scaleOffsets = set.slice(); render(); };

    const playBtn = document.createElement('button');
    playBtn.className = 'ref-play-btn';
    playBtn.setAttribute('aria-label', `Play ${label}`);
    playBtn.textContent = '▶';
    // pulseDot is defined further below (after the dot strip it needs to
    // exist first) — a plain function declaration, hoisted within this
    // same addMobileCard call, so it's already available by the time this
    // callback can actually fire (only ever after addMobileCard returns).
    playBtn.onclick = e => { e.stopPropagation(); previewScale(set, pulseDot); };
    card.appendChild(playBtn);

    const info = document.createElement('div');
    info.className = 'ref-card-info';
    const name = document.createElement('div');
    name.className = 'ref-card-name';
    name.appendChild(document.createTextNode(label));
    if (symbol) {
      const sym = document.createElement('span');
      sym.className = 'ref-row-symbol';
      sym.textContent = ` (${symbol})`;
      name.appendChild(sym);
    }
    info.appendChild(name);

    const dots = document.createElement('div');
    dots.className = 'ref-card-dots';
    // Indexed by semitone (not array position) so pulseDot below — called
    // with the same idx-into-`set` previewScale's own run uses — can look
    // straight up which DOM dot corresponds to scaleOffsets[idx]==set[idx].
    const dotBySemitone = [];
    for (let s = 0; s < 12; s++) {
      const dot = document.createElement('span');
      if (set.includes(s)) {
        dot.className = 'ref-dot filled';
        dot.style.background = colorOf(functionOf(s));
      } else {
        dot.className = 'ref-dot empty';
      }
      dotBySemitone[s] = dot;
      dots.appendChild(dot);
    }
    info.appendChild(dots);
    card.appendChild(info);

    // Briefly enlarges the dot for whichever note just sounded during THIS
    // row's own preview — same idea as the abacus's own pulseBead, applied
    // to this row's dot strip instead so a chord's own notes visibly light
    // up in sequence (e.g. a 9th chord's R-3-5-♭7-9 run) regardless of
    // whether this row happens to be the one currently loaded.
    function pulseDot(idx) {
      const dot = dotBySemitone[set[idx]];
      if (!dot) return;
      dot.classList.add('ref-dot-pulse');
      setTimeout(() => dot.classList.remove('ref-dot-pulse'), 150);
    }

    list.appendChild(card);
    return card;
  }

  // Beginner view: skip the whole family/mode/note-count catalog entirely
  // and render exactly the curated rows (scales and, per two of them being
  // tagged chord:true, a couple of triads), regardless of the Notes filter
  // and refRowMode (those controls are hidden in this view).
  if (viewMode === 'beginner') {
    // Split by the Scale/Chord toggle, exactly as Advanced is. As one
    // undivided list it was genuinely ambiguous which kind a row was — a
    // user pointed out that "Major" and "Minor" appear in both halves and
    // read completely differently depending on which one you're looking
    // at, with nothing on screen to say which. Showing one kind at a time
    // makes the toggle itself the answer.
    BEGINNER_SCALES.filter(b => !!b.chord === chordMode).forEach(({ label, set, chord }) => {
      addRow(label, set, chord ? CHORD_SYMBOL[label] : null);
    });
    wrap.appendChild(container);
    return;
  }

  // Mobile's family/mode boundary marker — a plain small-caps label, same
  // information as the table's own group header (th.colSpan across every
  // column) with nothing to span since there's no grid left.
  // Just the family's name. It used to also print that family's own
  // base-shape formula ("Melodic minor — 1 2 ♭3 4 5 6 7"), from back when
  // the list had no other way to say which degree each dot column was.
  // The sticky column header (see buildListHeader above) answers that for
  // every row at once now, so the inline copy was saying the same thing
  // again, less precisely, on every family heading.
  function addGroupHeader(label) {
    const h = document.createElement('div');
    h.className = 'ref-list-group-header';
    h.textContent = label;
    list.appendChild(h);
  }

  // Everything else: the whole catalog, in one section per note count —
  // "5 notes · pentatonic", "7 notes · heptatonic", … — narrowed to one
  // count by the Notes filter at the top (#lib-count-toggle). Seeing the
  // counts side by side is what explains why, say, a pentatonic isn't in
  // among the seven-note modes.
  function addCountHeader(n) {
    const h = document.createElement('div');
    h.className = 'ref-list-count-header';
    h.textContent = `${n} notes · ${LIB_COUNT_NAMES[chordMode ? 'chord' : 'scale'][n]}`;
    list.appendChild(h);
  }

  // Chords: a chord type has no modal rotations to group by the way a
  // scale family does, so refRowMode (Families/Modes) doesn't apply here and
  // is ignored (see the ref-controls hand-toggle, hidden in chord mode).
  const CHORDS_BY_COUNT = {
    3: ['Major triad', 'Minor triad', 'Diminished triad', 'Augmented triad', 'Suspended 2nd', 'Suspended 4th'],
    4: ['Major 7th', 'Dominant 7th', 'Minor 7th', 'Half-diminished 7th', 'Diminished 7th', 'Minor-major 7th',
        'Augmented major 7th', 'Dominant 7♯5', 'Dominant 7♭5', 'Major 6th', 'Minor 6th', 'Major add9', 'Minor add9'],
    5: ['Major 9th', 'Dominant 9th', 'Dominant 7♭9', 'Dominant 7♯9', 'Minor 9th', 'Minor 11th', 'Major 6/9', 'Minor 6/9', 'Minor-major 9th'],
    6: ['Major 13th', 'Dominant 13th', 'Minor 13th', 'Minor 11th (full)',
        'Dominant 9♯11', 'Dominant 13♭9', 'Minor-major 13th', 'Minor-major 11th (full)'],
  };

  function addScaleCount(n) {
    if (n === 7) {
      if (refRowMode === 'families') {
        Object.entries(FAMILIES).forEach(([key, fam]) => addRow(FAMILY_LABEL[key], fam.base, null, true));
        Object.entries(EXOTIC).forEach(([key, fam]) => addRow(FAMILY_LABEL[key], fam.base, null, true));
        Object.entries(EXTRA_SINGLE).forEach(([name, set]) => addRow(name, set, null, true));
      } else {
        Object.entries(FAMILIES).forEach(([key, fam]) => {
          addGroupHeader(FAMILY_LABEL[key]);
          fam.modes.forEach((name, k) => addRow(name, rotateToDegree(fam.base, k)));
        });
        Object.entries(EXOTIC).forEach(([key, fam]) => {
          addGroupHeader(FAMILY_LABEL[key]);
          fam.modes.forEach((name, k) => addRow(name, rotateToDegree(fam.base, k)));
        });
        addGroupHeader('Other exotic scales');
        Object.entries(EXTRA_SINGLE).forEach(([name, set]) => addRow(name, set));
      }
    } else if (n === 5) {
      if (refRowMode === 'families') {
        addRow('Major pentatonic (Gong family)', PENTATONIC.base);
      } else {
        addGroupHeader('Pentatonic (Gong family)');
        PENTATONIC.modes.forEach((name, k) => addRow(name, rotateToDegree(PENTATONIC.base, k)));
      }
    } else if (n === 6) {
      // Symmetric scales (whole-tone, augmented) are the headline rows at this
      // count — they're the ones with real identity here — with blues (an
      // ordinary stepwise hexatonic) listed separately (Increment 3 §8).
      const wholeTone = dictEntryByName('Whole-tone');
      const augA = dictEntryByName('Augmented');
      const augB = dictEntryByName('Augmented (inverse)');
      const blues = dictEntryByName('Blues');
      if (refRowMode === 'families') {
        addRow(wholeTone.name, wholeTone.set);
        addRow(augA.name, augA.set);
        addRow(blues.name, blues.set);
      } else {
        addGroupHeader('Whole-tone');
        addRow(wholeTone.name, wholeTone.set);
        addGroupHeader('Augmented');
        addRow(augA.name, augA.set);
        addRow(augB.name, augB.set);
        addGroupHeader('Other hexatonic scales');
        addRow(blues.name, blues.set);
      }
    } else if (n === 8) {
      // Octatonic (symmetric) as headline rows; composite scales listed
      // separately, described as "parent + added tone" rather than peers of
      // the symmetric families (Increment 3 §8).
      const octHW = dictEntryByName('Octatonic (half-whole)');
      const octWH = dictEntryByName('Octatonic (whole-half)');
      addRow(octHW.name, octHW.set);
      addRow(octWH.name, octWH.set);
      addGroupHeader('Composite (parent + added tone)');
      ['Bebop dominant', 'Bebop major', 'Flamenco fusion'].forEach(name => {
        const e = dictEntryByName(name);
        addRow(`${e.name} (${e.parentName} + added tone)`, e.set);
      });
    } else if (n === 12) {
      const chromatic = dictEntryByName('Chromatic');
      addRow(chromatic.name, chromatic.set);
    }
  }

  const counts = (chordMode ? LIB_CHORD_COUNTS : LIB_SCALE_COUNTS).filter(n => libCount === 'all' || n === libCount);
  counts.forEach(n => {
    addCountHeader(n);
    if (chordMode) {
      CHORDS_BY_COUNT[n].forEach(name => { const e = dictEntryByName(name); addRow(e.name, e.set, CHORD_SYMBOL[name]); });
    } else {
      addScaleCount(n);
    }
  });

  wrap.appendChild(container);
}


// ── §7 audio (Tone.js) ────────────────────────────────────────────────────────
//
// Per the "what's worth playing" call: a held root drone (the audible twin of
// the armband — hear the modal color change as the tonic rotates),
// click-a-bead-to-hear-it, and sequential playback of the scale, left to
// right.
//
// Notes use Tone's official Salamander grand-piano sample set (real
// piano recordings, pitch-shifted per note by Tone.Sampler) rather than a
// synthesized approximation — genuinely "piano," not piano-ish. The drone
// stays a synth (a sampled piano note decays and can't hold indefinitely,
// wrong shape for a drone); it's a "fat" detuned-sine stack for a thicker pad,
// through a shared touch of reverb with the piano for a little shared space.

let audioStarted = false;
// The FIRST call's promise, kept around so a second call while it's still
// pending returns the SAME promise instead of kicking off a second,
// redundant Tone.start()/Tone.loaded() chain. Without this, two clicks on
// Drone made before the (multi-second, first-time-only) sample load
// finishes each queue their own .then() — both fire once loading finally
// completes, each independently flipping droneOn, so two impatient clicks
// silently cancel out and only a third actually leaves it on. Cleared on
// rejection so a genuinely failed load can be retried, not permanently
// wedged on a dead promise.
let audioStartPromise = null;
// iOS silences this app when the hardware ring/silent switch is on, and
// setting the native AVAudioSession category to .playback (see
// AppDelegate.swift) is necessary but NOT sufficient: WKWebView runs its
// own media session on top of the host app's, and a page whose only sound
// comes from the Web Audio API — all of this app's does, via Tone.js —
// gets classified by WebKit as ambient audio, which is defined to obey
// that switch. An actual HTML5 media element is what WebKit treats as
// "this page is playing media", and starting one promotes the whole page's
// session, Web Audio included.
//
// So: a looping, genuinely silent WAV, generated here rather than shipped
// as a file (it's 1.6KB of zeroes — a Blob costs less than another asset
// to fetch, and can't 404). It has to start inside a real user gesture,
// which is why it's called at the very top of ensureAudio, before any
// await — every caller of ensureAudio is itself a tap handler.
//
// If a future iOS makes the native category alone sufficient, this becomes
// a harmless no-op rather than something to remember to remove.
let silentUnlockEl = null;
function unlockSilentSwitchAudio() {
  if (silentUnlockEl) {
    // Safari can pause it on an interruption (a call, another app taking
    // the session); a repeat tap is a good moment to get it going again.
    if (silentUnlockEl.paused) silentUnlockEl.play().catch(() => {});
    return;
  }
  const sampleRate = 8000, samples = 800; // 0.1s of 16-bit mono silence
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  tag(0, 'RIFF');  view.setUint32(4, 36 + samples * 2, true);
  tag(8, 'WAVE');  tag(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header size
  view.setUint16(20, 1, true);           // format: PCM
  view.setUint16(22, 1, true);           // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  tag(36, 'data'); view.setUint32(40, samples * 2, true);
  // The sample data itself is left as the zeroes it was allocated with.
  silentUnlockEl = new Audio(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })));
  silentUnlockEl.loop = true;
  silentUnlockEl.volume = 0;   // belt and braces — the samples are already silent
  silentUnlockEl.play().catch(() => {});
}

// Audio that stops for good until the app is restarted: after an
// interruption (a call, Siri, another app taking the audio, the phone
// locking, a Bluetooth speaker connecting or dropping) iOS leaves the
// AudioContext 'suspended' or 'interrupted' — and nothing ever resumed it,
// since ensureAudio's fast path returned immediately once audio had started
// the first time. Sometimes it even still reports 'running' with its clock
// frozen. So every tap now checks: not running → resume(); running but the
// clock hasn't moved since the last check → a suspend()/resume() cycle,
// which un-sticks it. Both happen inside the tap itself, which iOS needs.
let audioClockCheck = null; // { wall, ctx } at the previous check
function reviveAudio() {
  const ctx = nativeAudioContext();
  const now = performance.now();
  const prev = audioClockCheck;
  audioClockCheck = { wall: now, ctx: ctx.currentTime };
  if (ctx.state !== 'running') return ctx.resume().catch(() => {});
  if (prev && now - prev.wall > 500 && ctx.currentTime === prev.ctx) {
    return ctx.suspend().then(() => ctx.resume()).catch(() => {});
  }
  return Promise.resolve();
}
// Coming back to the app is the usual moment after an interruption.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioStarted) reviveAudio();
});

function ensureAudio() {
  unlockSilentSwitchAudio();
  if (audioStarted) return reviveAudio();
  if (audioStartPromise) return audioStartPromise;
  // Tone.loaded() waits on every sampler/buffer in the app's shared load
  // queue (piano, guitar, bass, drone samples — all fetched from external
  // GitHub Pages/jsdelivr hosts), not just the instrument currently in use.
  // A transient network/CORS hiccup fetching any single one of them rejects
  // this promise — logged here so it's not an unhandled rejection, then
  // re-thrown (not swallowed) so every caller's own .then(...) is *skipped*
  // instead of still firing a triggerAttack against a sampler whose buffer
  // never actually finished loading ("buffer is either not set or not
  // loaded", cascading into further unhandled rejections downstream).
  // audioStarted stays false either way, so the next click retries the load
  // from scratch rather than either being stuck silently dead (old bug) or
  // stuck "on" forever despite a real sample never loading (regression this
  // replaces — flipping audioStarted true just because the context was
  // running left playback permanently attempting broken buffers).
  audioStartPromise = Promise.all([Tone.start(), Tone.loaded()])
    // A known iOS WebKit quirk: right after an AudioContext's very first
    // resume(), `state` can already report 'running' a moment before the
    // hardware is actually flowing samples — anything scheduled at exactly
    // Tone.now() in that gap gets silently dropped, never fires, with no
    // error. Matches the reported symptom exactly (drone shows "on", stays
    // silent indefinitely — not a loading delay, since waiting longer never
    // fixes it — but an immediate off/on afterward works, because by then
    // the context has genuinely settled). This mostly only bites on a
    // FIRST-ever launch, specifically: samplers are created lazily (see
    // getSampler), so if Drone is the very first thing pressed, nothing
    // else is in Tone.loaded()'s queue and it resolves almost instantly —
    // landing the real trigger right in this gap instead of safely after
    // several seconds of genuine sample-loading time.
    //
    // A fixed setTimeout(150ms) guess used to sit here — reported silent-
    // on-first-press three times over even after that fix, meaning 150ms
    // isn't reliably past the gap on every device. Waiting on a guessed
    // DURATION can never be made reliable (the gap's real length depends on
    // the device's own hardware/driver latency, not wall-clock time); what
    // actually proves the hardware is flowing is the context's own clock
    // having genuinely advanced, so poll that directly instead of guessing
    // how long it takes. One-time cost, before audioStarted flips true and
    // unlocks every future call's fast path.
    .then(() => new Promise(resolve => {
      const ctx = Tone.context;
      const t0 = ctx.currentTime;
      // Requires two *different* readings past t0, not just one tick of
      // rAF — a single rAF can fire before the audio clock has advanced at
      // all on some devices, which would collapse this back into "wait one
      // frame," barely better than the old fixed guess.
      let advanced = false;
      (function poll() {
        if (ctx.currentTime > t0) {
          if (advanced) { resolve(); return; }
          advanced = true;
        }
        requestAnimationFrame(poll);
      })();
    }))
    .then(() => { audioStarted = true; })
    .catch(err => {
      console.error('Audio failed to start/load — will retry on next click.', err);
      audioStartPromise = null;
      throw err;
    });
  return audioStartPromise;
}

const midiToFreq = m => Tone.Frequency(m, 'midi').toFrequency();

// Every voice (piano/guitar/bass samplers + the drone chain) sums into this
// single bus with nothing between it and the speakers — during chord
// playback (several notes attacking within milliseconds of each other,
// plus the drone if it's on) that sum can exceed 0dBFS and hard-clip,
// which reads as an audible click/pop at irregular, voicing-dependent
// moments rather than anything periodic. A limiter just before destination
// catches that without otherwise coloring the sound.
const limiter = new Tone.Limiter(-1).toDestination();
const reverb = new Tone.Freeverb(0.6, 3000).connect(limiter);
reverb.wet.value = 0.15;

// ── configurable drone synth ──────────────────────────────────────────────────
//
// A single tunable voice instead of fixed presets, adjustable live from the
// "Synth settings" dialog (§8) and persisted to localStorage. `voices`/`spread`
// control detuned-oscillator stacking ("fat" oscillators) — that stacking is
// also what causes the audible pulsing/beating some presets had; the default
// here is voices=1 (no stacking, no beating) with a quiet, always-plain
// (never detuned) sawtooth layered in via edgeMix for a bit of grit/texture
// without reintroducing any pulsing.
const DRONE_DEFAULTS = {
  instrument: 'organ', // 'synth' | 'harmonium' | 'organ'
  oscType: 'sawtooth',  // sine | triangle | sawtooth | square
  voices: 1,            // 1 = no detuning (no pulsing); 2-4 = detuned stack
  spread: 20,           // cents, only audible when voices > 1
  attack: 0.6, decay: 0.2, sustain: 1, release: 1.5,
  cutoff: 350,          // lowpass Hz — dark, tames the sawtooth's edge
  edgeMix: 100,         // 0-100, quiet plain-sawtooth layer mixed underneath
  octave: -1,           // relative to the old fixed base (C3); -1 = C2, -2 = C1
  octaveDown: false,    // layer an exact octave below the main voice (synth instrument only)
  octaveUp: false       // layer an exact octave above the main voice (synth instrument only)
};
let droneConfig = Object.assign({}, DRONE_DEFAULTS, JSON.parse(localStorage.getItem('n4a-drone-config') || '{}'));

// General playback settings (Setup dialog's "Playback" section) — separate
// from droneConfig above, since these apply to note clicks and scale
// playback rather than the held drone specifically.
let playbackOctave  = Number(localStorage.getItem('n4a-playback-octave'))  || 0;   // whole octaves, relative to the shared MIDI-60 base
let playbackTempo   = Number(localStorage.getItem('n4a-playback-tempo'))   || 1;   // speed multiplier on the fixed note/scale step durations below
let playbackSustain = Number(localStorage.getItem('n4a-playback-sustain')) || 0.5;   // seconds a clicked note is held before release

function setPlaybackSetting(key, value) {
  if (key === 'octave') playbackOctave = value;
  else if (key === 'tempo') playbackTempo = value;
  else if (key === 'sustain') playbackSustain = value;
  localStorage.setItem('n4a-playback-' + key, value);
}

// Output latency — how long after its audio-clock time a note is actually
// HEARD. Built-in speakers/wired headphones: a few tens of ms, not worth
// thinking about. A Bluetooth speaker: easily 200–500ms, enough that a
// scale preview's bead pulses visibly run ahead of the notes. The audio
// can't be made to arrive sooner, so instead the visuals wait for it (see
// previewScale's pulseAt). Three sources, in order of preference:
//   1. iOS app: the native AudioLatency plugin (ios/App/App/
//      AudioLatencyPlugin.swift) reads AVAudioSession.outputLatency, which
//      does include Bluetooth — WKWebView's Web Audio doesn't expose it.
//   2. Web: AudioContext.outputLatency (Chrome/Firefox; Safari lacks it).
//   3. A per-output-device manual adjustment on top, set by slider or by
//      the Setup dialog's tap test — reported latencies are often short of
//      the real thing on Bluetooth, sometimes by a lot.
// The adjustment is stored per output route (native only — the web can't
// tell devices apart), so calibrating the Bluetooth speaker doesn't throw
// off the phone's own speaker.
const SYNC_ADJUST_MIN = -200, SYNC_ADJUST_MAX = 600;
let nativeOutputLatency = null; // seconds; null = no native plugin (web)
let outputRoute = { key: 'default', name: '' };
let syncAdjustByRoute = JSON.parse(localStorage.getItem('n4a-sync-adjust') || '{}');

const audioLatencyPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioLatency;
function applyOutputRouteInfo(info) {
  if (!info) return;
  nativeOutputLatency = typeof info.outputLatency === 'number' ? info.outputLatency : null;
  outputRoute = { key: info.routeUid || info.routeName || 'default', name: info.routeName || '' };
  refreshSyncControls();
}
if (audioLatencyPlugin) {
  audioLatencyPlugin.getOutputLatency().then(applyOutputRouteInfo).catch(() => {});
  // Fires when a speaker/headphones connect or disconnect, so pulses
  // retime themselves without the app needing a restart.
  audioLatencyPlugin.addListener('routeChange', info => {
    applyOutputRouteInfo(info);
    // A new output (speaker connected/disconnected) is one of the things
    // that can leave Web Audio stalled — see reviveAudio.
    if (audioStarted) reviveAudio();
  });
}

// Tone wraps the real AudioContext (standardized-audio-context), and the
// wrapper doesn't forward outputLatency — read it off the native one.
function nativeAudioContext() {
  const raw = Tone.context.rawContext;
  return raw._nativeAudioContext || raw;
}
function detectedLatencyMs() {
  const ctx = nativeAudioContext();
  const out = nativeOutputLatency != null ? nativeOutputLatency : (ctx.outputLatency || 0);
  return ((ctx.baseLatency || 0) + out) * 1000;
}
function syncAdjustMs() { return syncAdjustByRoute[outputRoute.key] || 0; }
function setSyncAdjust(ms) {
  syncAdjustByRoute[outputRoute.key] = Math.max(SYNC_ADJUST_MIN, Math.min(SYNC_ADJUST_MAX, Math.round(ms / 10) * 10));
  localStorage.setItem('n4a-sync-adjust', JSON.stringify(syncAdjustByRoute));
  refreshSyncControls();
}
function outputLatencyMs() { return Math.max(0, detectedLatencyMs() + syncAdjustMs()); }
// Wall-clock ms from now until a note scheduled at audio-clock time `t`
// is actually heard.
function audibleDelayMs(t) { return (t - nativeAudioContext().currentTime) * 1000 + outputLatencyMs(); }
// Start time for a note the user plays directly (bead tap, fret/key click).
// Tone.now() is currentTime + lookAhead (0.1s) — headroom that keeps
// scheduled runs glitch-free (previewScale keeps it), but for a single
// tapped note it's pure added delay, so these start right away on every
// output. (ensureAudio's clock-advanced wait means the context is genuinely
// running by here, so "now" won't land in iOS's dropped-first-note gap.)
function tapNoteTime() { return Tone.immediate(); }

function refreshSyncControls() {
  const adj = syncAdjustMs();
  document.getElementById('sync-adjust').value = adj;
  document.getElementById('sync-adjust-val').textContent = (adj > 0 ? '+' : '') + adj + ' ms';
  document.getElementById('sync-detected').textContent =
    (outputRoute.name ? outputRoute.name + ' · ' : '') +
    'detected ' + Math.round(detectedLatencyMs()) + ' ms · total ' + Math.round(outputLatencyMs()) + ' ms';
}

// Tap test: a click every second, the user taps along, and the median
// gap between each click's scheduled time and the tap that answers it is
// the real latency (tap-early habit and touchscreen lag roughly cancel
// out). Deliberately NO visual cue on the clicks — anything that flashes
// would get tapped to instead of the sound. The first few taps are
// dropped while the user locks onto the beat.
const SYNC_TEST_CLICKS = 10, SYNC_TEST_SKIP = 3, SYNC_TEST_INTERVAL = 1;
let syncClickSynth = null;
let syncTestRunning = false;
function runSyncTest() {
  if (syncTestRunning) return;
  const pad = document.getElementById('sync-test-pad');
  const btn = document.getElementById('sync-test-btn');
  ensureAudio().then(() => {
    syncTestRunning = true;
    btn.disabled = true;
    if (!syncClickSynth) {
      syncClickSynth = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 }
      }).connect(limiter);
    }
    const ctx = nativeAudioContext();
    // Pair the two clocks at one instant so a click's audio-clock time can
    // be compared with a tap's performance.now()-based event timestamp.
    const perf0 = performance.now(), ctx0 = ctx.currentTime;
    const first = ctx0 + 1;
    const clickWall = i => perf0 + (first + i * SYNC_TEST_INTERVAL - ctx0) * 1000;
    for (let i = 0; i < SYNC_TEST_CLICKS; i++) {
      syncClickSynth.triggerAttackRelease(i % 4 === 0 ? 'C7' : 'G6', 0.03, first + i * SYNC_TEST_INTERVAL);
    }
    const taps = [];
    const intervalMs = SYNC_TEST_INTERVAL * 1000;
    const onTap = e => {
      e.preventDefault();
      taps.push(e.timeStamp);
      pad.textContent = 'Tap on each click… (' + taps.length + ')';
    };
    pad.hidden = false;
    pad.textContent = 'Tap here on each click…';
    pad.addEventListener('pointerdown', onTap);
    setTimeout(() => {
      pad.removeEventListener('pointerdown', onTap);
      syncTestRunning = false;
      btn.disabled = false;
      // Each tap's phase against the click grid, wrapped into
      // [-¼, ¾) of an interval: a tap a bit BEFORE a click (wired
      // speaker, eager tapper) counts as slightly negative rather than as
      // a huge lag behind the previous click.
      const offsets = taps
        .filter(t => t >= clickWall(SYNC_TEST_SKIP) - intervalMs / 4)
        .map(t => {
          let ph = ((t - clickWall(0)) % intervalMs + intervalMs) % intervalMs;
          if (ph >= intervalMs * 0.75) ph -= intervalMs;
          return ph;
        })
        .sort((a, b) => a - b);
      if (offsets.length < 4) {
        pad.textContent = 'Not enough taps — try again.';
        return;
      }
      const median = offsets[Math.floor(offsets.length / 2)];
      setSyncAdjust(median - detectedLatencyMs());
      pad.textContent = 'Measured ' + Math.round(median) + ' ms — saved for this output.';
    }, (1 + SYNC_TEST_CLICKS * SYNC_TEST_INTERVAL) * 1000);
  }).catch(() => {});
}

// Chord-only (a scale's ascending run has no "voicing" concept) — which
// chord tone gets dropped an octave for the full-chord strike in
// previewScale's chord-mode branch. 'close' leaves the chord exactly as
// loaded (its own already-computed extension octave-bumps notwithstanding).
const VOICING_LABELS = { close: 'Close', drop2: 'Drop 2', drop3: 'Drop 3' };
let chordVoicing = localStorage.getItem('n4a-chord-voicing') || 'close';
function setChordVoicing(v) {
  chordVoicing = v;
  localStorage.setItem('n4a-chord-voicing', v);
  refreshVoicingSelectUI();
}
// Custom dropdown (see wireDropdown) — not a native <select>, same
// reasoning as the root picker (renderRoot's own comment has the story).
function refreshVoicingSelectUI() {
  document.getElementById('voicing-select-value').textContent = VOICING_LABELS[chordVoicing];
  document.querySelectorAll('#voicing-select-list .dropdown-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.value === chordVoicing);
  });
}

// Standard drop-2/drop-3 voicing: counting DOWN from the top of the
// close-position chord by PITCH, the 2nd- or 3rd-highest note drops a full
// octave — landing it below (or near) the rest of the voicing instead of
// stacked tight against its neighbors. Chords under 3 notes have no
// "2nd/3rd from the top" distinct from the root/top itself, so those are
// left as 'close' regardless of the selected voicing.
//
// Returns an array the SAME LENGTH AND ORDER as `midis` (only the one
// dropped note's value changes) rather than a pitch-sorted array — the
// caller matches each entry back to its own bead by index, and a
// resorted array would silently scramble that mapping.
function applyVoicing(midis, voicing) {
  if (voicing === 'close' || midis.length < 3) return midis.slice();
  const byPitch = midis.map((_, i) => i).sort((a, b) => midis[a] - midis[b]); // indices, ascending pitch
  const rank = voicing === 'drop2' ? byPitch.length - 2 : byPitch.length - 3;
  if (rank < 0) return midis.slice();
  const out = midis.slice();
  out[byPitch[rank]] -= 12;
  return out;
}

const droneFilter = new Tone.Filter(droneConfig.cutoff, 'lowpass').connect(reverb);
const droneBody = new Tone.Synth().connect(droneFilter);
// Edge layer is always a single plain sawtooth (never "fat"/detuned) — its
// only job is texture, and stacking it would reintroduce the pulsing.
const droneEdge = new Tone.Synth({ oscillator: { type: 'sawtooth' } }).connect(droneFilter);
// Optional octave layers — exact octaves (freq*2 / freq/2), not detuned, so
// unlike the voices/spread stacking above these never beat/pulse against
// the main voice; they just add low-end weight or top-end air.
const droneBodyDown = new Tone.Synth().connect(droneFilter);
const droneEdgeDown = new Tone.Synth({ oscillator: { type: 'sawtooth' } }).connect(droneFilter);
const droneBodyUp = new Tone.Synth().connect(droneFilter);
const droneEdgeUp = new Tone.Synth({ oscillator: { type: 'sawtooth' } }).connect(droneFilter);

// Sampled drone alternative: a single looped recording, pitch-shifted via
// playbackRate to the current root (rather than a proper multi-sample
// Sampler, since all we need is ONE sustained held note, not a whole
// keyboard). loopStart/loopEnd trim off the recording's attack transient
// and tail decay, landing the loop inside the steadiest part of the
// sustain. Unlike the synth voice, there's no custom envelope here (Player
// has no ADSR) and no octave-layer support (would need a second held
// Player per layer) — root changes also retune instantly rather than
// gliding, since Player.playbackRate is a plain number, not a rampable
// Tone.Signal.
// Cloudflare R2 bucket (spicemap-samples), public via its default r2.dev
// URL — replaces the old ChemiCloud/LiteSpeed host (samples.10keyz.com),
// which had no Cache-Control header and no CDN in front of it. If a custom
// domain ever gets attached to the bucket, this is the one line to change.
const SAMPLES_BASE_URL = 'https://pub-28f7a744940144149ef7eb6aaea39678.r2.dev';

const DRONE_SAMPLE_SOURCES = {
  harmonium: { url: SAMPLES_BASE_URL + '/harmonium/C3.mp3', baseMidi: 48, loopStart: 0.8, loopEnd: 11.7, fade: 0.02 },
  organ:     { url: SAMPLES_BASE_URL + '/organ/C3.mp3',     baseMidi: 48, loopStart: 0.8, loopEnd: 10.0, fade: 0.02 },
};
const DRONE_SAMPLE_VOLUME = -8;

// A long amplitude crossfade (what this was before) doesn't just hide a
// click on a tonal/oscillating recording — the tail and head are different
// points in the waveform's own cycle, so blending them by loudness alone
// leaves their phases mismatched, and stretching that mismatch out over
// half a second reads as an audible "phasing/flanging" warble, worse than
// the original click. Two changes instead: snap loopStart/loopEnd to the
// nearest actual zero-crossing (minimizes the raw jump before any blending
// happens at all), and use a *short* crossfade (~20ms) — short enough that
// any residual phase mismatch isn't perceptible, long enough to round off
// what's left of the seam.
function nearestZeroCrossing(data, guess, maxSearch) {
  for (let d = 0; d < maxSearch; d++) {
    for (const i of [guess - d, guess + d]) {
      if (i > 0 && i < data.length && ((data[i - 1] < 0) !== (data[i] < 0))) return i;
    }
  }
  return guess; // no crossing found nearby — fall back to the original guess
}

function buildSeamlessLoopBuffer(sourceBuffer, loopStart, loopEnd, crossfadeSec) {
  const sr = sourceBuffer.sampleRate;
  const searchWindow = Math.floor(0.01 * sr); // +/-10ms to look for a zero-crossing
  // Zero-crossings are per-channel; snap using channel 0 and reuse those
  // sample indices for every channel, so all channels stay in sync.
  const ch0 = sourceBuffer.getChannelData(0);
  const startSample = nearestZeroCrossing(ch0, Math.floor(loopStart * sr), searchWindow);
  const endSample = nearestZeroCrossing(ch0, Math.floor(loopEnd * sr), searchWindow);
  const loopLen = endSample - startSample;
  const fadeLen = Math.min(Math.floor(crossfadeSec * sr), Math.floor(loopLen / 2));
  const numCh = sourceBuffer.numberOfChannels;

  const out = Tone.context.createBuffer(numCh, loopLen, sr);
  for (let ch = 0; ch < numCh; ch++) {
    const srcData = sourceBuffer.getChannelData(ch);
    const outData = out.getChannelData(ch);
    for (let i = 0; i < loopLen; i++) outData[i] = srcData[startSample + i];
    for (let i = 0; i < fadeLen; i++) {
      const tailIdx = loopLen - fadeLen + i;
      const t = i / fadeLen;
      const fadeOutGain = Math.cos(t * 0.5 * Math.PI); // equal-power: 1 -> 0
      const fadeInGain = Math.sin(t * 0.5 * Math.PI);  //              0 -> 1
      outData[tailIdx] = srcData[startSample + tailIdx] * fadeOutGain + srcData[startSample + i] * fadeInGain;
    }
  }
  return out;
}

// Lazy like the note samplers above — harmonium and organ are two more
// requests that don't need to happen at page load if the drone's never
// turned on, or is left on a synth voice instead of a sampled one.
const dronePlayers = {};
function getDronePlayer(key) {
  if (dronePlayers[key]) return dronePlayers[key];
  const src = DRONE_SAMPLE_SOURCES[key];
  const player = new Tone.Player().connect(droneFilter);
  player.volume.value = DRONE_SAMPLE_VOLUME;
  dronePlayers[key] = player;
  // Tone.Buffer's callback-style loader registers with the same global
  // load queue Tone.loaded() (used by ensureAudio()) already waits on, same
  // as every other sample in this app.
  new Tone.Buffer(src.url, buf => {
    const seamless = buildSeamlessLoopBuffer(buf.get(), src.loopStart, src.loopEnd, src.fade);
    player.buffer.set(seamless);
    player.loop = true;
  });
  return player;
}

function edgeVolumeFor(mix) { return mix <= 0 ? -60 : -12 - (100 - mix) * 0.3; }

function applyDroneConfig() {
  const oscType = droneConfig.voices > 1 ? `fat${droneConfig.oscType}` : droneConfig.oscType;
  const env = { attack: droneConfig.attack, decay: droneConfig.decay, sustain: droneConfig.sustain, release: droneConfig.release };
  const oscSettings = { oscillator: { type: oscType, count: droneConfig.voices, spread: droneConfig.spread }, envelope: env };
  const edgeVol = edgeVolumeFor(droneConfig.edgeMix);

  droneBody.set(oscSettings);
  droneBody.volume.value = -12;
  droneEdge.set({ envelope: env });
  droneEdge.volume.value = edgeVol;

  // Octave layers sit a bit under the main voice — support, not competition.
  [droneBodyDown, droneBodyUp].forEach(v => { v.set(oscSettings); v.volume.value = -16; });
  [droneEdgeDown, droneEdgeUp].forEach(v => { v.set({ envelope: env }); v.volume.value = edgeVol - 4; });

  droneFilter.frequency.value = droneConfig.cutoff;
}
applyDroneConfig();

function setDroneParam(key, value) {
  droneConfig[key] = value;
  localStorage.setItem('n4a-drone-config', JSON.stringify(droneConfig));
  applyDroneConfig();
  if (key === 'octave' && droneOn) droneVoice.rampFrequency(midiToFreq(droneBaseMidi()), 0.1);
  // Toggling an octave layer while the drone is already sounding starts/stops
  // just that layer immediately, rather than waiting for the next attack.
  if ((key === 'octaveDown' || key === 'octaveUp') && droneOn) {
    const freq = midiToFreq(droneBaseMidi());
    const mul = key === 'octaveDown' ? 0.5 : 2;
    const [body, edge] = key === 'octaveDown' ? [droneBodyDown, droneEdgeDown] : [droneBodyUp, droneEdgeUp];
    if (value) {
      body.triggerAttack(freq * mul);
      if (droneConfig.edgeMix > 0) edge.triggerAttack(freq * mul);
    } else {
      body.triggerRelease();
      edge.triggerRelease();
    }
  }
}

function activeDronePlayer() {
  return DRONE_SAMPLE_SOURCES[droneConfig.instrument] ? getDronePlayer(droneConfig.instrument) : null;
}

// Callers that mean "make sure this attack actually happens" (turning the
// drone on, or switching to a different drone instrument while it's
// already on) go through here instead of calling droneVoice.triggerAttack
// directly — a sample-based drone voice's (harmonium/organ) very first use
// of a given instrument creates its Tone.Player and starts its buffer
// fetch lazily, right inside activeDronePlayer() (see getDronePlayer), and
// if that fetch hasn't finished yet, triggerAttack's own `!player.loaded`
// guard silently skips playing anything — droneOn/the button already say
// "on" by then regardless. Reported three times as "have to toggle Drone
// off and back on to get sound": the second press works only because the
// FIRST press's own call is what kicked off the fetch, and enough time had
// passed by then for it to finish. currentNoteSampler() already has this
// same warm-at-load-time treatment for the note samplers (see the call
// near the bottom of this file) — extended here to the drone's sample
// voices too, plus this retry path for the case that warm-up alone can't
// close (a fast tap before the warm-up's own fetch finishes, or switching
// to a drone instrument that's never been touched this session).
function triggerDroneAttackWhenReady(freq) {
  const player = activeDronePlayer();
  if (!player || player.loaded) { droneVoice.triggerAttack(freq); return; }
  Tone.loaded().then(() => { if (droneOn) droneVoice.triggerAttack(freq); }).catch(() => {});
}

const droneVoice = {
  triggerAttack: freq => {
    const player = activeDronePlayer();
    if (player) {
      // player.buffer.set(...) runs once the drone recording's fetch
      // resolves (see DRONE_SAMPLE_SOURCES setup below) — if that fetch is
      // still pending or failed outright, .loaded stays false forever and
      // player.start() would throw "buffer is either not set or not
      // loaded". Skip silently rather than crash; there's nothing to
      // retry here since the fetch itself only ever runs once at startup.
      if (!player.loaded) return;
      const src = DRONE_SAMPLE_SOURCES[droneConfig.instrument];
      player.playbackRate = freq / midiToFreq(src.baseMidi);
      // Undo any fade-out ramp left over from a previous stop (see
      // triggerRelease) before starting again.
      player.volume.cancelScheduledValues(Tone.now());
      player.volume.value = DRONE_SAMPLE_VOLUME;
      player.start();
      return;
    }
    droneBody.triggerAttack(freq);
    if (droneConfig.edgeMix > 0) droneEdge.triggerAttack(freq);
    if (droneConfig.octaveDown) {
      droneBodyDown.triggerAttack(freq / 2);
      if (droneConfig.edgeMix > 0) droneEdgeDown.triggerAttack(freq / 2);
    }
    if (droneConfig.octaveUp) {
      droneBodyUp.triggerAttack(freq * 2);
      if (droneConfig.edgeMix > 0) droneEdgeUp.triggerAttack(freq * 2);
    }
  },
  triggerRelease: () => {
    const player = activeDronePlayer();
    if (player) {
      // Player.stop() cuts the buffer immediately — fadeIn/fadeOut only
      // smooth the loop seam, not the stop itself. Ramp volume down first
      // so switching the drone off doesn't add its own click on top of
      // whatever loop-seam hiccup the sample already has.
      const now = Tone.now();
      player.volume.cancelScheduledValues(now);
      player.volume.rampTo(-60, 0.15, now);
      player.stop(now + 0.16);
      return;
    }
    droneBody.triggerRelease();
    droneEdge.triggerRelease();
    droneBodyDown.triggerRelease();
    droneEdgeDown.triggerRelease();
    droneBodyUp.triggerRelease();
    droneEdgeUp.triggerRelease();
  },
  // Player.playbackRate is a plain number (not a Tone.Signal), so a sampled
  // drone can't glide smoothly on root change the way the synth's
  // frequency ramp does — it just retunes instantly.
  rampFrequency: (freq, time) => {
    const player = activeDronePlayer();
    if (player) {
      const src = DRONE_SAMPLE_SOURCES[droneConfig.instrument];
      player.playbackRate = freq / midiToFreq(src.baseMidi);
      return;
    }
    droneBody.frequency.rampTo(freq, time);
    droneEdge.frequency.rampTo(freq, time);
    if (droneConfig.octaveDown) {
      droneBodyDown.frequency.rampTo(freq / 2, time);
      droneEdgeDown.frequency.rampTo(freq / 2, time);
    }
    if (droneConfig.octaveUp) {
      droneBodyUp.frequency.rampTo(freq * 2, time);
      droneEdgeUp.frequency.rampTo(freq * 2, time);
    }
  }
};

// Real sampled instruments (piano: Tone.js's official Salamander set;
// guitar/bass/organ: nbrosowsky/tonejs-instruments, CC-licensed),
// pitch-shifted per note from the nearest sample — this is what
// click-a-bead/chord playback uses. Ukulele/mandolin/banjo have no
// recordings in that set; theirs are synthesized instead (see
// pluckedStringUrls below).
//
// Each Sampler is only constructed (and only starts fetching its ~17-37
// files) the first time that instrument family is actually needed, not all
// three eagerly at page load — piano+guitar+bass+drone together are ~90
// requests, and a visitor who only ever touches guitar has no reason to also
// pull down bass and piano in the background. getSampler() below is the
// lazy factory; samplerCache remembers what's already been built so
// switching back to an instrument doesn't re-fetch it.
const SAMPLER_CONFIG = {
  piano: {
    baseUrl: SAMPLES_BASE_URL + '/piano/',
    urls: {
      A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
      A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
      A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
      A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
      A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3',
      A5: 'A5.mp3', C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3',
      A6: 'A6.mp3', C7: 'C7.mp3', 'D#7': 'Ds7.mp3', 'F#7': 'Fs7.mp3',
      A7: 'A7.mp3', C8: 'C8.mp3'
    }
  },
  guitar: {
    baseUrl: SAMPLES_BASE_URL + '/guitar-acoustic/',
    urls: {
      D2: 'D2.mp3', 'D#2': 'Ds2.mp3', E2: 'E2.mp3', F2: 'F2.mp3', 'F#2': 'Fs2.mp3',
      G2: 'G2.mp3', 'G#2': 'Gs2.mp3', A2: 'A2.mp3', 'A#2': 'As2.mp3', B2: 'B2.mp3',
      C3: 'C3.mp3', 'C#3': 'Cs3.mp3', D3: 'D3.mp3', 'D#3': 'Ds3.mp3', E3: 'E3.mp3',
      F3: 'F3.mp3', 'F#3': 'Fs3.mp3', G3: 'G3.mp3', 'G#3': 'Gs3.mp3', A3: 'A3.mp3',
      'A#3': 'As3.mp3', B3: 'B3.mp3', C4: 'C4.mp3', 'C#4': 'Cs4.mp3', D4: 'D4.mp3',
      'D#4': 'Ds4.mp3', E4: 'E4.mp3', F4: 'F4.mp3', 'F#4': 'Fs4.mp3', G4: 'G4.mp3',
      'G#4': 'Gs4.mp3', A4: 'A4.mp3', 'A#4': 'As4.mp3', B4: 'B4.mp3', C5: 'C5.mp3',
      'C#5': 'Cs5.mp3', D5: 'D5.mp3'
    }
  },
  organ: {
    baseUrl: SAMPLES_BASE_URL + '/organ/',
    urls: {
      C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3', A1: 'A1.mp3',
      C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3', A2: 'A2.mp3',
      C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3', A3: 'A3.mp3',
      C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3', A4: 'A4.mp3',
      C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3', A5: 'A5.mp3',
      C6: 'C6.mp3'
    },
    // An organ pipe stops the moment the key comes up — no decay tail.
    release: 0.08,
    volume: -12 // its samples are ~6 dB hotter than the piano's, and it doesn't decay
  },
  // Volumes matched by measurement to the guitar's loudness (RMS over the
  // first second of a C4).
  ukulele:  { synth: 'ukulele', volume: -6 },
  mandolin: { synth: 'mandolin', volume: -3 },
  banjo:    { synth: 'banjo', volume: -1, highpass: 220 },
  bass: {
    baseUrl: SAMPLES_BASE_URL + '/bass-electric/',
    urls: {
      'A#1': 'As1.mp3', 'C#1': 'Cs1.mp3', E1: 'E1.mp3', G1: 'G1.mp3',
      'A#2': 'As2.mp3', 'C#2': 'Cs2.mp3', E2: 'E2.mp3', G2: 'G2.mp3',
      'A#3': 'As3.mp3', 'C#3': 'Cs3.mp3', E3: 'E3.mp3', G3: 'G3.mp3',
      'A#4': 'As4.mp3', 'C#4': 'Cs4.mp3', E4: 'E4.mp3', G4: 'G4.mp3',
      'C#5': 'Cs5.mp3'
    }
  }
};
const samplerCache = {};
function getSampler(family) {
  if (samplerCache[family]) return samplerCache[family];
  const cfg = SAMPLER_CONFIG[family];
  const sampler = new Tone.Sampler({
    urls: cfg.synth ? pluckedStringUrls(PLUCK_VOICES[cfg.synth]) : cfg.urls,
    // 0.2, not 1: this release runs AFTER the duration passed to
    // triggerAttackRelease, so at 1s every note outlasted the Playback >
    // Sustain setting by a full second — a user reported notes ringing
    // much longer than the number they'd set, and that second was why.
    // Short enough now that the setting is roughly what you hear, long
    // enough to fade rather than click. (The reverb still adds its own
    // ambient tail on top, by design — that's room, not note length.)
    release: cfg.release ?? 0.2,
    baseUrl: cfg.baseUrl || '',
    onload: refreshSampleLoadingIndicator
  });
  if (cfg.highpass) sampler.chain(new Tone.Filter(cfg.highpass, 'highpass'), reverb);
  else sampler.connect(reverb);
  sampler.volume.value = cfg.volume ?? -4;
  samplerCache[family] = sampler;
  refreshSampleLoadingIndicator();
  return sampler;
}

// Ukulele, mandolin and banjo — no free multisampled recordings of these
// to hand, so their "samples" are synthesized right here, once, the first
// time the instrument is picked: a Karplus-Strong plucked string (a burst
// of noise ringing round a tuned, slightly lossy delay loop — the classic
// physical model of a plucked string), computed straight into audio
// buffers in plain JS. A buffer every 4 semitones then goes into an
// ordinary Tone.Sampler, exactly like the recorded instruments, so every
// playback path treats them the same. Voiced per instrument:
//   ukulele  — nylon: a soft, rounded pluck, darker tone, medium ring
//   mandolin — steel: bright, and each note on two strings a few cents
//              apart (a mandolin's paired courses — that shimmer is most
//              of what makes it sound like one), shortish ring
//   banjo    — the brightest, snappiest pluck and the shortest ring, with
//              the low end thinned out afterwards (a drumhead, not a
//              wooden body)
const PLUCK_VOICES = {
  //          ring (s)  brightness  pluck pos  soft attack  string pairs (cents)
  ukulele:  { t60: 1.6, bright: 0.52, pick: 0.28, soft: 0.55, courses: [0] },
  mandolin: { t60: 1.3, bright: 0.62, pick: 0.12, soft: 0,    courses: [-4, 4] },
  banjo:    { t60: 0.8, bright: 0.72, pick: 0.08, soft: 0,    courses: [0] },
};
function pluckedStringBuffer(freq, voice) {
  const sr = Tone.context.sampleRate;
  const len = Math.floor(sr * Math.min(3, voice.t60 * 1.6));
  const out = new Float32Array(len);
  const loss = Math.pow(10, -3 / (voice.t60 * sr)); // -60 dB over t60, per sample
  voice.courses.forEach(cents => {
    const f = freq * Math.pow(2, cents / 1200);
    // The two-tap loss filter below delays the loop by (1 - bright) of a
    // sample; taking that off the delay keeps the string in tune.
    const period = sr / f - (1 - voice.bright);
    const y = new Float32Array(len);
    // Excitation: one period of noise, optionally smoothed (a fingertip
    // rather than a pick), with a comb notch for where it's plucked.
    const n0 = Math.ceil(period);
    const exc = new Float32Array(n0);
    let lp = 0;
    for (let n = 0; n < n0; n++) {
      const white = Math.random() * 2 - 1;
      lp = voice.soft ? lp + (1 - voice.soft) * (white - lp) : white;
      exc[n] = lp;
    }
    const pickAt = Math.max(1, Math.round(voice.pick * n0));
    const at = (k) => {                   // y at fractional index k, linear interpolation
      if (k < 0) return 0;
      const i = Math.floor(k), fr = k - i;
      return y[i] + fr * ((y[i + 1] || 0) - y[i]);
    };
    for (let n = 0; n < len; n++) {
      const x = n < n0 ? exc[n] - (n >= pickAt ? exc[n - pickAt] : 0) : 0;
      const k = n - period;
      y[n] = x + loss * (voice.bright * at(k) + (1 - voice.bright) * at(k - 1));
    }
    for (let n = 0; n < len; n++) out[n] += y[n];
  });
  let peak = 0;
  for (let n = 0; n < len; n++) peak = Math.max(peak, Math.abs(out[n]));
  const buf = Tone.context.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let n = 0; n < len; n++) data[n] = out[n] * (0.8 / (peak || 1));
  return buf;
}
function pluckedStringUrls(voice) {
  const urls = {};
  for (let midi = 43; midi <= 91; midi += 4) urls[midi] = pluckedStringBuffer(Tone.Frequency(midi, 'midi').toFrequency(), voice);
  return urls;
}

// Tiny "Loading sounds..." pill shown while the *currently selected*
// instrument's sampler is still fetching — re-checked (rather than tracked
// with its own show/hide calls per family) so it stays correct regardless of
// which sampler's onload actually fires: a background prefetch for an
// instrument you're not even looking at shouldn't flip this on, and
// switching to one that's already cached shouldn't leave it stuck on.
function refreshSampleLoadingIndicator() {
  const key = soundSourceKey();
  const sampler = samplerCache[key];
  const loading = !sampler || !sampler.loaded;
  document.getElementById('sample-loading').style.display = loading ? '' : 'none';
}

// Which sampler click-a-bead/scale playback should use right now (the
// ukulele/mandolin/banjo ones are synthesized — see pluckedStringUrls).
function soundSourceKey() {
  const family = INSTRUMENT_FAMILY[instrument];
  if (family === 'piano') return keyboardSound;
  return family; // guitar, bass, ukulele, mandolin, banjo
}
function currentNoteSampler() {
  return getSampler(soundSourceKey());
}
// Bass sits an octave below the other instruments (a real bass guitar
// sounds an octave down from a regular guitar), and so does the organ —
// everything else plays at the shared MIDI-60-centered register.
function samplerOctaveShift() {
  if (INSTRUMENT_FAMILY[instrument] === 'bass') return -12;
  // The organ sounds an octave down too: its recordings are bright, and an
  // octave lower is where it sits comfortably as an organ.
  if (INSTRUMENT_FAMILY[instrument] === 'piano' && keyboardSound === 'organ') return -12;
  return 0;
}

// A pitch class of E (4) or above sits noticeably higher than the C-rooted
// case once mapped onto the shared MIDI-60 register (up to 11 semitones
// above middle C for B) — pull those down an octave so no root/note ends up
// that far above where C already sits. Scale offsets are then added on top
// of whatever this returns, so the whole scale still ascends normally from
// the corrected base.
function centeredPc(pc) {
  const p = ((pc % 12) + 12) % 12;
  return p >= 4 ? p - 12 : p;
}

let droneOn = false;
let droneRootPitchClass = null;

// C3 (MIDI 48) is the old fixed base; droneConfig.octave shifts it (-1 = C2, -2 = C1, etc).
const droneBaseMidi = () => 48 + centeredPc(rootPitchClass) + 12 * droneConfig.octave;

function toggleDrone() {
  ensureAudio().then(() => {
    droneOn = !droneOn;
    if (droneOn) {
      droneRootPitchClass = rootPitchClass;
      triggerDroneAttackWhenReady(midiToFreq(droneBaseMidi()));
    } else {
      droneVoice.triggerRelease();
    }
    updateDroneButton();
  }).catch(() => {}); // logged inside ensureAudio already — just don't play if it never loaded
}

// Called every render() — if the drone is on and the root moved (root select,
// or the armband's tonic-travels rotation), glide the drone to the new tonic
// instead of retriggering, so it reads as "the same held note sliding."
function updateDronePitch() {
  if (!droneOn || rootPitchClass === droneRootPitchClass) return;
  droneRootPitchClass = rootPitchClass;
  droneVoice.rampFrequency(midiToFreq(droneBaseMidi()), 0.15);
}

// The label is a plain, unchanging "Drone" now, with a lit/unlit LED (see
// .drone-led in style.css) carrying the state instead. "Drone on"/"Drone
// off" was genuinely ambiguous — a user asked whether it described the
// current state or what pressing it would do, and both readings are
// perfectly reasonable for a button whose text changes. A lamp can only be
// read one way: lit means it's sounding. aria-pressed tells a screen
// reader the same thing the lamp tells everyone else (and is why this is a
// toggle button rather than a checkbox-styled switch — it keeps the same
// shape/size/tap target as the Play and Setup buttons beside it).
function updateDroneButton() {
  const b = document.getElementById('drone-toggle');
  b.classList.toggle('active', droneOn);
  b.setAttribute('aria-pressed', droneOn ? 'true' : 'false');
}

// midi: a real, already-octave-correct MIDI note (e.g. a fretboard
// string/fret or a specific piano key) — unlike playScaleDegree, this never
// folds/centers the pitch class, so the same physical spot always sounds at
// its true pitch: low E genuinely sounds two octaves below high E, middle C
// genuinely sits between the octave above and below it, etc.
// playbackOctave/samplerOctaveShift still apply on top, same as every other
// note-playing path, so the Setup dialog's octave slider and the
// bass-family octave-down still work as expected.
//
// Press-and-hold, for the piano and fretboard: the note starts now and
// keeps sounding until release() — which lets it
// go no sooner than the Sustain setting after the press, so a quick tap
// still rings the same as it always has. Returns { release }.
//
// Tone's Sampler releases every voice of a pitch at once, so a key that's
// struck again before its previous release has fired must cancel that
// pending release — or the old tap's timer would cut the new, still-held
// note short. pendingNoteRelease tracks those timers per sounding pitch.
const pendingNoteRelease = new Map(); // shifted midi -> timeout id

// Pedals (piano/organ — drawn beside the keys, see #pedals). A real grand
// piano has three:
//   left   — soft (una corda): shifts the hammers so fewer strings are
//            struck; quieter and a little softer in tone
//   middle — sostenuto: sustains only the notes already held when it goes
//            down (rarely used; left out here)
//   right  — sustain (damper): lifts every damper, so notes ring on after
//            the keys come up — by far the most used
// Soft and sustain are here, held down like the real thing (no toggling):
// while sustain is held, notes released by noteOn wait here, and letting
// the pedal up lets them all go (each still no sooner than the Sustain
// setting after it was struck). While soft is held, new notes are struck
// at lower velocity.
let pedalDown = false, softDown = false;
const pedalHeldNotes = [];
function setPedal(which, down) {
  document.querySelector(`#pedals [data-pedal="${which}"]`).classList.toggle('down', down);
  if (which === 'soft') { softDown = down; return; }
  pedalDown = down;
  if (!down) pedalHeldNotes.splice(0).forEach(release => release());
}
document.querySelectorAll('#pedals [data-pedal]').forEach(p => {
  const which = p.dataset.pedal;
  p.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { p.setPointerCapture(e.pointerId); } catch (_) { /* not a live pointer */ }
    setPedal(which, true);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type =>
    p.addEventListener(type, () => { if (p.classList.contains('down')) setPedal(which, false); }));
  p.addEventListener('contextmenu', e => e.preventDefault()); // long-press menu
});
function noteOn(midi) {
  const pressedAt = performance.now();
  let started = null, released = false;
  const releaseNow = () => {
    // Sustain pedal down: let it ring until the pedal comes up.
    if (pedalDown) { pedalHeldNotes.push(releaseNow); return; }
    const { sampler, shifted, freq } = started;
    const waitMs = Math.max(0, playbackSustain * 1000 - (performance.now() - pressedAt));
    const id = setTimeout(() => {
      pendingNoteRelease.delete(shifted);
      sampler.triggerRelease(freq, Tone.immediate());
    }, waitMs);
    pendingNoteRelease.set(shifted, id);
  };
  ensureAudio().then(() => {
    const sampler = currentNoteSampler();
    if (!sampler.loaded) return; // see playScaleDegree — .loaded is the reliable per-instrument check
    const shifted = midi + 12 * playbackOctave + samplerOctaveShift();
    const freq = midiToFreq(shifted);
    clearTimeout(pendingNoteRelease.get(shifted));
    pendingNoteRelease.delete(shifted);
    sampler.triggerAttack(freq, tapNoteTime(), softDown ? 0.45 : 1);
    started = { sampler, shifted, freq };
    if (released) releaseNow();
  }).catch(() => {});
  return {
    release() {
      if (released) return;
      released = true;
      if (started) releaseNow();
    }
  };
}

// A 9th/11th/13th chord's extension tones conventionally sound an octave
// above where their raw pitch-class value alone would put them (that's what
// keeps a "13th chord" from sounding like a dense cluster of adjacent
// notes) — but the abacus itself stays exactly what it's always been, a
// pitch-class wheel with no concept of octave. nameScale(set) already
// works out exactly which of `set`'s own offsets count as extensions —
// see its own extensionOffsets comment — so this (and chordAwareBeadLabel
// below) just read that one shared answer instead of each re-deriving
// their own. That single-source-of-truth is what fixed a real bug a user
// found: a chord's own NAME correctly said "(♭6)", while its bead showed
// "♭13" and its playback still sounded the chord's 9th as a plain,
// un-bumped 2nd — three different, independently-computed answers for the
// exact same two notes, simply because only the exact-match case used to
// route through this at all; a near-miss/altered chord like that one fell
// through to no octave-bump whatsoever.
function chordVoicingOctaveUp(set) {
  return nameScale(set).extensionOffsets;
}

// A 9th/11th/13th chord's extensions are conventionally NAMED as such —
// matching the chord's own name in CHORD_DICT ("Major 9th", not "Major
// 2nd-with-extra-stuff") — even though a bead for one sits at the exact
// same semitone position an ordinary 2nd/4th/6th would, and the shared
// beadLabelAt (theory.js — used by masalamap/fusionmap too, with no
// concept of "chord voicing") has no way to tell the two apart on its own.
// This wraps it: same label, with its printed degree number bumped by 7
// (2→9, 4→11, 6→13 — same accidental) whenever this exact offset is one of
// `set`'s own tagged extensions per nameScale (see extensionOffsets there,
// and chordVoicingOctaveUp just above — the SAME field, so a note reads as
// an extension here if and only if it sounds like one during playback and
// is named as one in the chord's own alteration suffix). Falls back to the
// plain label for scales (this concept is specifically about stacking
// thirds past an octave, which only genuinely describes chords, not
// scales — even an 8-note scale isn't "in 9ths"), absolute-name mode
// (nothing to renumber, it's just the note name), and the root (always
// "R", never an extension of itself).
function chordAwareBeadLabel(idx, semitone, set, labelMode, rootPitchClass) {
  const base = beadLabelAt(idx, semitone, set, labelMode, rootPitchClass);
  if (!chordMode || labelMode !== 'relative' || idx === 0) return base;
  const r = nameScale(set);
  // A note that's genuinely REPLACING a named parent chord's own chord
  // tone (e.g. this exact chord's raised 5th standing in for a missing
  // perfect 5) is what matchAlterations already described for the name
  // suffix — degree and accidental both, worked out relative to the
  // parent chord being altered, which is the right frame for a note with
  // no chord tone of its own left to compare against (there's no perfect
  // 5 in the chord at all to call this note "a step away from"). Reusing
  // that exact record, rather than recomputing this bead's degree from
  // scratch against the whole set's own generic best-fit scale-degree
  // alignment, is what keeps the name and this bead calling the SAME note
  // the SAME thing — a user caught them disagreeing (name said ♯5, this
  // bead said ♭6 for the identical note) and asked, correctly: shouldn't
  // these agree, since there's no 5th present for ♭6 to be a tension
  // above? The generic alignment's own answer isn't wrong exactly — with
  // no 7-note reference to lean on, "closer to the 6th's slot than the
  // 5th's" is a genuine tie its flat-preferring tiebreak resolves however
  // it resolves — but it has no idea a specific note is standing in for a
  // specific missing chord tone, which the alteration record does.
  const alt = r.alterations && r.alterations.find(a => a.extra === semitone);
  if (alt) return alt.symbol + alt.degree;
  const ext = r.extensionOffsets;
  if (!ext || !ext.includes(semitone)) return base;
  const m = base.match(/^([♭♯]?)(\d+)$/);
  return m ? m[1] + (Number(m[2]) + 7) : base;
}

// offset: semitones above the root within the current scale (scaleOffsets[idx],
// always ascending 0-11 — NOT folded to a pitch class). Used by the abacus
// bead clicks so a bead's note stays on the same ascending line
// previewScale already uses: center the *root* once, then
// add the raw offset on top. Centering each bead's own absolute pitch class
// independently used to fold each bead separately — any bead landing on E
// or above (pc>=4) dropped a whole octave *relative to the beads next to
// it*, which read as a scale that randomly leapt down mid-run instead of
// just the whole scale sitting an octave lower when the root itself is E or
// later.
function playScaleDegree(offset, set) {
  ensureAudio().then(() => {
    const sampler = currentNoteSampler();
    // Tone.loaded() (awaited inside ensureAudio) only reflects downloads
    // still in flight — a sample that already failed by the time we get
    // here has been silently dropped from its tracking, so it can resolve
    // "successfully" even though this specific sampler never actually
    // finished loading. .loaded is the real, per-instrument check; skip
    // rather than let triggerAttackRelease throw "buffer is either not set
    // or not loaded".
    if (!sampler.loaded) return;
    // `set` lets a live abacus drag pass the HYPOTHETICAL post-drop note
    // set (see onBeadPlay below) so the extension octave-bump already
    // reflects what release would commit to, instead of the stale,
    // not-yet-mutated global scaleOffsets.
    const octUp = chordVoicingOctaveUp(set || scaleOffsets);
    const bump = octUp && octUp.includes(offset) ? 12 : 0;
    const midi = 60 + offset + bump + centeredPc(rootPitchClass) + 12 * playbackOctave + samplerOctaveShift();
    sampler.triggerAttackRelease(midiToFreq(midi), playbackSustain, tapNoteTime());
  }).catch(() => {});
}

// Takes any set (not just the currently-loaded scaleOffsets) so the
// reference table's per-row play buttons can preview a scale/chord by ear
// without touching what's loaded on the abacus. Extension tones (see
// chordVoicingOctaveUp) get +12 added before sorting into pitch order,
// rather than being bumped in place at their raw position in the run — a
// ♭9/♯9 in particular has a *lower* raw offset than the 3rd/5th it sits
// above, so leaving it in raw-offset order would still play it as an
// early, out-of-place leap instead of where it actually belongs: last, an
// octave up.
//
// pulse(idx), optional: called at roughly the moment note `idx` actually
// sounds — used by the reference library's own rows (see addMobileCard)
// to light up THEIR OWN dot strip in step with a preview, independent of
// whichever scale/chord happens to be loaded on the abacus.
function previewScale(set, pulse) {
  // Only pulse the abacus when the scale actually being played is the one
  // currently shown there — the reference table's own per-row preview
  // buttons call this with an arbitrary OTHER set to audition it by ear
  // without disturbing what's loaded, and lighting up beads that don't
  // match what's on screen would be actively misleading, not helpful.
  // Reference equality (not a value comparison) is deliberate and exactly
  // right here: playScale() below passes scaleOffsets itself, unchanged;
  // every other caller always passes a freshly built/sliced array, which
  // can never be === scaleOffsets even if it happens to hold equal values.
  const pulseAbacus = set === scaleOffsets;
  ensureAudio().then(() => {
    const now = Tone.now();
    const octUp = chordVoicingOctaveUp(set);
    const bumpedOffset = offset => offset + (octUp && octUp.includes(offset) ? 12 : 0);
    const sampler = currentNoteSampler();
    if (!sampler.loaded) return; // see playScaleDegree — .loaded is the reliable per-instrument check
    const shift = samplerOctaveShift();
    const step = 0.24 / playbackTempo;
    const midiFor = offset => 60 + offset + centeredPc(rootPitchClass) + 12 * playbackOctave + shift;
    // Tone.js schedules the audio itself on its own precise audio-clock
    // (the `now + ...` offsets below) rather than executing synchronously,
    // so a visual pulse meant to land alongside a SCHEDULED note needs its
    // own real-wall-clock delay to match — setTimeout isn't sample-accurate
    // the way Tone's own scheduling is, but for a cosmetic highlight (not
    // something timing-critical) that's a fine trade. `t` is the note's own
    // audio-clock time; audibleDelayMs turns that into "when will it
    // actually be HEARD", which also covers Tone's lookAhead (Tone.now() is
    // already ~0.1s in the future) and the output device's own latency — a
    // Bluetooth speaker can add half a second (see §7's output latency).
    const pulseAt = (idx, t) => {
      const fire = () => { if (pulseAbacus) abacusController.pulseBead(idx); if (pulse) pulse(idx); };
      const delayMs = audibleDelayMs(t);
      if (delayMs <= 0) fire(); else setTimeout(fire, delayMs);
    };

    // The organ plays differently. An organ note doesn't decay, so short
    // detached notes sound choppy, and re-striking a pitch that's already
    // sounding (the arpeggio over a still-ringing chord) doesn't work on it
    // — the sampler releases every voice of that pitch together, so each
    // arpeggio note also cut its chord note off. Instead: a chord builds
    // up from the bottom, each note joining and holding until the full
    // chord sounds together; a scale is played legato, each note held
    // right up to the next.
    const organ = INSTRUMENT_FAMILY[instrument] === 'piano' && keyboardSound === 'organ';
    if (organ) {
      if (chordMode) {
        const midis = applyVoicing(set.map(offset => midiFor(bumpedOffset(offset))), chordVoicing);
        const run = set.map((_, idx) => ({ midi: midis[idx], idx })).sort((a, b) => a.midi - b.midi);
        const end = now + run.length * step * 1.5 + 1.2;
        run.forEach(({ midi, idx }, i) => {
          const t = now + i * step * 1.5;
          sampler.triggerAttackRelease(midiToFreq(midi), end - t, t);
          pulseAt(idx, t);
        });
      } else {
        const run = set
          .map((offset, idx) => ({ offset: bumpedOffset(offset), idx }))
          .concat([{ offset: 12, idx: 0 }])
          .sort((a, b) => a.offset - b.offset);
        run.forEach(({ offset, idx }, i) => {
          const last = i === run.length - 1;
          sampler.triggerAttackRelease(midiToFreq(midiFor(offset)), last ? step * 3 : step, now + i * step);
          pulseAt(idx, now + i * step);
        });
      }
      return;
    }

    if (chordMode) {
      // Strike the full chord together first (let it ring — the ONLY way
      // to actually hear "is this the voicing I think it is"), a short
      // PAUSE, then arpeggiate root up through the top note while the
      // chord is still ringing out underneath — rather than the scale
      // run's "root -> ... -> octave root": a user found closing an
      // arpeggio back on the root made sense for a scale (it's telling you
      // where the next octave starts) but not for a chord (there's no
      // "next octave" story to tell — it's just the same chord tone
      // twice).
      const pause = 0.36; // doubled per request from the original 0.18 first guess
      const arpMidis = set.map(offset => midiFor(bumpedOffset(offset)));
      // The voicing choice (see applyVoicing) reshapes the simultaneous
      // strike — and the arpeggio afterward now plays THOSE SAME voiced
      // pitches too (sorted by actual pitch, not by scale-degree order), so
      // a dropped note is heard exactly where the strike put it: lower
      // than its close-position neighbors, not still slotted in at its
      // original root-to-top position. A user asked for this explicitly
      // after finding the strike honored the voicing but the arpeggio
      // didn't.
      const strikeMidis = applyVoicing(arpMidis, chordVoicing);
      // A short ring tail (not just enough to cover the arpeggio) is what
      // makes it actually sound like "ringing OUT" rather than cutting off
      // right as the arpeggio ends.
      const ringTail = 0.5;
      const chordRing = pause + set.length * step + ringTail;
      set.forEach((_, idx) => {
        sampler.triggerAttackRelease(midiToFreq(strikeMidis[idx]), chordRing, now);
        pulseAt(idx, now);
      });
      const run = set
        .map((_, idx) => ({ midi: strikeMidis[idx], idx }))
        .sort((a, b) => a.midi - b.midi);
      run.forEach(({ midi, idx }, i) => {
        sampler.triggerAttackRelease(midiToFreq(midi), step * 0.9, now + pause + i * step);
        pulseAt(idx, now + pause + i * step);
      });
      return;
    }

    // Scale mode: ascending run root -> ... -> octave root (idx 0's own
    // bead pulses again for the closing repeat, same bead as the root).
    const run = set
      .map((offset, idx) => ({ offset: bumpedOffset(offset), idx }))
      .concat([{ offset: 12, idx: 0 }])
      .sort((a, b) => a.offset - b.offset);
    run.forEach(({ offset, idx }, i) => {
      sampler.triggerAttackRelease(midiToFreq(midiFor(offset)), step * 0.9, now + i * step);
      pulseAt(idx, now + i * step);
    });
  }).catch(() => {});
}

function playScale() {
  previewScale(scaleOffsets);
}

// ── §8 drone synth settings dialog ────────────────────────────────────────────
//
// Two jobs (per the request): pick a good default by ear, and leave the door
// open for future per-user customization. Every control writes straight
// through setDroneParam() -> applyDroneConfig(), so if the drone is already
// on you hear each change live as you drag a slider.

const DRONE_PRESETS = {
  triangleEdge: DRONE_DEFAULTS, // current default: static triangle + quiet plain-saw edge, no pulsing
  sinePad:      { oscType: 'sine',     voices: 1, spread: 0,  attack: 1.2, decay: 0.3, sustain: 0.9,  release: 2.5, cutoff: 12000, edgeMix: 0 },
  sawPad:       { oscType: 'sawtooth', voices: 3, spread: 30, attack: 1.5, decay: 0.4, sustain: 0.85, release: 3,   cutoff: 1800,  edgeMix: 0 } // detuned on purpose — for comparison, this one *does* pulse
};

function refreshPlaybackControls() {
  document.getElementById('playback-octave').value = playbackOctave;
  document.getElementById('playback-tempo').value = playbackTempo;
  document.getElementById('playback-sustain').value = playbackSustain;
  document.getElementById('playback-octave-val').textContent = (playbackOctave > 0 ? '+' : '') + playbackOctave + ' oct';
  document.getElementById('playback-tempo-val').textContent = playbackTempo.toFixed(1) + 'x';
  document.getElementById('playback-sustain-val').textContent = playbackSustain.toFixed(2) + 's';
}

// Reads/writes whichever of NECK_TAPER_V/_H is active for the orientation
// the instrument is CURRENTLY drawn in — not a fixed control, since a user
// asked for portrait and landscape to hold independent taper amounts (they
// want none at all in portrait, but still like some in landscape). Also
// labels the slider with which one it's currently editing, so rotating the
// device while Setup is open doesn't silently retarget the same-looking
// slider at a different value.
function refreshNeckTaperControl() {
  const vertical = verticalInstrumentMode();
  const pct = Math.round((vertical ? NECK_TAPER_V : NECK_TAPER_H) * 100);
  document.getElementById('neck-taper').value = pct;
  // Just "off" — the "(||)" this used to add was meant to picture parallel
  // neck edges back when the label still read "0 = parallel"; with that
  // explanation gone it was two bare pipes with nothing to connect them to.
  document.getElementById('neck-taper-val').textContent = pct === 0 ? 'off' : pct + '%';
  document.getElementById('neck-taper-orient').textContent = vertical ? ' (portrait)' : ' (landscape)';
}

function refreshFretFanControl() {
  const pct = Math.round(FRET_FAN * 100);
  document.getElementById('fret-fan').value = pct;
  document.getElementById('fret-fan-val').textContent = pct === 0 ? 'off' : pct + '%';
}

function refreshSynthDialogControls() {
  refreshNeckTaperControl();
  refreshFretFanControl();
  syncPerspectiveUI();
  refreshPlaybackControls();
  refreshSyncControls();
  document.getElementById('synth-drone-instrument').value = droneConfig.instrument;
  const isSample = droneConfig.instrument !== 'synth';
  // Hiding the oscillator controls entirely for a sampled drone (rather
  // than a separate explanatory hint) is the self-explanatory version of
  // "these don't apply to a sample" — no controls where none apply.
  document.getElementById('synth-osc-rows').style.display = isSample ? 'none' : 'block';

  document.getElementById('synth-osc-type').value = droneConfig.oscType;
  document.getElementById('synth-voices').value = droneConfig.voices;
  document.getElementById('synth-spread').value = droneConfig.spread;
  document.getElementById('synth-attack').value = droneConfig.attack;
  document.getElementById('synth-decay').value = droneConfig.decay;
  document.getElementById('synth-sustain').value = droneConfig.sustain;
  document.getElementById('synth-release').value = droneConfig.release;
  document.getElementById('synth-cutoff').value = droneConfig.cutoff;
  document.getElementById('synth-edge').value = droneConfig.edgeMix;
  document.getElementById('synth-octave').value = droneConfig.octave;
  document.getElementById('synth-octave-down').checked = droneConfig.octaveDown;
  document.getElementById('synth-octave-up').checked = droneConfig.octaveUp;

  document.getElementById('synth-octave-val').textContent = (droneConfig.octave > 0 ? '+' : '') + droneConfig.octave + ' oct';
  document.getElementById('synth-voices-val').textContent = droneConfig.voices;
  document.getElementById('synth-spread-val').textContent = droneConfig.spread + 'c';
  document.getElementById('synth-attack-val').textContent = droneConfig.attack.toFixed(2) + 's';
  document.getElementById('synth-decay-val').textContent = droneConfig.decay.toFixed(2) + 's';
  document.getElementById('synth-sustain-val').textContent = droneConfig.sustain.toFixed(2);
  document.getElementById('synth-release-val').textContent = droneConfig.release.toFixed(2) + 's';
  document.getElementById('synth-cutoff-val').textContent = droneConfig.cutoff + 'Hz';
  document.getElementById('synth-edge-val').textContent = droneConfig.edgeMix + '%';
}

function setDroneInstrument(instr) {
  // Swap instruments cleanly: stop whatever's currently sounding under the
  // old instrument, switch, then restart at the same pitch if the drone
  // was on — otherwise you'd get the old synth voice hanging alongside a
  // freshly-started sample, or vice versa.
  const wasOn = droneOn;
  if (wasOn) droneVoice.triggerRelease();
  droneConfig.instrument = instr;
  localStorage.setItem('n4a-drone-config', JSON.stringify(droneConfig));
  if (wasOn) triggerDroneAttackWhenReady(midiToFreq(droneBaseMidi()));
  refreshSynthDialogControls();
}

function applyDronePreset(name) {
  if (!DRONE_PRESETS[name]) return;
  droneConfig = Object.assign({}, DRONE_DEFAULTS, DRONE_PRESETS[name]); // defaults fill in anything the preset omits (e.g. octave)
  localStorage.setItem('n4a-drone-config', JSON.stringify(droneConfig));
  applyDroneConfig();
  if (droneOn) droneVoice.rampFrequency(midiToFreq(droneBaseMidi()), 0.1);
  refreshSynthDialogControls();
}

// Perspective is "on" when either slider is actually doing something —
// derived rather than stored, so it can't disagree with the sliders it
// summarises (a stored flag would have to be kept in sync with every
// taper/fan change, including the ones that happen by rotating the device
// into an orientation with its own taper value).
function perspectiveOn() {
  return (verticalInstrumentMode() ? NECK_TAPER_V : NECK_TAPER_H) > 0 || (!verticalInstrumentMode() && FRET_FAN > 0);
}
// Remembers what to restore when the switch is turned back on, so flicking
// it off and on again doesn't silently reset a carefully-set taper to some
// default. Seeded with a sensible default for a first-ever switch-on.
let perspectiveRestore = { taper: 0.06, fan: 0.08 };
function syncPerspectiveUI() {
  const on = perspectiveOn();
  document.getElementById('perspective-toggle').checked = on;
  document.getElementById('perspective-rows').style.display = on ? '' : 'none';
}

function syncPaletteUI() {
  // Choosing a palette is a paid-tier feature (it lived in Setup, which the
  // free tier doesn't get); the meanings are for everyone.
  document.getElementById('palette-controls').hidden = tier === 'free';
  const group = document.getElementById('palette-toggle');
  const customGroup = document.getElementById('palette-custom-toggle');
  if (!group.children.length) {
    Object.entries(PALETTES).forEach(([key, p]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hand-btn';
      b.setAttribute('role', 'radio');
      b.dataset.palette = key;
      if (key === 'custom') {
        b.classList.add('custom-palette-btn');
        b.innerHTML = '<span aria-hidden="true">🎨</span> ' + p.label;
      } else {
        b.textContent = p.label;
      }
      b.addEventListener('click', () => { applyPalette(key); syncPaletteUI(); renderColorsPopup(); });
      (key === 'custom' ? customGroup : group).appendChild(b);
    });
  }
  document.querySelectorAll('[data-palette]').forEach(b => {
    const on = b.dataset.palette === paletteName;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

function wireSynthDialog() {
  document.getElementById('perspective-toggle').addEventListener('change', e => {
    const vertical = verticalInstrumentMode();
    if (e.target.checked) {
      if (vertical) { NECK_TAPER_V = perspectiveRestore.taper; localStorage.setItem('n4a-neck-taper-v', NECK_TAPER_V); }
      else { NECK_TAPER_H = perspectiveRestore.taper; localStorage.setItem('n4a-neck-taper-h', NECK_TAPER_H); }
      FRET_FAN = perspectiveRestore.fan;
    } else {
      perspectiveRestore = { taper: vertical ? NECK_TAPER_V : NECK_TAPER_H, fan: FRET_FAN };
      // Zero is what "no perspective" means everywhere else in this code
      // (see taperAt/fanFactor), so turning the switch off is literally
      // setting both to it rather than a separate suppressed state.
      if (vertical) { NECK_TAPER_V = 0; localStorage.setItem('n4a-neck-taper-v', 0); }
      else { NECK_TAPER_H = 0; localStorage.setItem('n4a-neck-taper-h', 0); }
      FRET_FAN = 0;
    }
    localStorage.setItem('n4a-fret-fan', FRET_FAN);
    syncNeckMetrics();
    refreshNeckTaperControl();
    refreshFretFanControl();
    syncPerspectiveUI();
    renderFretboard();
  });

  document.getElementById('neck-taper').addEventListener('input', e => {
    const vertical = verticalInstrumentMode();
    const val = Number(e.target.value) / 100;
    if (vertical) {
      NECK_TAPER_V = val;
      localStorage.setItem('n4a-neck-taper-v', NECK_TAPER_V);
    } else {
      NECK_TAPER_H = val;
      localStorage.setItem('n4a-neck-taper-h', NECK_TAPER_H);
    }
    syncNeckMetrics();
    refreshNeckTaperControl();
    renderFretboard();
  });
  document.getElementById('fret-fan').addEventListener('input', e => {
    FRET_FAN = Number(e.target.value) / 100;
    localStorage.setItem('n4a-fret-fan', FRET_FAN);
    refreshFretFanControl();
    renderFretboard();
  });

  [['playback-octave', 'octave'], ['playback-tempo', 'tempo'], ['playback-sustain', 'sustain']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('input', e => {
      setPlaybackSetting(key, Number(e.target.value));
      refreshPlaybackControls();
    });
  });

  document.getElementById('sync-adjust').addEventListener('input', e => setSyncAdjust(Number(e.target.value)));
  document.getElementById('sync-test-btn').addEventListener('click', runSyncTest);

  const numFields = [
    ['synth-voices', 'voices', Number],
    ['synth-spread', 'spread', Number],
    ['synth-attack', 'attack', Number],
    ['synth-decay', 'decay', Number],
    ['synth-sustain', 'sustain', Number],
    ['synth-release', 'release', Number],
    ['synth-cutoff', 'cutoff', Number],
    ['synth-edge', 'edgeMix', Number],
    ['synth-octave', 'octave', Number]
  ];
  numFields.forEach(([id, key, cast]) => {
    document.getElementById(id).addEventListener('input', e => {
      setDroneParam(key, cast(e.target.value));
      document.getElementById('synth-preset').value = ''; // now custom
      refreshSynthDialogControls();
    });
  });
  document.getElementById('synth-osc-type').addEventListener('input', e => {
    setDroneParam('oscType', e.target.value);
    document.getElementById('synth-preset').value = '';
  });
  document.getElementById('synth-octave-down').addEventListener('change', e => {
    setDroneParam('octaveDown', e.target.checked);
    document.getElementById('synth-preset').value = '';
  });
  document.getElementById('synth-octave-up').addEventListener('change', e => {
    setDroneParam('octaveUp', e.target.checked);
    document.getElementById('synth-preset').value = '';
  });
  document.getElementById('synth-preset').addEventListener('change', e => {
    if (e.target.value) applyDronePreset(e.target.value);
  });
  document.getElementById('synth-drone-instrument').addEventListener('change', e => {
    setDroneInstrument(e.target.value);
  });
  document.getElementById('synth-reset-btn').onclick = () => applyDronePreset('triangleEdge');
  // Same popup mechanism (× button + backdrop-click) as the settings/scale
  // library popups, not a standalone "Close" button — matching their style
  // rather than reading as a separate, desktop-feeling dialog.
  wireMobilePopup(document.getElementById('synth-dialog'), 'synth-popup-close');
  document.getElementById('synth-settings-btn').onclick = () => {
    refreshSynthDialogControls();
    document.getElementById('synth-dialog').showModal();
  };
}

// ── main render ───────────────────────────────────────────────────────────────

function render() {
  syncArmband();
  renderRoot();
  abacusController.sync({ scaleOffsets, rootPitchClass, labelMode });
  renderName();
  renderModeLabel();
  renderInstrumentView();
  updateDronePitch();
  // Was gated on labelMode === 'absolute' (that mode's own reference-table
  // labels depend on rootPitchClass, so only THAT case used to need a
  // refresh here) — but labelMode is permanently 'relative' now (see its
  // declaration up top; the toggle that used to switch it is gone), so
  // that condition was always false and this line never actually ran,
  // which nobody noticed until it broke something else that also needed
  // renderTable() to run on every render(): the library's own "highlight
  // whichever row matches what's currently loaded" (addRow's
  // ref-row-current class, added well after this guard was written) is
  // computed fresh each time renderTable() builds the table, so with this
  // never firing, the highlighted row was frozen at whatever had been
  // loaded the last time something ELSE happened to call renderTable()
  // directly (switching note-count, Scale/Chord mode, etc.) — a user
  // caught this as a highlight that looked "stuck" on an old chord.
  renderTable();
}

// wire up mode stepping (buttons + keyboard)
document.getElementById('mode-prev').onclick = () => stepMode(-1);
document.getElementById('mode-next').onclick = () => stepMode(1);
document.getElementById('mode-controls').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft')  { e.preventDefault(); stepMode(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepMode(1); }
});

// wire up handedness toggle
document.getElementById('hand-left').onclick  = () => setOrientation('left');
document.getElementById('hand-right').onclick = () => setOrientation('right');


// wire up view mode toggle (beginner vs advanced)
document.getElementById('view-mode-switch').onclick = () => setViewMode(viewMode === 'beginner' ? 'advanced' : 'beginner');

// wire up instrument toggle (family buttons + string-count sub-toggles)
document.getElementById('instr-guitar').onclick   = () => setInstrumentFamily('guitar');
document.getElementById('instr-bass').onclick     = () => setInstrumentFamily('bass');
document.getElementById('instr-ukulele').onclick  = () => setInstrumentFamily('ukulele');
document.getElementById('instr-mandolin').onclick = () => setInstrumentFamily('mandolin');
document.getElementById('instr-banjo').onclick    = () => setInstrumentFamily('banjo');
document.getElementById('instr-piano').onclick    = () => { setKeyboardSound('piano'); setInstrumentFamily('piano'); };
document.getElementById('instr-organ').onclick    = () => { setKeyboardSound('organ'); setInstrumentFamily('piano'); };
document.getElementById('guitar-strings-5').onclick = () => setGuitarStrings(5);
document.getElementById('guitar-strings-6').onclick = () => setGuitarStrings(6);
document.getElementById('guitar-strings-7').onclick = () => setGuitarStrings(7);
document.getElementById('guitar-strings-8').onclick = () => setGuitarStrings(8);
document.getElementById('bass-strings-4').onclick   = () => setBassStrings(4);
document.getElementById('bass-strings-5').onclick   = () => setBassStrings(5);
document.getElementById('bass-strings-6').onclick   = () => setBassStrings(6);
document.getElementById('tuning-preset').addEventListener('change', e => {
  if (e.target.value) applyTuningPreset(e.target.value);
});

// wire up reference-table controls
document.getElementById('rowmode-toggle').addEventListener('change', e => {
  refRowMode = e.target.checked ? 'modes' : 'families';
  renderTable();
});
document.getElementById('mode-scale-btn').onclick = () => setChordMode(false);
document.getElementById('mode-chord-btn').onclick = () => setChordMode(true);
setChordMode(chordMode); // syncs button/hidden states to the persisted mode and loads a matching default

// ── custom dropdowns (root picker, chord voicing) ────────────────────────
//
// Both are a plain button + a list of divs rather than a native <select> —
// see renderRoot for that story. The list is positioned with position:
// FIXED and explicit viewport coordinates computed here at open time, not
// with the position:absolute + bottom:100% that CSS alone could express:
// both of these buttons live in a row (.quickbar in landscape, #root-row
// in portrait) that sets overflow-x:auto as a narrow-screen safety net,
// and an overflow:auto ancestor clips absolutely-positioned descendants
// that fall outside it. The list opens UPWARD, i.e. entirely outside that
// row's own box, so it was being clipped away to nothing — a user reported
// the landscape root picker as "nothing happens when I click it," which is
// exactly what a correctly-opened-but-fully-clipped panel looks like.
// Fixed positioning is relative to the viewport and escapes every
// clipping ancestor, which no amount of z-index can do.
function openDropdown(btn, list) {
  list.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect();
  // Opens upward (see .dropdown-list in style.css for why): these rows sit
  // at the bottom of the screen in both orientations, so there's far more
  // room above than below.
  const gap = 4, edge = 8;
  list.style.position = 'fixed';
  list.style.top = 'auto';
  list.style.bottom = (window.innerHeight - r.top + gap) + 'px';
  list.style.minWidth = r.width + 'px';
  // Nudged back inside the viewport if the list is wider than its button
  // and that button sits near the right edge.
  list.style.right = 'auto';
  list.style.left = r.left + 'px';
  list.style.maxHeight = Math.max(80, r.top - gap - edge) + 'px';
  const listRect = list.getBoundingClientRect();
  if (listRect.right > window.innerWidth - edge) {
    list.style.left = Math.max(edge, window.innerWidth - edge - listRect.width) + 'px';
  }
}
function closeDropdown(btn, list) {
  list.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
}
// One shared wiring for both: toggle on the button, close on a tap
// anywhere outside (the list has no backdrop of its own — it's a plain
// panel, not a <dialog> — so this is what makes tapping away behave like
// any other dropdown), and close on scroll/rotate, since the fixed
// coordinates above are a snapshot taken at open time and would otherwise
// leave the panel stranded away from its own button.
function wireDropdown(btn, list, wrapper) {
  btn.addEventListener('click', () => {
    if (list.hidden) openDropdown(btn, list); else closeDropdown(btn, list);
  });
  document.addEventListener('pointerdown', e => {
    if (!list.hidden && !wrapper.contains(e.target)) closeDropdown(btn, list);
  });
  window.addEventListener('resize', () => { if (!list.hidden) closeDropdown(btn, list); });
  document.addEventListener('scroll', () => { if (!list.hidden) closeDropdown(btn, list); }, true);
}

const rootSelectBtn = document.getElementById('root-select-btn');
const rootSelectList = document.getElementById('root-select-list');
function closeRootSelectMobile() { closeDropdown(rootSelectBtn, rootSelectList); }
wireDropdown(rootSelectBtn, rootSelectList, document.getElementById('root-select-mobile'));

// Chord voicing — see syncChordModeUI for its show/hide, and applyVoicing/
// previewScale for what it actually changes.
const voicingSelectBtn = document.getElementById('voicing-select-btn');
const voicingSelectList = document.getElementById('voicing-select-list');
function closeVoicingSelect() { closeDropdown(voicingSelectBtn, voicingSelectList); }
wireDropdown(voicingSelectBtn, voicingSelectList, document.getElementById('voicing-select'));
Object.entries(VOICING_LABELS).forEach(([value, label]) => {
  const opt = document.createElement('div');
  opt.className = 'dropdown-option';
  opt.setAttribute('role', 'option');
  opt.dataset.value = value;
  opt.textContent = label;
  opt.addEventListener('click', () => { setChordVoicing(value); closeVoicingSelect(); });
  voicingSelectList.appendChild(opt);
});
refreshVoicingSelectUI();

// The instrument-setup and scale-library popups. The instrument trigger
// isn't a separate button: it's the fretboard's own #instrument-label,
// parked into the quickbar (see below). Opening either reparents the
// relevant content into a <dialog> — .mobile-collapsible sections for
// instrument setup, .col-ref for the scale library — and moves it back on
// close. A popup has its own scroll/stacking context, so the fretboard and
// abacus underneath never need to grow or scroll to make room for it.
// With the library sidebar showing (html.lib-side — see applyLayout) the
// library is already on screen, so Browse is hidden and tapping the scale
// name does nothing.

// Landscape can land with the camera/sensor housing on either physical
// edge depending on which way the phone was turned — but on-device
// measurement (iPhone 13 mini) found env(safe-area-inset-left) and
// env(safe-area-inset-right) come back EQUAL regardless of rotation, so CSS
// alone can't tell the two sides apart. screen.orientation.type can:
// 'landscape-primary'/'landscape-secondary' map to a fixed physical
// rotation direction, and since the notch/camera sits at the same
// top-center spot in portrait on every iPhone that has one, which
// orientation.type value puts it on which landscape edge is a fixed
// mapping — universal once known, not per-device.
const landscapeAppModeMQ = window.matchMedia('(orientation: landscape) and (max-height: 500px)');
function updateCameraSideClass() {
  const root = document.documentElement;
  if (!landscapeAppModeMQ.matches) { root.classList.remove('cam-left', 'cam-right'); return; }
  const isSecondary = !!(screen.orientation && screen.orientation.type === 'landscape-secondary');
  root.classList.toggle('cam-left', !isSecondary);
  root.classList.toggle('cam-right', isSecondary);
}
updateCameraSideClass();
landscapeAppModeMQ.addEventListener('change', updateCameraSideClass);
if (screen.orientation) screen.orientation.addEventListener('change', updateCameraSideClass);

function wireMobilePopup(dialog, closeBtnId) {
  document.getElementById(closeBtnId).addEventListener('click', () => dialog.close());
  // Clicking the backdrop (outside the dialog's own box) closes it — native
  // <dialog> reports such clicks with target === the dialog element itself,
  // so distinguishing them from a click inside needs a bounding-box check.
  dialog.addEventListener('click', e => {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
}

// Moves `nodes` into `container` and returns a restore function that puts
// each one back at its original (parent, next-sibling) position — used so
// the popups can borrow the real, ID-referenced elements instead of cloning
// them (app.js renders into these by ID, so clones would go stale).
function parkNodes(nodes, container) {
  const spots = nodes.map(node => ({ node, parent: node.parentNode, next: node.nextSibling }));
  nodes.forEach(node => container.appendChild(node));
  return () => spots.forEach(({ node, parent, next }) => parent.insertBefore(node, next));
}

const settingsPopup = document.getElementById('settings-popup');
const settingsPopupBody = document.getElementById('settings-popup-body');
let restoreSettingsNodes = null;
wireMobilePopup(settingsPopup, 'settings-popup-close');
settingsPopup.addEventListener('close', () => {
  if (restoreSettingsNodes) { restoreSettingsNodes(); restoreSettingsNodes = null; }
  document.getElementById('instrument-label').setAttribute('aria-expanded', 'false');
});

const reflibPopup = document.getElementById('reflib-popup');
const reflibPopupBody = document.getElementById('reflib-popup-body');
let restoreReflibNodes = null;
wireMobilePopup(reflibPopup, 'reflib-popup-close');
reflibPopup.addEventListener('close', () => {
  if (restoreReflibNodes) { restoreReflibNodes(); restoreReflibNodes = null; }
  document.getElementById('reflib-open-btn').setAttribute('aria-expanded', 'false');
});

function openSettingsPopup() {
  if (settingsPopup.open) { settingsPopup.close(); return; }
  reflibPopup.close();
  restoreSettingsNodes = parkNodes(Array.from(document.querySelectorAll('.mobile-collapsible')), settingsPopupBody);
  settingsPopup.showModal();
  document.getElementById('instrument-label').setAttribute('aria-expanded', 'true');
}
document.getElementById('instrument-label').addEventListener('click', openSettingsPopup);

function openReflibPopup() {
  if (reflibPopup.open) { reflibPopup.close(); return; }
  settingsPopup.close();
  restoreReflibNodes = parkNodes([document.querySelector('.col-ref')], reflibPopupBody);
  reflibPopup.showModal();
  document.getElementById('reflib-open-btn').setAttribute('aria-expanded', 'true');
}
document.getElementById('reflib-open-btn').addEventListener('click', openReflibPopup);

// Tapping the scale name itself (not just Browse) also opens the library —
// people naturally tap the current value to change it. Not when the
// library is already showing as the sidebar.
document.getElementById('scale-name').addEventListener('click', () => {
  if (!currentLayout.sidebar) openReflibPopup();
});

// #instrument-label lives in the quickbar rather than its original spot
// above the fretboard, collapsing what would otherwise be a separate row
// into the one toolbar. The "Loading sounds…" indicator used to ride along
// into the quickbar too, but on a phone its extra width pushed the row
// past the screen edge while samples loaded, leaving a toolbar that
// scrolled a few pixels and then settled — the stray horizontal
// scrollbar. It floats over the instrument's corner instead (style.css),
// taking no room in any row.
const quickbar = document.getElementById('quickbar');
parkNodes([document.getElementById('instrument-label')], quickbar);
parkNodes([document.getElementById('sample-loading')], document.getElementById('fretboard-wrap'));
updateInstrumentUI();

// "SpiceMap" moves out of .header-row (never shown) into the left of the
// scale-name row.
const scaleNameRowLeft = document.getElementById('scale-name-row-left');
parkNodes([document.querySelector('.header-row h1')], scaleNameRowLeft);

// Mode(Scale/Chord)+note-count move out of #root-row (which only keeps the
// Root picker) and into the scale-name row's right side, alongside Browse.
const scaleNameActions = document.querySelector('.scale-name-actions');
parkNodes([document.getElementById('notecount-group')], scaleNameActions);

// Upright layout only: the mode/inversion stepper moves out of .quickbar
// (last row) and in next to the Root picker on #root-row (second-last row)
// instead, leaving .quickbar with just Drone/Play/Instrument/Setup — so the
// stepper reads as "part of choosing what's loaded" (root+mode together)
// rather than sitting in the transport row with playback controls.
const rootRow = document.getElementById('root-row');
const modeControls = document.getElementById('mode-controls');
let restoreModeControlsNodes = null;
function applyModeControlsPlacement() {
  if (verticalInstrumentMode()) {
    if (!restoreModeControlsNodes) {
      restoreModeControlsNodes = parkNodes([modeControls], rootRow);
    }
  } else if (restoreModeControlsNodes) {
    restoreModeControlsNodes();
    restoreModeControlsNodes = null;
  }
}

// Lying-down layout only: the Root picker joins the quickbar's one row
// instead of costing a whole row of its own (#root-row is then empty and
// hidden by CSS — #notecount-group has already moved out of it above).
const rootGroup = document.getElementById('root-group');
let restoreRootGroupNodes = null;
function applyRootSelectorPlacement() {
  if (!verticalInstrumentMode()) {
    if (!restoreRootGroupNodes) {
      restoreRootGroupNodes = parkNodes([rootGroup], quickbar);
    }
  } else if (restoreRootGroupNodes) {
    restoreRootGroupNodes();
    restoreRootGroupNodes = null;
  }
}

// Whether the instrument draws lying down or standing up is decided at draw
// time (see verticalInstrumentMode), so rotating the device has to trigger a
// redraw — the CSS reflow alone would just letterbox the old orientation.
// The abacus stands up with it, so it can sit in a narrow column beside the
// instrument rather than costing a full row of height above it.
// A "hide the instruments for two animation frames while rotating" trick
// briefly lived here, to suppress the one stale frame the browser paints
// between the CSS media query flipping and this re-render landing. It made
// things distinctly worse on device — slower rotation, and a white flash —
// most likely because requestAnimationFrame is throttled or parked during
// iOS's own rotation animation, so "two frames" turned into a long, visible
// blank rather than an imperceptible one. Reverted deliberately: the stale
// frame it was chasing is a much smaller annoyance than what replaced it.
function applyInstrumentOrientation() {
  const vertical = verticalInstrumentMode();
  abacusController.setVertical(vertical);
  abacusController.setBeadRadius(vertical ? AB_BR_VERTICAL : AB_BR);
  renderInstrumentView();
  // Neck taper is portrait/landscape-independent (NECK_TAPER_V/_H) — if
  // Setup is open while the device rotates, its slider has to retarget to
  // the other value rather than keep showing the orientation it opened in.
  const synthDialog = document.getElementById('synth-dialog');
  if (synthDialog.open) refreshNeckTaperControl();
  refreshInstrumentSizeControls();
}
applyInstrumentOrientation();

// ── layout ────────────────────────────────────────────────────────────────
// One place decides the whole screen arrangement (see spicemapLayout in
// index.html for the rules): upright vs lying-down instrument, and whether
// the scale library sits in a sidebar. The html classes it sets are what
// style.css keys off; this also re-runs everything that has to follow the
// orientation in JS (control placement, the instrument redraw).
function applyLayout() {
  const L = window.spicemapLayout();
  const prev = currentLayout;
  currentLayout = L;
  window.spicemapApplyLayoutClasses(L);
  if (L.sidebar && reflibPopup.open) reflibPopup.close();
  if (!prev || prev.vertical !== L.vertical) {
    applyModeControlsPlacement();
    applyRootSelectorPlacement();
    applyInstrumentOrientation();
  }
  sizeLibrarySidebar();
  syncSvgTextScale();
}

// Column sizes for the sidebar layout. Lying down, the fretboard is
// width-hungry, so the library gets a fixed column. Standing up, the
// instrument only needs a column as wide as its own drawing is at the
// available height — measured from the instrument SVG's aspect ratio —
// and the library takes the rest. If that would leave the library too
// narrow to read, it goes back behind Browse instead.
const LIB_MIN_W = 240, LIB_MAX_W = 520;
function sizeLibrarySidebar() {
  const layout = document.getElementById('layout');
  const L = currentLayout;
  if (!L.sidebar) { layout.style.gridTemplateColumns = ''; return; }
  if (!L.vertical) {
    layout.style.gridTemplateColumns = 'clamp(300px, 28vw, 400px) minmax(0, 1fr)';
    return;
  }
  const wrap = document.getElementById('fretboard-wrap');
  const svg = document.getElementById(instrument === 'piano' ? 'piano' : 'fretboard');
  const vb = svg.viewBox.baseVal;
  const pedals = document.getElementById('pedals');
  const abacusCol = document.getElementById('abacus').getBoundingClientRect().width;
  const gaps = 10 + 16 + (pedals.hidden ? 0 : pedals.getBoundingClientRect().width + 8);
  const needed = abacusCol + gaps + (vb && vb.height ? wrap.clientHeight * vb.width / vb.height : 300);
  const avail = layout.clientWidth;
  // At least wide enough for the title and control rows; past a readable
  // width the library stops growing and the instrument's column takes the
  // rest (its drawing just centres in it).
  const mainW = Math.max(440, Math.ceil(needed));
  if (avail - mainW < LIB_MIN_W) {
    L.sidebar = false;
    window.spicemapApplyLayoutClasses(L);
    layout.style.gridTemplateColumns = '';
    return;
  }
  layout.style.gridTemplateColumns = `minmax(${LIB_MIN_W}px, ${LIB_MAX_W}px) minmax(${mainW}px, 1fr)`;
}

// Rotate: flips upright/lying-down for the current screen orientation and
// remembers it (separately for portrait and landscape screens).
document.getElementById('rotate-btn').addEventListener('click', () => {
  const key = 'n4a-instr-orient-' + (currentLayout.portrait ? 'portrait' : 'landscape');
  localStorage.setItem(key, currentLayout.vertical ? 'h' : 'v');
  applyLayout();
});

let layoutRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(layoutRaf);
  layoutRaf = requestAnimationFrame(applyLayout);
});
applyLayout();

// color legend — the meanings describe Sentiment12's colors specifically
// (scarlet = spicy, brown = sad…), so its swatches always show those,
// whichever palette the instrument is currently drawn in.
function renderLegendSwatches() {
  document.querySelectorAll('.legend-swatch').forEach(el => {
    el.style.background = PAL[Number(el.dataset.degree)];
  });
}

// The Colors popup — explains whichever palette is active. Rows come from
// the desktop legend's short table (cloned, not written out twice), so the
// meanings can't drift apart. The reduced palettes show just the degrees
// they color plus one row for everything they leave gray. Rainbow has no
// meanings, just its colors. Custom is the user's own: a color picker and
// a blank "what it means to you" field per note (see customPaletteTable).
const PALETTE_INFO = {
  sentiment12: { intro: 'Every scale degree has its own color, chosen for how it feels.' },
  rootonly: {
    intro: 'Only home is marked — every other note in the scale is gray.',
    degrees: [0],
  },
  thirdsfive: {
    intro: 'The skeleton of a triad: the root, the 3rd that makes it minor or major, and the 5th.',
    degrees: [0, 3, 4, 7], colorNames: { 7: 'blue' },
  },
  rainbow: { intro: 'A color wheel run once around the octave: neighbouring notes get neighbouring colors. No meanings attached — it shows a shape, not a mood.' },
  custom: { intro: 'Pick a color for each note, and write down what it means to you.' },
};

// Your own words for your own colors (Custom), one per degree.
let customMeanings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('n4a-custom-meanings') || 'null');
    if (Array.isArray(saved) && saved.length === 12) return saved;
  } catch (_) { /* fall through */ }
  return new Array(12).fill('');
})();

// Note | color | meaning, for the palettes that have their own colors
// rather than Sentiment12's (Rainbow, Custom). Custom's color column is a
// live color picker and its meaning column a text field, prefilled with
// Sentiment12's meaning as a greyed-out example.
function ownPaletteTable(editable) {
  const colors = PALETTES[paletteName].colors;
  const table = document.createElement('table');
  table.className = 'legend-table';
  table.innerHTML = `<thead><tr><th>Note</th><th>Color</th>${editable ? '<th>Means to you</th>' : ''}</tr></thead>`;
  const tbody = document.createElement('tbody');
  TABLE_LABELS.forEach((lbl, i) => {
    const tr = document.createElement('tr');
    const note = document.createElement('td');
    note.textContent = lbl;
    const color = document.createElement('td');
    if (editable) {
      const cell = document.createElement('label');
      cell.className = 'palette-swatch';
      const well = document.createElement('input');
      well.type = 'color';
      well.value = colors[i];
      well.setAttribute('aria-label', `Color for ${lbl}`);
      well.addEventListener('input', e => setCustomPaletteColor(i, e.target.value));
      cell.appendChild(well);
      color.appendChild(cell);
    } else {
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = colors[i];
      color.appendChild(sw);
    }
    tr.append(note, color);
    if (editable) {
      const meaning = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'custom-meaning';
      input.value = customMeanings[i];
      const example = document.querySelector(`#color-legend .legend-swatch[data-degree="${i}"]`);
      input.placeholder = example ? example.closest('tr').lastElementChild.textContent : '';
      input.setAttribute('aria-label', `What ${lbl} means to you`);
      input.addEventListener('input', e => {
        customMeanings[i] = e.target.value;
        localStorage.setItem('n4a-custom-meanings', JSON.stringify(customMeanings));
      });
      meaning.appendChild(input);
      tr.appendChild(meaning);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}
const legendTable = document.querySelector('#color-legend .legend-table');
function renderColorsPopup() {
  const info = PALETTE_INFO[paletteName];
  document.getElementById('colors-popup-intro').textContent = info.intro;
  if (paletteName === 'rainbow' || paletteName === 'custom') {
    document.getElementById('colors-popup-body').replaceChildren(ownPaletteTable(paletteName === 'custom'));
    return;
  }
  const table = legendTable.cloneNode(true);
  const tbody = table.querySelector('tbody');
  if (info.degrees) {
    const colors = PALETTES[paletteName].colors;
    const rows = info.degrees.map(d => {
      const tr = tbody.querySelector(`.legend-swatch[data-degree="${d}"]`).closest('tr');
      const sw = tr.querySelector('.legend-swatch');
      sw.style.background = colors[d];
      if (info.colorNames && info.colorNames[d]) sw.nextSibling.textContent = info.colorNames[d];
      return tr;
    });
    const rest = document.createElement('tr');
    rest.innerHTML = '<td>others</td><td><span class="legend-swatch"></span>gray</td><td>Still in the scale, just not highlighted.</td>';
    rest.querySelector('.legend-swatch').style.background = DIM;
    tbody.replaceChildren(...rows, rest);
  }
  const parts = [table];
  // The longer write-up (feeling / function / where you hear it) that used
  // to sit under the instrument on the old desktop page — for the full
  // Sentiment12 palette only, folded away until asked for.
  if (!info.degrees) {
    const more = document.createElement('details');
    more.className = 'colors-full-explainer';
    const summary = document.createElement('summary');
    summary.textContent = 'Full explainer';
    // Read out of the desktop legend's 4-column table, but laid out as one
    // small block per degree: four columns of long text don't fit a phone.
    const blocks = [...document.querySelectorAll('#legend-full-wrap tbody tr')].map(tr => {
      const [degree, feeling, fn, use] = tr.children;
      const block = document.createElement('div');
      block.className = 'explainer-degree';
      const head = document.createElement('div');
      head.className = 'explainer-head';
      head.append(...[...degree.cloneNode(true).childNodes], ' — ', feeling.textContent);
      const f = document.createElement('p');
      f.textContent = fn.textContent;
      const u = document.createElement('p');
      u.className = 'explainer-use';
      u.innerHTML = use.innerHTML; // keeps its <em>
      block.append(head, f, u);
      return block;
    });
    more.append(summary, ...blocks);
    parts.push(more);
  }
  document.getElementById('colors-popup-body').replaceChildren(...parts);
}
const colorsPopup = document.getElementById('colors-popup');
wireMobilePopup(colorsPopup, 'colors-popup-close');
document.getElementById('colors-btn').addEventListener('click', () => {
  syncPaletteUI();
  renderColorsPopup();
  colorsPopup.showModal();
});
renderLegendSwatches();
let legendExpanded = localStorage.getItem('n4a-legend-expanded') === 'true';
document.getElementById('legend-full-wrap').style.display = legendExpanded ? 'block' : 'none';
document.getElementById('legend-chevron').innerHTML = legendExpanded ? '&#9660;' : '&#9654;';
document.getElementById('legend-header').addEventListener('click', () => {
  legendExpanded = !legendExpanded;
  localStorage.setItem('n4a-legend-expanded', legendExpanded);
  document.getElementById('legend-full-wrap').style.display = legendExpanded ? 'block' : 'none';
  document.getElementById('legend-chevron').innerHTML = legendExpanded ? '&#9660;' : '&#9654;';
});

// wire up drone toggle + sequential playback
document.getElementById('drone-toggle').onclick = () => toggleDrone();
document.getElementById('play-scale-btn').onclick = () => playScale();
wireSynthDialog();


renderHandToggle();
updateInstrumentUI();
// Before the first render, not after: every drawing below picks its colors
// through colorOf(), so the saved palette has to be installed first or the
// app paints once in Spice and then repaints. rerender:false because the
// render() a few lines down is about to do that anyway.
applyPalette(paletteName, { rerender: false });
setViewMode(viewMode); // syncs beginner/advanced UI + renders the table once

render();
renderLegendSwatches();
// Start loading the current instrument's samples right away instead of
// waiting for the first click — see currentNoteSampler()/getSampler().
currentNoteSampler();
// Same treatment for the drone's own sample-based voices (harmonium/
// organ, the shipped default) — see triggerDroneAttackWhenReady's comment
// for the bug this closes most of the window on (a retry path there
// covers what warming up here can't: a tap fast enough to race this
// fetch, or switching to a drone instrument that was never warmed).
if (DRONE_SAMPLE_SOURCES[droneConfig.instrument]) getDronePlayer(droneConfig.instrument);
