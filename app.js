// ── §-1 chrome theme (background/text tokens only — see :root in <style>) ────
// Not exposed in the GUI — edit this constant to try a different chrome
// theme: 'indigo' (default), 'slate', or 'paper' (see the :root[data-theme]
// blocks in <style> above). Does not touch the separate note-color system
// (PAL/icolor) used by the abacus/fretboard/piano/chord-matrix.
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

//const PAL = [
//  "#FFFFFF","#BE0032","#377EB8","#BF5B17","#FF7F00","#4DAF4A",
//  "#DC050C","#a0a0a0","#AC8763","#F781BF","#F0E442","#AB4EF3"
//]; // Sentiment12, with interval 7 (perfect 5th) → gray and interval 10 (♭7) → yellow

const PAL = [
  "#FFFFFF","#F51D2C","#377EB8","#BF5B17","#FF7F00","#4DAF4A",
  "#8A0303","#a0a0a0","#006906","#F781BF","#E9C81C","#AB4EF3"
]; // R=white, ♭2=scarlet, 2=blue, ♭3=brown, 3=orange, 4=green,
   // ♭5=blood, 5=gray, ♭6=rose, 6=pink, ♭7=gold, 7=purple

function functionOf(interval) { return ((interval % 12) + 12) % 12; }
function colorOf(fn) { return PAL[fn]; }
const icolor = s => colorOf(functionOf(s));

// Functions whose background reads as "bright"
// get black label text instead of white for contrast.
const BLACK_TEXT_FUNCTIONS = new Set([0, 4, 5, 7, 9, 10]);
const textColorFor = interval => BLACK_TEXT_FUNCTIONS.has(functionOf(interval)) ? '#000000' : 'rgba(255,255,255,0.9)';

// Fixed generic labels — used ONLY for axis-style references that aren't
// tied to one specific scale: the abacus's position ticks and the reference
// table's column header. Color follows raw pitch (semitone) everywhere, but
// TEXT labels for an actual scale's notes are computed per-scale instead
// (see degreeLabelAt below) — the same tritone reads "♯4" in Lydian but
// "♭5" in Locrian, because which degree slot it fills depends on context,
// not on the semitone alone.
const TABLE_LABELS = ['R','♭2','2','♭3','3','4','♯4','5','♭6','6','♭7','7'];

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
// of drifting into ♯2/♯3 the way a strict one-note-per-degree model would
// (that was the bug in the first version of this — see Increment 3 spec §4).
//
// Degree 1 is forced onto the root (note 0) at zero cost, guaranteeing the
// root never carries an accidental. Among equal-cost alignments, prefer
// fewer repeats (i.e. don't reuse a degree if a fresh one is available at
// the same cost — this is what keeps octatonic's ♯4-then-5 distinct instead
// of collapsing onto degree 5 twice), then fewer sharps. Both tie-breaks are
// heuristics per the spec, not a proven rule.
//
// Exception: when the scale has exactly 7 notes (matching the 7 reference
// degrees 1-to-1), repeats are disallowed outright rather than merely
// discouraged. With 7 notes and 7 degrees, a repeat necessarily means some
// OTHER degree got skipped instead — e.g. double harmonic major's "Locrian
// 𝄫3 𝄫7" mode has adjacent semitone neighbors at both the 2nd/3rd and
// 6th/7th degrees, and minimizing raw semitone cost alone finds it cheaper
// to call the higher neighbor a second "2" or "6" (repeat, ♮) than a proper
// 𝄫3/𝄫7 (skip, cost 2) — technically lower-cost, but it reuses one letter
// name twice while never using another at all, which standard notation for
// a 7-note scale never does. Forcing a bijection here also fixes the
// absolute (sharp/flat) spelling for the same note, since that's derived
// from this same accidental sign.
function assignDegreeIndices(set) {
  const n = set.length;
  const R = MAJOR_REF.length;
  const bijection = n === R;

  // dp[i][j] = best (cost, repeats, sharps) for note i landing on degree j,
  // given some non-decreasing (or, if `bijection`, strictly increasing)
  // choice of degrees for notes 0..i-1.
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

// 'relative' (1, ♭3, 4, ...) or 'absolute' (actual note names, C, E♭, F, ...)
// — toggled from the Root section, applies everywhere a degree label is
// shown (abacus beads, formula, reference table cells) since they all
// route through formulaOf/beadLabelAt below.
let labelMode = localStorage.getItem('n4a-label-mode') || 'relative';

// 'beginner' (curated 5-scale reference table, no mode-stepper, absolute
// labels by default) or 'advanced' (today's full catalog) — a permanent,
// visible toggle rather than a dev-only switch, since intermediate users
// may want to flip between the two depending on mood.
let viewMode = localStorage.getItem('n4a-view-mode') || 'advanced';

// 'free' or 'paid' — set via ?tier=free|paid in the URL, then persisted so
// it sticks across visits without needing the param every time. No visible
// in-app switcher (there's no real payment gate yet, just the feature
// difference) — defaults to 'paid' so today's behavior is unchanged for
// anyone who never passes the param.
const urlTier = new URLSearchParams(location.search).get('tier');
if (urlTier === 'free' || urlTier === 'paid') localStorage.setItem('n4a-tier', urlTier);
let tier = localStorage.getItem('n4a-tier') || 'paid';

function formulaOf(set) {
  if (labelMode === 'absolute') return set.map((s, i) => absoluteNoteName(s, set, i)).join(' ');
  const assign = assignDegreeIndices(set);
  return set.map((s, i) => i === 0 ? '1' : degreeLabelAt(assign[i], s)).join(' ');
}
// Same idea, but root spelled "R" (relative mode) — used for bead/cell
// labels (abacus, reference table rows). `set` is the full scale this note
// belongs to (needed to resolve which reference slot each rank maps to);
// defaults to the live scaleOffsets.
function beadLabelAt(idx, semitone, set) {
  const s = set || scaleOffsets;
  if (labelMode === 'absolute') return absoluteNoteName(semitone, s, idx);
  if (idx === 0) return 'R';
  const assign = assignDegreeIndices(s);
  return degreeLabelAt(assign[idx], semitone);
}
function bitmaskOf(set) { return set.reduce((m, s) => m | (1 << s), 0); }

// ── scale dictionary ────────────────────────────────────────────────────────────

const FAMILY_LABEL = {
  major:         'Major (diatonic)',
  melodicMinor:  'Melodic minor',
  harmonicMinor: 'Harmonic minor',
  harmonicMajor: 'Harmonic major',
  doubleHarmonic: 'Double harmonic major',
};

const FAMILIES = {
  major:         { base: [0,2,4,5,7,9,11], modes: ['Ionian','Dorian','Phrygian','Lydian','Mixolydian','Aeolian','Locrian'] },
  melodicMinor:  { base: [0,2,3,5,7,9,11], modes: ['Melodic minor','Dorian ♭2','Lydian augmented','Lydian dominant','Mixolydian ♭6','Locrian ♮2','Altered scale'] },
  harmonicMinor: { base: [0,2,3,5,7,8,11], modes: ['Harmonic minor','Locrian ♮6','Ionian ♯5','Dorian ♯4','Phrygian dominant','Lydian ♯2','Ultralocrian'] },
  harmonicMajor: { base: [0,2,4,5,7,8,11], modes: ['Harmonic major','Dorian ♭5','Phrygian ♭4','Lydian ♭3','Mixolydian ♭2','Lydian augmented ♯2','Locrian 𝄫7'] },
};

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
const DICT_ENTRIES = []; // insertion-ordered list, for fallback search

// `kind` (Increment 3 §2) determines which rules an entry follows:
//  - 'stepwise'  (default): ordinary necklace.
//  - 'symmetric': invariant under transposition by some k<12 — affects
//    chord-matrix suppression and rotation naming (not spelling: the
//    general alignment algorithm spells these correctly on its own).
//  - 'composite': a parent scale + added chromatic tone(s), e.g. flamenco
//    fusion (Phrygian + ♮3) or the bebop scales — `parentName` is kept
//    around for the reference table's "parent + added tone" description.
//    Spelling/bead rendering treats every note the same regardless of
//    kind: all formulas/labels come from the same assignDegreeIndices() run
//    over the full set, so the abacus always matches the reference table.
function addDictEntry(name, family, set, tier, opts) {
  opts = opts || {};
  const kind = opts.kind || 'stepwise';
  const entry = { name, family, set, tier, kind };
  if (opts.parentName) entry.parentName = opts.parentName;
  if (opts.addedTones) entry.addedTones = opts.addedTones;
  if (opts.addedRole) entry.addedRole = opts.addedRole;
  SCALE_DICT[bitmaskOf(set)] = entry;
  DICT_ENTRIES.push(entry);
  return entry;
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

// 6 notes. Whole-tone and augmented are `symmetric` (affects chord-matrix
// suppression and rotation naming, not spelling — see below); blues is
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
// plain set. `addedRole` tells chord-stacking (§5 below) how the added
// tone(s) may participate in a chord:
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

function dictEntryByName(name) { return DICT_ENTRIES.find(e => e.name === name); }

// Beginner view's curated reference table — the 5 scales most people reach
// for, deliberately labeled without any "mode" terminology (Major/Minor
// rather than Ionian/Aeolian) even though they're drawn from the same
// catalog entries as the advanced view.
const BEGINNER_SCALES = [
  { label: 'Major',            set: FAMILIES.major.base },                    // Ionian
  { label: 'Minor',             set: rotateToDegree(FAMILIES.major.base, 5) }, // Aeolian
  { label: 'Major pentatonic',  set: PENTATONIC.base },                        // Gong
  { label: 'Minor pentatonic',  set: rotateToDegree(PENTATONIC.base, 4) },     // Yu
  { label: 'Blues',             set: dictEntryByName('Blues').set },
];

// ── §3 interactive scale naming ──────────────────────────────────────────────

function semitoneDist(a, b) { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); }
function alterationSign(e, m) { return (((e - m) % 12 + 12) % 12) === 1 ? '♯' : '♭'; }

// Find a perfect matching between `extra` (notes only in current scale) and
// `missing` (notes only in the candidate parent), where every pair is exactly
// one semitone apart. Supports 1 or 2 alterations. Degree numbers are the
// parent's own rank for that note (e.g. "major ♭5" means degree 5 of major,
// regardless of what raw semitone that happens to be).
function matchAlterations(extra, missing, parentSet) {
  const degreeOf = m => parentSet.indexOf(m) + 1;
  if (extra.length === 0 || extra.length !== missing.length || extra.length > 2) return null;
  if (extra.length === 1) {
    if (semitoneDist(extra[0], missing[0]) !== 1) return null;
    return [{ degree: degreeOf(missing[0]), symbol: alterationSign(extra[0], missing[0]) }];
  }
  const [e1, e2] = extra, [m1, m2] = missing;
  if (semitoneDist(e1, m1) === 1 && semitoneDist(e2, m2) === 1) {
    return [{ degree: degreeOf(m1), symbol: alterationSign(e1, m1) },
            { degree: degreeOf(m2), symbol: alterationSign(e2, m2) }];
  }
  if (semitoneDist(e1, m2) === 1 && semitoneDist(e2, m1) === 1) {
    return [{ degree: degreeOf(m2), symbol: alterationSign(e1, m2) },
            { degree: degreeOf(m1), symbol: alterationSign(e2, m1) }];
  }
  return null;
}

function nameScale(positions) {
  const rooted = intervalSet(positions);
  // Always computed fresh (never cached on the catalog entry) so it stays
  // correct as rootPitchClass/labelMode change — see formulaOf.
  const formula = formulaOf(rooted);

  // Exact catalog hit — pass `kind`/`entry` through so bead rendering can
  // apply the right treatment (hollow "added" bead for composite scales,
  // see renderAbacus).
  const exact = SCALE_DICT[bitmaskOf(rooted)];
  if (exact) return { exact: true, name: exact.name, formula, kind: exact.kind, entry: exact };

  const card = rooted.length;
  let best = null;
  for (const e of DICT_ENTRIES) {
    if (e.set.length !== card) continue;
    const extra   = rooted.filter(x => !e.set.includes(x));
    const missing = e.set.filter(x => !rooted.includes(x));
    const alterations = matchAlterations(extra, missing, e.set);
    if (!alterations) continue;
    if (!best || alterations.length < best.alterations.length) {
      best = { entry: e, alterations };
      if (alterations.length === 1) break; // can't do better than one alteration
    }
  }
  if (best) {
    const labels = best.alterations.slice().sort((a, b) => a.degree - b.degree)
      .map(a => `${a.symbol}${a.degree}`).join(' ');
    return { exact: false, name: `${best.entry.name} ${labels}`, formula, parent: best.entry.name, kind: 'stepwise' };
  }
  return { exact: false, name: 'no common name', formula, kind: 'stepwise' };
}

// ── §5 diatonic chords (pure functions, no DOM) ──────────────────────────────
//
// Stacked-thirds harmonization of the current scale: for each degree, take
// every other scale note (triad) or every other-other (7th chord). Tones are
// folded to pitch class (relative to the scale root, same convention as
// scaleOffsets/icolor) so a chord row lines up directly under the abacus.

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
  '0,2,7':    { symbol: 'sus2',  name: 'suspended 2nd' },
  '0,5,7':    { symbol: 'sus4',  name: 'suspended 4th' },
};

function chordQuality(intervals) {
  const key = Array.from(new Set(intervals.map(x => ((x % 12) + 12) % 12))).sort((a, b) => a - b).join(',');
  return CHORD_QUALITY[key] || { symbol: null, name: 'no common symbol', fallback: true };
}

// Increment 3 §6, non-7 chord stacking: at each step, walk the scale and
// take whichever member sits closest to a "plausible third" (2-5 semitones,
// a window wide enough to admit the 4ths that pentatonic thirds usually
// turn out to be — see Jens Larsen's "diatonic chords in the pentatonic
// scale": skipping one note at a time is still the right move there, it
// just doesn't land on literal 3rds, and that's fine/expected, not an error
// to correct). This subsumes ordinary scale-step skipping — for any regular
// stepwise scale (major, harmonic minor, ...) the closest-in-window member
// at each step already *is* the note two scale-steps up, so this produces
// the same triads/7ths as before, just without a separate index-skip path.
//
// `addedInfo` (composite scales only — see addCompositeEntry) is
// `{ tones: Set<pitchClass>, role: 'alteration' | 'passing' }`:
//  - 'alteration': the added tone may win a same-score tie against a parent
//    tone. This is what turns Flamenco fusion's tonic chord into 1 3 5
//    (major, using the added ♮3) instead of 1 ♭3 5 (Phrygian's own ♭3) — the
//    two are equally close to a third above the root, and the added tone is
//    the whole point of the scale.
//  - 'passing' (the bebop scales): the added tone is excluded from
//    candidacy whenever a parent tone is also available, since it's a
//    connector between two existing chord tones, not a substitute for
//    either — without this exclusion, Bebop major's plain 5th (a parent
//    tone) and its passing ♯5/♭6 (interval 3 vs 4 above the 3rd, equally
//    close to a third) tie, and scan order alone would pick a winner.
function pickStackTone(set, prev, addedInfo) {
  const excludeRole = addedInfo && addedInfo.role === 'passing' ? addedInfo.tones : null;

  function gather(exclude) {
    const out = [];
    for (const pc of set) {
      if (exclude && exclude.has(((pc % 12) + 12) % 12)) continue;
      let cand = pc;
      while (cand <= prev) cand += 12;
      const interval = cand - prev;
      if (interval >= 2 && interval <= 5) out.push({ cand, interval, score: Math.abs(interval - 3.5) });
    }
    return out;
  }

  let cands = gather(excludeRole);
  if (cands.length === 0 && excludeRole) cands = gather(null); // passing tone was the only option

  // Degenerate gap (no scale member within a plausible third above prev,
  // e.g. a manually-dragged scale with a >5-semitone hole) — widen the
  // search to the whole scale and flag the result as approximate.
  let approximate = false;
  if (cands.length === 0) {
    approximate = true;
    for (const pc of set) {
      let cand = pc;
      while (cand <= prev) cand += 12;
      cands.push({ cand, interval: cand - prev, score: Math.abs(cand - prev - 3.5) });
    }
  }

  let best = cands[0];
  for (const c of cands.slice(1)) {
    const better = c.score < best.score - 1e-9;
    const tied   = Math.abs(c.score - best.score) < 1e-9;
    let preferC = false;
    if (tied && addedInfo && addedInfo.role === 'alteration') {
      preferC = addedInfo.tones.has(((c.cand % 12) + 12) % 12) && !addedInfo.tones.has(((best.cand % 12) + 12) % 12);
    }
    if (tied && !preferC) preferC = c.interval < best.interval; // deterministic default: smaller interval
    if (better || (tied && preferC)) best = c;
  }
  return { tone: best.cand, approximate };
}

// Triad construction for scales that AREN'T 7 notes (5/6/8-note, composite):
// with no fixed 7-degree reference to skip alternate positions on (see
// chordsInScale below), pick the 3rd and 5th independently by what's
// actually in the scale, in priority order, rather than chaining a
// nearest-interval search that can land on either of two equally-close
// candidates depending on scan order alone (that inconsistency is what
// made e.g. Blues' tonic read "1 ♭3 ♭5" instead of "1 ♭3 5" — a plain 5th
// WAS available, the old chain just didn't reliably prefer it).
//
// 3rd slot: 3 > ♭3 > sus4 > sus2 (first available wins; sus2/sus4 only
// offered when a real 5th backs them up — a suspended chord with no 5th at
// all isn't really "suspending" anything).
// 5th slot: a real 5th if present; otherwise an altered 5th that actually
// resolves to a *named* triad given the 3rd already chosen (♯5 with a major
// 3rd -> augmented; ♭5 with a minor 3rd -> diminished — the other pairing
// isn't a recognized triad shape); otherwise borrow a 6th/♭7/7th and drop
// the notion of a 5th entirely (flagged `approximate`, since it's a stand-in
// rather than a textbook triad); last resort, whichever altered 5th is left.
function buildTriad(set, root) {
  const hasInterval = iv => set.some(pc => (((pc - root) % 12) + 12) % 12 === iv);

  let third;
  if (hasInterval(4)) third = 4;
  else if (hasInterval(3)) third = 3;
  else if (hasInterval(7) && hasInterval(5)) return { tones: [root, root + 5, root + 7], approximate: false }; // sus4
  else if (hasInterval(7) && hasInterval(2)) return { tones: [root, root + 2, root + 7], approximate: false }; // sus2
  else return { tones: null, approximate: false };

  if (hasInterval(7)) return { tones: [root, root + third, root + 7], approximate: false };
  const matchingAltered5 = third === 4 ? 8 : 6;
  if (hasInterval(matchingAltered5)) return { tones: [root, root + third, root + matchingAltered5], approximate: false };
  if (hasInterval(9))  return { tones: [root, root + third, root + 9],  approximate: true }; // borrow 6, omit the 5th
  if (hasInterval(10)) return { tones: [root, root + third, root + 10], approximate: true }; // borrow ♭7
  if (hasInterval(11)) return { tones: [root, root + third, root + 11], approximate: true }; // borrow 7
  const otherAltered5 = third === 4 ? 6 : 8;
  if (hasInterval(otherAltered5)) return { tones: [root, root + third, root + otherAltered5], approximate: true };
  return { tones: null, approximate: false };
}

// 4-note extension of buildTriad, for the same non-7-note scales — always
// the triad plus one more note, never an independent recomputation (that
// independence is what used to produce nonsense like "1 ♭3 𝄫5 ♭♭♭7": falling
// back to the generic nearest-interval chain instead of extending the
// already-correct triad).
//
// Clean triad (a real or matching-altered 5th): extend with a 7th, ♭7 > 7 > 6.
//
// Triad that already had to borrow a 6th/♭7/7th for its "5th slot" already
// reads as "1 (♭)3 (♭)7" with no true 5th — so whatever's added on top of
// THAT is an upper extension (9th/11th/13th), not a plain 2nd/4th/6th, and
// per standard chord-extension convention it's named/listed *after* the 7th
// regardless of which octave it actually sounds in (e.g. "m7(11)" always
// lists the 11 after the 7 even though the 11 often sounds *below* the 7 in
// an actual voicing) — hence appending rather than sorting into pitch order.
// Priority: 11th > 9th > 13th, then whichever other borrow-candidate the
// triad didn't already use. This is what turns A minor pentatonic's "5"
// chord from 1 ♭3 ♭7 into 1 ♭3 ♭7 11.
function buildSeventhChord(set, root) {
  const triad = buildTriad(set, root);
  if (!triad.tones) return null;
  const hasInterval = iv => set.some(pc => (((pc - root) % 12) + 12) % 12 === iv);
  const used = new Set(triad.tones.map(t => ((t - root) % 12 + 12) % 12));

  if (!triad.approximate) {
    for (const iv of [10, 11, 9]) {
      if (hasInterval(iv) && !used.has(iv)) {
        return { tones: [...triad.tones, root + iv], approximate: false, extended: false };
      }
    }
    return null;
  }

  for (const iv of [5, 2, 9, 10, 11]) {
    if (hasInterval(iv) && !used.has(iv)) {
      return { tones: [...triad.tones, root + iv], approximate: true, extended: true };
    }
  }
  return null;
}

// set: sorted semitone offsets from scale root (length n — any n >= 3, not
// just 7; see Increment 3 §6). `addedInfo` — see pickStackTone above.
function chordsInScale(set, sevenths, addedInfo) {
  const n = set.length;
  const toneCount = sevenths ? 4 : 3;
  // With exactly 7 notes, assignDegreeIndices (see above) guarantees a
  // perfect 1-to-1 mapping onto the 7 reference degrees — so skipping
  // alternate scale POSITIONS is mathematically the same as skipping
  // alternate reference degrees, i.e. the textbook stacked-thirds
  // definition, with no searching or tie-breaking needed at all. This is
  // NOT safe for other note counts (that's the whole reason buildTriad and
  // pickStackTone exist), but for n=7 it's strictly more reliable than
  // either: verified against every mode in the catalog, including the
  // harmonic minor/major families, where both of those can pick the wrong
  // one of two simultaneously-available 3rds (e.g. harmonic minor's vii°
  // has both a ♭3 and a 3 available a semitone apart — only degree-position
  // skipping reliably lands on the traditional diminished triad).
  const byPosition = n === MAJOR_REF.length;

  return Array.from({ length: n }, (_, i) => {
    let tones = null, approximate = false, extended = false;
    if (byPosition) {
      const steps = sevenths ? [0, 2, 4, 6] : [0, 2, 4];
      tones = steps.map(s => { const idx = i + s; return set[idx % n] + 12 * Math.floor(idx / n); });
    } else {
      const built = sevenths ? buildSeventhChord(set, set[i]) : buildTriad(set, set[i]);
      if (built) { tones = built.tones; approximate = built.approximate; extended = built.extended || false; }
    }
    if (!tones) {
      tones = [set[i]];
      for (let k = 1; k < toneCount; k++) {
        const picked = pickStackTone(set, tones[k - 1], addedInfo);
        tones.push(picked.tone);
        approximate = approximate || picked.approximate;
      }
    }
    const intervals = tones.map(t => t - tones[0]);          // from chord root, ascending
    const tonesPc   = tones.map(t => ((t % 12) + 12) % 12);  // pitch classes, for the abacus-aligned row
    return { degreeIndex: i, rootPc: set[i], tonesPc, intervals, quality: chordQuality(intervals), approximate, extended };
  });
}

// `addedInfo` for pickStackTone/chordsInScale above, resolved via the
// current exact catalog match — so a manually-dragged scale that happens to
// coincide with a composite entry still gets the treatment, same as any
// other lookup.
function compositeAddedInfoFor(set) {
  const info = nameScale(set);
  if (info.exact && info.kind === 'composite') {
    return { tones: new Set(info.entry.addedTones), role: info.entry.addedRole };
  }
  return null;
}

// Chord-tone degree label (1/3/5/7 + accidental), independent of degreeLabelAt
// above (which spells scale degrees against the major-scale reference) — here
// the reference is the major/dominant chord tones themselves, e.g. V7's ♭7.
const CHORD_TONE_REF = [0, 4, 7, 11];
const CHORD_TONE_NUM = [1, 3, 5, 7];
// Position 1 ("the 3rd slot") can be a sus2/sus4 stand-in (buildTriad) rather
// than an actual 3rd — direct lookup rather than accidental() math, since
// that math assumes every chord has a 3rd and would otherwise spell a sus4
// as "♯3" (only correct by coincidence when the *whole* chord still matches
// the registered sus4 quality, which stops being true once buildSeventhChord
// extends it to a 4-note "no common name" shape — this covers that case
// too, since it doesn't depend on the overall chord's quality at all).
const THIRD_SLOT_LABELS = { 2: '2', 3: '♭3', 4: '3', 5: '4' };
// Position 2 ("the 5th slot") can land on a borrowed 6th/♭7/7th instead of
// an actual 5th — buildTriad does this when there's no real or altered 5th
// available (see below) — or, when buildSeventhChord then adds an 11th/4th
// below that borrowed tone, on a plain 4th instead. Those are far enough
// from CHORD_TONE_REF[2]=7 that the generic accidental() math produces
// nonsense (e.g. ♭7 at interval 10 is "3 sharps" away from a plain 5, i.e.
// "♯♯♯5") — direct lookup instead, for every interval buildTriad/
// buildSeventhChord can actually produce at this position.
const FIFTH_SLOT_LABELS = { 5: '4', 6: '♭5', 7: '5', 8: '♯5', 9: '6', 10: '♭7', 11: '7' };
function chordToneLabelAt(pos, intervalFromChordRoot) {
  if (pos === 0) return '1';
  if (pos === 1 && THIRD_SLOT_LABELS[intervalFromChordRoot] !== undefined) return THIRD_SLOT_LABELS[intervalFromChordRoot];
  if (pos === 2 && FIFTH_SLOT_LABELS[intervalFromChordRoot] !== undefined) return FIFTH_SLOT_LABELS[intervalFromChordRoot];
  let diff = intervalFromChordRoot - CHORD_TONE_REF[pos];
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  return accidental(diff) + CHORD_TONE_NUM[pos];
}

// Position 3's label when it's an upper extension (buildSeventhChord's
// `extended` flag — see there) rather than a plain 7th: named by standard
// jazz-extension numbering (9th/11th/13th) instead of degree-2/4/6 style,
// since that's what it actually is once the chord has no true 5th to begin
// with. 10/11 are listed too as a fallback for the rare case where no
// 9th/11th/13th was available and buildSeventhChord reused a ♭7/7 instead.
const EXTENSION_LABELS = { 2: '9', 5: '11', 9: '13', 10: '♭7', 11: '7' };

// Chord-tone label following both the relative/absolute toggle and, in
// relative mode, the scale-root/chord-root color toggle: chord-root mode
// keeps the classic chord-facing 1/3/5/7 numbering (chordToneLabelAt above);
// scale-root mode — and absolute mode, via beadLabelAt itself — shows the
// same spelling the abacus/reference table already use for that note.
function chordToneDisplayLabel(chord, pos, tonePc) {
  if (labelMode === 'relative' && chordColorMode === 'chord') {
    const relFromChordRoot = ((chord.intervals[pos] % 12) + 12) % 12;
    if (pos === 3 && chord.extended && EXTENSION_LABELS[relFromChordRoot] !== undefined) {
      return EXTENSION_LABELS[relFromChordRoot];
    }
    // A 4th-tone interval of 9 reads as a plain added 6th (C6/Cm6 — always
    // spelled "6", never 𝄫7) whenever there's also a real 5th right below
    // it; without one, it's genuinely completing a fully-diminished 7th
    // chord (0,3,6,9), which IS conventionally spelled with a 𝄫7.
    if (pos === 3 && relFromChordRoot === 9) {
      const fifthInterval = ((chord.intervals[2] % 12) + 12) % 12;
      if (fifthInterval === 7) return '6';
    }
    return chordToneLabelAt(pos, relFromChordRoot);
  }
  const idx = scaleOffsets.indexOf(tonePc);
  return beadLabelAt(idx, tonePc, scaleOffsets);
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Case follows the chord's own 3rd (major third -> uppercase, minor third ->
// lowercase); the quality symbol (already computed) supplies °/ø/+/7 etc.
// Sus chords have no 3rd to judge by — neither major nor minor — so they
// stay uppercase, per the usual "Vsus4" convention.
function romanNumeralFor(chord) {
  const base = ROMAN[chord.degreeIndex] || String(chord.degreeIndex + 1);
  if (chord.quality.symbol === 'sus2' || chord.quality.symbol === 'sus4') return base + chord.quality.symbol;
  const third = chord.intervals.length > 1 ? ((chord.intervals[1] % 12) + 12) % 12 : 4;
  const numeral = third === 4 ? base : base.toLowerCase();
  return numeral + (chord.quality.symbol || '');
}

function chordAbsoluteSymbol(chord) {
  const idx = scaleOffsets.indexOf(chord.rootPc);
  const letter = absoluteNoteName(chord.rootPc, scaleOffsets, idx);
  return letter + (chord.quality.symbol || '');
}

function chordFullName(chord) {
  const roman = romanNumeralFor(chord);
  const abs = chordAbsoluteSymbol(chord);
  const approxNote = chord.approximate ? ' · approx.' : '';
  if (chord.quality.fallback) {
    const formula = chord.tonesPc
      .map((pc, pos) => chordToneDisplayLabel(chord, pos, pc))
      .join(' ');
    return `${roman} — ${abs} (${formula}, no common name)${approxNote}`;
  }
  return `${roman} — ${abs} ${chord.quality.name}${approxNote}`;
}

// ── svg helper ────────────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';
function mk(tag, attrs, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

// ── data model ────────────────────────────────────────────────────────────────

let scaleOffsets = [0, 2, 4, 5, 7, 9, 11]; // major / Ionian, relative to root
let rootPitchClass = 0;                     // 0 = C

const semitone = pc => ((pc - rootPitchClass) % 12 + 12) % 12;

// armband state: the 7 absolute pitch classes of the current collection
// (fixed during a rotation gesture) and which of them is currently the root.
let armPCs = [];
let armRootIdx = 0;

function syncArmband() {
  armPCs = scaleOffsets.map(o => (o + rootPitchClass) % 12).sort((a, b) => a - b);
  armRootIdx = armPCs.indexOf(rootPitchClass);
}

// ── root selector ─────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
// Enharmonic (flat) spellings for the same 12 pitch classes — naturals are
// identical to NOTE_NAMES, so only the black-key entries actually differ.
const FLAT_NAMES = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];

// Absolute note name for a scale member, spelled sharp or flat to match its
// own relative-degree accidental (e.g. A Phrygian's ♭2 is spelled B♭, not
// A♯) rather than always defaulting to NOTE_NAMES' sharps. `idx` is this
// note's position within `set`; the root (idx 0) always keeps its plain
// NOTE_NAMES spelling — degree assignment has nothing to disambiguate there.
function absoluteNoteName(semitone, set, idx) {
  const pc = ((semitone + rootPitchClass) % 12 + 12) % 12;
  if (idx === 0) return NOTE_NAMES[pc];
  const assign = assignDegreeIndices(set);
  const diff = degreeDist(semitone, assign[idx]);
  return diff < 0 ? FLAT_NAMES[pc] : NOTE_NAMES[pc];
}

function renderRoot() {
  const div = document.getElementById('root-selector');
  div.innerHTML = '';
  NOTE_NAMES.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'root-btn' + (i === rootPitchClass ? ' active' : '');
    b.textContent = name;
    b.onclick = () => { rootPitchClass = i; render(); };
    div.appendChild(b);
  });

  const select = document.getElementById('root-select-mobile');
  if (select.options.length !== NOTE_NAMES.length) {
    select.innerHTML = '';
    NOTE_NAMES.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = name;
      select.appendChild(opt);
    });
  }
  select.value = rootPitchClass;
}

function setLabelMode(mode) {
  labelMode = mode;
  localStorage.setItem('n4a-label-mode', mode);
  document.getElementById('label-mode-relative').classList.toggle('active', mode === 'relative');
  document.getElementById('label-mode-absolute').classList.toggle('active', mode === 'absolute');
  renderAbacus();
  renderName();
  renderTable();
  renderChordMatrix();
}

// Beginner view swaps in a curated 5-scale reference table (no "modes"
// vocabulary) and hides the mode-stepper — the abacus itself, diatonic
// chords, and scale-name readout stay fully interactive in both views, so
// beginners can still drag beads into "exotic" shapes.
function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('n4a-view-mode', mode);
  document.getElementById('view-mode-beginner').classList.toggle('active', mode === 'beginner');
  document.getElementById('view-mode-advanced').classList.toggle('active', mode === 'advanced');
  document.getElementById('mode-controls').style.display = mode === 'beginner' ? 'none' : '';
  document.querySelector('.ref-controls').style.display = mode === 'beginner' ? 'none' : '';
  document.getElementById('diatonic-chords-section').style.display = mode === 'beginner' ? 'none' : '';
  document.getElementById('abacus-label').textContent = mode === 'beginner'
    ? 'Scale intervals — drag beads to reshape scale'
    : 'Scale intervals — drag beads to reshape scale, or step through modes';
  if (mode === 'beginner') setLabelMode('absolute'); // also re-renders table/abacus/etc.
  else renderTable();
}

// ── abacus ────────────────────────────────────────────────────────────────────

const AB_L  = 40;    // track left x
const AB_R  = 720;   // track right x
const AB_TY = 42;    // track y centre
const AB_BR = 15;    // bead radius
const AB_STEP = (AB_R - AB_L) / 12;

const atX    = pos => AB_L + pos * AB_STEP;
const aXtoP  = x   => (x - AB_L) / AB_STEP;

let beads = []; // per-bead: { circle, lbl }

function renderAbacus() {
  const svg = document.getElementById('abacus');
  svg.innerHTML = '';
  beads = [];

  // track
  svg.appendChild(mk('line', {
    x1: AB_L, y1: AB_TY, x2: AB_R, y2: AB_TY,
    stroke: '#7d828c', 'stroke-width': 6, 'stroke-linecap': 'round'
  }));

  // tick marks + semitone numbers
  // The in-between ticks (the "empty slots" a bead isn't sitting on) are
  // colored exactly like the surrounding panel's own surface (--bg blended
  // with --panel-bg — the panel reads slightly brighter than the bare page
  // background, so matching plain --bg would leave a visible seam) rather
  // than a visible line — they read as notches cut into the track instead
  // of drawn marks, which reads more clearly at a glance than a thin
  // colored tick did.
  const panelColor = getComputedStyle(document.documentElement).getPropertyValue('--panel-solid').trim();
  for (let i = 0; i <= 12; i++) {
    const x = atX(i);
    if (i === 0) {
      svg.appendChild(mk('line', { x1: x, y1: AB_TY - 9, x2: x, y2: AB_TY + 9, stroke: '#5566aa', 'stroke-width': 2 }));
    } else if (i === 12) {
      // Nudged right of the track's own end and drawn thicker/plain gray
      // (matching the track) instead of the old thin indigo-tinted line.
      const rx = x + 4;
      svg.appendChild(mk('line', { x1: rx, y1: AB_TY - 9, x2: rx, y2: AB_TY + 9, stroke: '#7d828c', 'stroke-width': 3 }));
    } else {
      svg.appendChild(mk('line', { x1: x, y1: AB_TY - 9, x2: x, y2: AB_TY + 9, stroke: panelColor, 'stroke-width': 2 }));
    }
    if (i < 12) {
      // Complements whatever the beads are showing rather than repeating it
      // — relative beads get an absolute-note axis underneath (and vice
      // versa), so the two together always show both readings at once
      // instead of the axis being redundant with the bead in relative mode.
      const axisLabel = labelMode === 'relative' ? NOTE_NAMES[(i + rootPitchClass) % 12] : TABLE_LABELS[i];
      svg.appendChild(mk('text', {
        x, y: AB_TY + 29, 'text-anchor': 'middle', 'font-size': 10, fill: '#ffffff'
      }, axisLabel));
    }
  }

  // beads — composite scales (flamenco fusion etc.) render identically to
  // everything else: no "added tone" bead treatment. A composite scale is a
  // blend of two scales, not a base scale plus one lesser note (the ♮3 in
  // flamenco fusion matters as much as the ♭3 it sits next to — it's not a
  // decoration), so singling it out visually would misrepresent it.
  scaleOffsets.forEach((pos, idx) => {
    const x     = atX(pos);
    const color = icolor(pos);
    const fixed = idx === 0;
    const label = beadLabelAt(idx, pos, scaleOffsets);

    const circle = mk('circle', {
      cx: x, cy: AB_TY, r: AB_BR,
      fill: color, stroke: 'rgba(255,255,255,0.25)', 'stroke-width': 1.5,
      cursor: fixed ? 'pointer' : 'ew-resize',
      style: fixed ? '' : 'touch-action: none;'
    });
    const lbl = mk('text', {
      x, y: AB_TY + 5, 'text-anchor': 'middle',
      'font-size': 10, 'font-weight': 'bold',
      fill: textColorFor(pos), 'pointer-events': 'none'
    }, label);

    svg.appendChild(circle);
    svg.appendChild(lbl);
    beads[idx] = { circle, lbl };

    if (fixed) {
      circle.addEventListener('click', () => playScaleDegree(pos));
    } else {
      circle.addEventListener('pointerdown', e => beadDown(e, idx));
    }
  });
}

// ── abacus drag ───────────────────────────────────────────────────────────────

let drag = null;

function beadDown(e, idx) {
  e.preventDefault();
  const svg  = document.getElementById('abacus');
  const rect = svg.getBoundingClientRect();
  const startPos = scaleOffsets[idx];
  // lastPlayedPos tracks what's already sounded during this drag, so
  // beadMove only plays a note when the bead actually snaps to a *new*
  // semitone, not on every pointermove event.
  drag = { idx, rect, scale: svg.viewBox.baseVal.width / rect.width, startX: e.clientX, moved: false, lastPlayedPos: startPos };
  svg.setPointerCapture(e.pointerId);
  playScaleDegree(startPos); // hear the bead's starting note on press
}

function beadMove(e) {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
  const { idx, rect, scale } = drag;
  const svgX = (e.clientX - rect.left) * scale;

  const minP = idx > 1 ? scaleOffsets[idx - 1] + 1 : 1;
  const maxP = idx < scaleOffsets.length - 1 ? scaleOffsets[idx + 1] - 1 : 11;
  const cx   = Math.max(atX(minP), Math.min(atX(maxP), svgX));
  const pos  = Math.round(aXtoP(cx));

  beads[idx].circle.setAttribute('cx', cx);
  beads[idx].lbl.setAttribute('x', cx);
  beads[idx].circle.setAttribute('fill', icolor(pos));
  beads[idx].lbl.setAttribute('fill', textColorFor(pos));
  beads[idx].lbl.textContent = beadLabelAt(idx, pos);

  // Play every semitone the bead passes through/snaps to along the drag —
  // e.g. dragging 7 down to ♭6 sounds 7, ♭7, 6, ♭6 in turn.
  if (pos !== drag.lastPlayedPos) {
    drag.lastPlayedPos = pos;
    playScaleDegree(pos);
  }
}

function beadUp(e) {
  if (!drag) return;
  const { idx, rect, scale } = drag;

  // The plain-click "hear this bead" case is already covered by beadDown's
  // press-to-preview above — no separate replay needed here.
  const svgX = (e.clientX - rect.left) * scale;
  const minP = idx > 1 ? scaleOffsets[idx - 1] + 1 : 1;
  const maxP = idx < scaleOffsets.length - 1 ? scaleOffsets[idx + 1] - 1 : 11;
  scaleOffsets[idx] = Math.max(minP, Math.min(maxP, Math.round(aXtoP(svgX))));
  drag = null;
  render();
}

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
  el.innerHTML =
    `<span class="name${r.exact ? '' : ' fallback'}">${label}</span>` +
    `<span class="formula">${r.formula}</span>`;
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

function renderModeLabel() {
  document.getElementById('mode-label').textContent = `Mode ${armRootIdx + 1}/${armPCs.length}`;
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

  const moves = beads.map((bead, i) => {
    const oldPos = scaleOffsets[i];
    let newPos = oldPos - delta;
    let wrap = false;
    if (newPos < 0)  { newPos += 12; wrap = true; }
    if (newPos > 11) { newPos -= 12; wrap = true; }
    return { bead, idx: i, newPos, wrap };
  });

  animating = true;
  setModeControlsDisabled(true);
  document.getElementById('mode-label').textContent = `Mode ${newIdx + 1}/${n}`;

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
      bead.lbl.textContent = beadLabelAt(idx, newPos);
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
  guitar: 'guitar', guitar7: 'guitar', guitar8: 'guitar',
  bass: 'bass', bass5: 'bass', bass6: 'bass',
  ukulele: 'ukulele', mandolin: 'mandolin', banjo: 'banjo', piano: 'piano'
};
const INSTRUMENT_LABEL = {
  guitar: 'Guitar', guitar7: 'Guitar (7-string)', guitar8: 'Guitar (8-string)',
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

// Last-used string count per family, so switching Guitar -> Bass -> Guitar
// comes back to whichever guitar variant you had, not always the 6-string.
let guitarStrings = INSTRUMENT_FAMILY[instrument] === 'guitar' ? stringsOf(instrument) : (Number(localStorage.getItem('n4a-guitar-strings')) || 6);
let bassStrings   = INSTRUMENT_FAMILY[instrument] === 'bass'   ? stringsOf(instrument) : (Number(localStorage.getItem('n4a-bass-strings')) || 4);
// Free tier has no 7/8-string guitar.
if (tier === 'free' && guitarStrings !== 6) { guitarStrings = 6; instrument = 'guitar'; }

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
  guitar:   { 'Standard': [0, 0, 0, 0, 0, 0], 'Drop D': [0, 0, 0, 0, 0, -2], 'Drop C': [-2, -2, -2, -2, -2, -4],
              'Open G': [-2, 0, 0, 0, -2, -2], 'Open D': [-2, -2, -1, 0, 0, -2], 'DADGAD': [-2, -2, 0, 0, 0, -2] },
  guitar7:  { 'Standard': [0, 0, 0, 0, 0, 0, 0], 'Drop A': [0, 0, 0, 0, 0, 0, -2] },
  guitar8:  { 'Standard': [0, 0, 0, 0, 0, 0, 0, 0], 'Drop E': [0, 0, 0, 0, 0, 0, 0, -2] },
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

const NUT_X = 110, FRET_COUNT = 15;
const REF_FRET = 12, REF_X = 870; // anchors the scale length (fret 12 sits at x=870, same as the original 12-fret layout) independently of how many frets are drawn, so extending FRET_COUNT adds neck rather than rescaling frets 1-12
let NUT_T = TUNINGS[instrument === 'piano' ? 'guitar' : instrument].nutT;
let NUT_B = TUNINGS[instrument === 'piano' ? 'guitar' : instrument].nutB; // top/bottom y bounds — every string is horizontal within this span
const OPEN_GAP = 42;             // canonical x-gap for the open-string column, before per-string compression
const PIVOT_FRET = 9;            // the one fret that renders perfectly vertical (all strings coincide there)

let orientation = localStorage.getItem('n4a-orientation') || 'left';

// Geometry is always computed in canonical (right-handed) space; `mirror`
// flips only the final x-coordinate so text glyphs are never CSS-flipped.
function mirror(x) { return orientation === 'left' ? (NUT_X + END_X - x) : x; }

// All strings are perfectly horizontal — fixed y per (possibly fractional)
// string index, no fret-dependence.
const STRING_Y = s => NUT_T + s * (NUT_B - NUT_T) / (STRING_COUNT - 1);

// Canonical (string-independent) fret position: real equal-temperament
// spacing — fret 12 sits at the halfway point of scale length, etc.
function fretFrac(f) { return 1 - Math.pow(2, -f / 12); }
const FRET_SCALE = (REF_X - NUT_X) / fretFrac(REF_FRET);
const fbFXbase = f    => NUT_X + fretFrac(f) * FRET_SCALE;
const END_X = fbFXbase(FRET_COUNT); // position of the last drawn fret
const fbMXbase = fret => fret === 0
  ? NUT_X - OPEN_GAP                                     // open strings: left of nut
  : (fbFXbase(fret - 1) + fbFXbase(fret)) / 2;            // centered between fret wires

// Per-string compression, pivoted on PIVOT_FRET instead of the nut: at that
// fret every string's x coincides (a vertical fret wire); moving away from
// it — including back toward the nut — strings diverge, least for the
// nearest/lowest string and most for the farthest/highest one. The nut ends
// up NOT vertical, which is the point. Accepts fractional s for elements
// centered between strings (inlays, fret labels).
const PIVOT_X = fbFXbase(PIVOT_FRET);
const stringDivisor = s => 1 + (STRING_COUNT - 1 - s) * 0.02;
const fbFXs = (s, f)    => PIVOT_X + (fbFXbase(f) - PIVOT_X) / stringDivisor(s);
// Open strings (fret 0) are anchored to this string's own (already-slanted)
// nut position rather than pivot-transformed directly — pivoting the distant
// headstock offset the same way as in-neck frets would push it past the nut
// for the more-compressed high strings once the divisor grows.
const fbMXs = (s, fret) => fret === 0
  ? fbFXs(s, 0) - OPEN_GAP / stringDivisor(s)
  : PIVOT_X + (fbMXbase(fret) - PIVOT_X) / stringDivisor(s);

// Per-string size factor: the nearest/lowest string reads slightly larger,
// the farthest/highest slightly smaller — same perspective cue as the taper,
// just applied to marker radius. Centered on the middle string so it's a
// gentle ±10% spread rather than an overall size shift.
const stringSizeFactor = s => 1 + (s - (STRING_COUNT - 1) / 2) * 0.04;

// Constant radius across all frets (matches what fret 10 rendered at under
// the old per-fret taper) — only the per-string factor varies size now.
const BASE_MARKER_R = 9.6;
function fbR(s) { return BASE_MARKER_R * stringSizeFactor(s); }

const DIM_NOTE_COLOR = '#5c6270'; // uniform neutral for non-chord notes when a chord is selected

function renderFretboard() {
  const svg = document.getElementById('fretboard');
  svg.innerHTML = '';

  const last = STRING_COUNT - 1, mid = last / 2;
  const padT = STRING_Y(0) - 12, padB = STRING_Y(last) + 12;
  const nutTopX = fbFXs(0, 0),             nutBotX = fbFXs(last, 0);
  const openTopX = fbMXs(0, 0),            openBotX = fbMXs(last, 0);
  const farTopX = fbFXs(0, FRET_COUNT),    farBotX = fbFXs(last, FRET_COUNT);

  // neck outline — horizontal top/bottom, slanted nut (left) and far (right) edges
  svg.appendChild(mk('polygon', {
    points: `${mirror(nutTopX)},${padT} ${mirror(farTopX)},${padT} ${mirror(farBotX)},${padB} ${mirror(nutBotX)},${padB}`,
    fill: '#2d1f0e'
  }));

  // open-string headstock area — also slanted, matching the nut
  svg.appendChild(mk('polygon', {
    points: `${mirror(openTopX)},${padT} ${mirror(nutTopX)},${padT} ${mirror(nutBotX)},${padB} ${mirror(openBotX)},${padB}`,
    fill: '#1a1209'
  }));

  // inlay dots — single at 3, 5, 7, 9; double at 12 (centered between strings).
  // Kept subtle (soft, semi-transparent, no outline) so they read as a quiet
  // neck marking rather than competing with the scale-highlight note dots.
  [3, 5, 7, 9].forEach(f => {
    svg.appendChild(mk('circle', {
      cx: mirror(fbMXs(mid, f)), cy: STRING_Y(mid), r: 4.5,
      fill: 'rgba(143, 124, 90, 0.4)'
    }));
  });
  [mid - 1, mid + 1].forEach(si => {
    svg.appendChild(mk('circle', {
      cx: mirror(fbMXs(si, 12)), cy: STRING_Y(si), r: 4.5,
      fill: 'rgba(143, 124, 90, 0.4)'
    }));
  });

  // nut bar — a slanted quad following the nut's own slant
  svg.appendChild(mk('polygon', {
    points: `${mirror(nutTopX - 4)},${padT} ${mirror(nutTopX + 3)},${padT} ${mirror(nutBotX + 3)},${padB} ${mirror(nutBotX - 4)},${padB}`,
    fill: '#d4c890'
  }));

  // per-string tuner — "<E>": click the arrows to retune that string up/down
  // a semitone. Drawn on the headstock (peg) side of the nut, clear of the
  // open-string note dot. The string's own anchor point (cx) is computed in
  // canonical space and mirrored like everything else on the neck, but the
  // "<"/">" arrangement around it is fixed in already-mirrored screen space
  // — unlike fret positions, these are UI controls (down always reads on
  // the left, up always on the right), not a physical layout that should
  // flip with handedness.
  for (let s = 0; s < STRING_COUNT; s++) {
    const y = STRING_Y(s);
    // Clearance from the open-string note dot scales with that dot's own
    // radius (fbR), so thicker/larger markers (bass, near strings) don't
    // crowd the tuner even though the flat part of the gap is the same.
    const vcx = mirror(fbMXs(s, 0) - fbR(s) - 26);

    // Free tier keeps the tuning knobs visible but non-functional — grayed
    // out, "not-allowed" cursor, and a native SVG <title> tooltip explaining
    // why, rather than removing them outright.
    {
      const down = mk('text', {
        x: vcx - 15, y: y + 4, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 'bold',
        fill: 'rgba(255,255,255,0.55)', cursor: tier === 'free' ? 'not-allowed' : 'pointer',
        class: tier === 'free' ? 'locked' : ''
      }, '<');
      if (tier === 'free') down.appendChild(mk('title', {}, PAID_FEATURE_MESSAGE));
      else down.addEventListener('click', () => adjustTuning(s, -1));
      svg.appendChild(down);
    }

    svg.appendChild(mk('text', {
      x: vcx, y: y + 4, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 'bold',
      fill: 'rgba(255,255,255,0.9)', 'pointer-events': 'none'
    }, NOTE_NAMES[effectiveOpenPc(s)]));

    {
      const up = mk('text', {
        x: vcx + 15, y: y + 4, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 'bold',
        fill: 'rgba(255,255,255,0.55)', cursor: tier === 'free' ? 'not-allowed' : 'pointer',
        class: tier === 'free' ? 'locked' : ''
      }, '>');
      if (tier === 'free') up.appendChild(mk('title', {}, PAID_FEATURE_MESSAGE));
      else up.addEventListener('click', () => adjustTuning(s, 1));
      svg.appendChild(up);
    }
  }

  const selectedChord = (selectedChordDegree !== null && scaleOffsets.length >= 3)
    ? chordsInScale(scaleOffsets, chordSevenths, compositeAddedInfoFor(scaleOffsets))[selectedChordDegree]
    : null;

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
      fretNotes.push({ s, f, x: fbMXs(s, f), pc, st, midi, inScale: scaleOffsets.includes(st) });
    }
  }
  const visibleNotes = fretNotes.filter(n => n.inScale);
  // Fret numbers sit under the low string's bubbles specifically (string
  // `last`) — a single, unambiguous reference rather than an average that
  // wanders depending on which strings happen to be in-scale.
  const numberX = f => fbMXs(last, f);

  // fret wires — each connects the nearest and farthest string's x for that
  // fret; only PIVOT_FRET is vertical, the rest slant — + numbers
  for (let n = 1; n <= FRET_COUNT; n++) {
    svg.appendChild(mk('line', {
      x1: mirror(fbFXs(0, n)), y1: STRING_Y(0) - 2,
      x2: mirror(fbFXs(last, n)), y2: STRING_Y(last) + 2,
      stroke: '#5a4a2e', 'stroke-width': 2
    }));
    svg.appendChild(mk('text', {
      x: mirror(numberX(n)), y: NUT_B + 22,
      'text-anchor': 'middle', 'font-size': 11, fill: '#ffffff'
    }, String(n)));
  }

  // fret "0" label under open-string column
  svg.appendChild(mk('text', {
    x: mirror(numberX(0)), y: NUT_B + 22,
    'text-anchor': 'middle', 'font-size': 11, fill: '#ffffff'
  }, '0'));

  // strings (thicker toward the nearest/lowest string) — perfectly
  // horizontal, each ends at its own compressed x. Thickness range comes
  // from the tuning (bass strings are visibly chunkier than guitar's).
  const [thinMin, thinMax] = TUNINGS[instrument].thickness;
  for (let s = 0; s < STRING_COUNT; s++) {
    const y = STRING_Y(s);
    svg.appendChild(mk('line', {
      x1: mirror(fbMXs(s, 0)), y1: y,
      x2: mirror(fbFXs(s, FRET_COUNT)), y2: y,
      stroke: '#8a8a8a', 'stroke-width': (thinMin + s * (thinMax - thinMin) / last).toFixed(2)
    }));
  }

  // note markers — when a chord row is selected, dim non-chord-tone notes to
  // a uniform neutral gray (rather than their own scale color at low opacity,
  // which reads as distractingly "still colorful") and (in chord-root
  // coloring mode) recolor chord tones relative to the chord's own root, so
  // the fretboard agrees with the chord matrix (spec increment 2 §7)
  visibleNotes.forEach(({ s, f, x, pc, st, midi }) => {
    const y = STRING_Y(s);
    const r = fbR(s);
    const inChord = !selectedChord || selectedChord.tonesPc.includes(st);
    const fill = !selectedChord ? icolor(st) : (inChord ? chordToneColor(selectedChord, st) : DIM_NOTE_COLOR);

    const circle = mk('circle', {
      cx: mirror(x), cy: y, r,
      fill, opacity: inChord ? 1 : 0.3,
      stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 1.5, cursor: 'pointer'
    });
    circle.addEventListener('click', () => playPhysicalNote(midi));
    svg.appendChild(circle);
  });

  // Click-to-play on every other fret/string position too (not just the
  // in-scale bubbles) — same idea as the piano's always-clickable keys.
  // Invisible hit target, same size/position a bubble would use.
  fretNotes.filter(n => !n.inScale).forEach(({ s, f, x, midi }) => {
    const hit = mk('circle', {
      cx: mirror(x), cy: STRING_Y(s), r: fbR(s),
      fill: 'transparent', cursor: 'pointer'
    });
    hit.addEventListener('click', () => playPhysicalNote(midi));
    svg.appendChild(hit);
  });
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
    tuningOffset = new Array(STRING_COUNT).fill(0);
  }
  updateInstrumentUI();
  renderInstrumentView();
}

function renderInstrumentView() {
  if (instrument === 'piano') renderPiano(); else renderFretboard();
}

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
    btn.classList.toggle('active', family === f);
    btn.style.display = (tier === 'free' && !FREE_TIER_FAMILIES.includes(f)) ? 'none' : '';
  });

  document.getElementById('guitar-strings-wrap').style.display = family === 'guitar' ? 'flex' : 'none';
  document.getElementById('bass-strings-wrap').style.display = family === 'bass' ? 'flex' : 'none';
  [6, 7, 8].forEach(n => {
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
  document.getElementById('instrument-label').textContent = family === 'piano'
    ? `Piano — ${PIANO_OCTAVES} octaves`
    : `${INSTRUMENT_LABEL[instrument]} — ${currentTuningLabel()} — ${FRET_COUNT} frets`;

  const showTuningPreset = family !== 'piano' && tier !== 'free';
  document.getElementById('tuning-preset').style.display = showTuningPreset ? 'inline-block' : 'none';
  if (showTuningPreset) refreshTuningPresetSelect();

  document.getElementById('synth-settings-btn').style.display = tier === 'free' ? 'none' : '';
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

const PIANO_OCTAVES = 3;
// Leftmost white key is this octave's C (MIDI 48 = C3); real per-key MIDI
// climbs from there so the keyboard spans C3-C6, landing middle C (MIDI 60)
// at the start of the middle octave — same shared MIDI-60 center every
// other instrument/playback path in the app already uses.
const PIANO_BASE_OCTAVE = 3;
const PIANO_WHITE_W = 46, PIANO_H = 170;
const PIANO_BLACK_W = 27, PIANO_BLACK_H = 105;
const PIANO_RECEDE = 0.12; // fraction narrower at the far/back edge vs. the near/front edge
const PIANO_TOTAL_WHITE = PIANO_OCTAVES * 7 + 1;
const PIANO_WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11];   // semitone per white key within an octave
const PIANO_BLACK_AFTER = new Set([0, 1, 3, 4, 5]); // white-key index (within octave) with a black key right after it
const PIANO_CENTER_X = PIANO_TOTAL_WHITE * PIANO_WHITE_W / 2; // convergence point, at the near/front edge's own center

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

function renderPiano() {
  const svg = document.getElementById('piano');
  svg.innerHTML = '';
  const width = PIANO_TOTAL_WHITE * PIANO_WHITE_W;
  const height = PIANO_H + 6;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const selectedChord = (selectedChordDegree !== null && scaleOffsets.length >= 3)
    ? chordsInScale(scaleOffsets, chordSevenths, compositeAddedInfoFor(scaleOffsets))[selectedChordDegree]
    : null;

  function markerStyle(pc) {
    const st = semitone(pc);
    if (!scaleOffsets.includes(st)) return null;
    const inChord = !selectedChord || selectedChord.tonesPc.includes(st);
    return {
      fill: !selectedChord ? icolor(st) : (inChord ? chordToneColor(selectedChord, st) : DIM_NOTE_COLOR),
      opacity: inChord ? 1 : 0.35
    };
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
      points: pianoKeyPoints(x, PIANO_WHITE_W, 0, PIANO_H),
      fill: '#f4f2ee', stroke: '#8a8a8a', 'stroke-width': 1
    });
    poly.style.cursor = 'pointer';
    poly.addEventListener('click', () => playPhysicalNote(midi));
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
    const poly = mk('polygon', {
      points: pianoKeyPoints(x, PIANO_BLACK_W, 0, PIANO_BLACK_H),
      fill: '#1c1c1c', stroke: '#000000', 'stroke-width': 1
    });
    poly.style.cursor = 'pointer';
    poly.addEventListener('click', () => playPhysicalNote(midi));
    svg.appendChild(poly);
  }

  // note-name labels — absolute, fixed reference, same idea as the fretboard's fret numbers
  whiteKeys.forEach(({ pc, x }) => {
    const y = PIANO_H - 8;
    svg.appendChild(mk('text', {
      x: pianoX(x + PIANO_WHITE_W / 2, y), y,
      'text-anchor': 'middle', 'font-size': 9, fill: '#000000', 'pointer-events': 'none'
    }, NOTE_NAMES[pc]));
  });

  // scale/chord markers — a colored dot near the bottom of every in-scale key
  whiteKeys.forEach(({ pc, x }) => {
    const m = markerStyle(pc);
    if (!m) return;
    const y = PIANO_H - 30;
    svg.appendChild(mk('circle', {
      cx: pianoX(x + PIANO_WHITE_W / 2, y), cy: y, r: 9,
      fill: m.fill, opacity: m.opacity, stroke: 'rgba(0,0,0,0.6)', 'stroke-width': 1.5,
      'pointer-events': 'none'
    }));
  });
  blackKeys.forEach(({ pc, x }) => {
    const m = markerStyle(pc);
    if (!m) return;
    const y = PIANO_BLACK_H - 22;
    svg.appendChild(mk('circle', {
      cx: pianoX(x + PIANO_BLACK_W / 2, y), cy: y, r: 7,
      fill: m.fill, opacity: m.opacity, stroke: 'rgba(255,255,255,0.85)', 'stroke-width': 1.5,
      'pointer-events': 'none'
    }));
  });
}

// ── §2 scale reference table ─────────────────────────────────────────────────

let refRowMode = 'families';   // 'families' | 'modes'
let showEmptySlots = false;
let refNoteCount = 7;          // 5 | 6 | 7 | 8 — which catalog rows are on offer (Increment 3 §8)

// Sensible default scale to load when switching the note-count selector —
// picked once per count rather than left at whatever the abacus happened
// to hold before.
const NOTE_COUNT_DEFAULT = {
  5: () => dictEntryByName('Gong (Major pentatonic)').set,
  6: () => dictEntryByName('Whole-tone').set,
  7: () => [0, 2, 4, 5, 7, 9, 11], // major / Ionian
  8: () => dictEntryByName('Octatonic (half-whole)').set,
};

function setRefNoteCount(n) {
  refNoteCount = n;
  document.querySelectorAll('#ref-notecount-wrap button').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.count) === n);
  });
  scaleOffsets = NOTE_COUNT_DEFAULT[n]().slice();
  render();
  renderTable();
}

function renderTable() {
  const wrap = document.getElementById('ref-table-wrap');
  wrap.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'ref-table';

  if (showEmptySlots) {
    const thead = document.createElement('tr');
    thead.appendChild(document.createElement('th'));
    TABLE_LABELS.forEach(lbl => {
      const th = document.createElement('th');
      th.textContent = lbl;
      thead.appendChild(th);
    });
    table.appendChild(thead);
  }

  function addRow(label, set) {
    const tr = document.createElement('tr');
    tr.className = 'ref-row';
    tr.onclick = () => { scaleOffsets = set.slice(); render(); };

    const th = document.createElement('th');
    th.className = 'ref-row-label';

    const playBtn = document.createElement('button');
    playBtn.className = 'ref-play-btn';
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', `Play ${label}`);
    // Preview by ear without loading the scale onto the abacus — stop the
    // click from also bubbling up to the row's own "load this scale" handler.
    playBtn.onclick = e => { e.stopPropagation(); previewScale(set); };
    th.appendChild(playBtn);
    th.appendChild(document.createTextNode(label));
    tr.appendChild(th);

    if (showEmptySlots) {
      for (let s = 0; s < 12; s++) {
        const td = document.createElement('td');
        const rank = set.indexOf(s);
        if (rank !== -1) {
          td.textContent = beadLabelAt(rank, s, set);
          td.style.background = colorOf(functionOf(s));
          td.style.color = textColorFor(s);
          td.className = 'ref-cell filled';
        } else {
          td.className = 'ref-cell empty';
        }
        tr.appendChild(td);
      }
    } else {
      set.forEach((s, rank) => {
        const td = document.createElement('td');
        td.textContent = beadLabelAt(rank, s, set);
        td.style.background = colorOf(functionOf(s));
        td.style.color = textColorFor(s);
        td.className = 'ref-cell filled';
        tr.appendChild(td);
      });
    }
    table.appendChild(tr);
  }

  // Beginner view: skip the whole family/mode/note-count catalog entirely
  // and render exactly the 5 curated rows, regardless of refNoteCount/
  // refRowMode/showEmptySlots (those controls are hidden in this view).
  if (viewMode === 'beginner') {
    BEGINNER_SCALES.forEach(({ label, set }) => addRow(label, set));
    wrap.appendChild(table);
    return;
  }

  function addGroupHeader(label) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = label;
    th.colSpan = showEmptySlots ? 13 : (refNoteCount + 1);
    th.className = 'ref-group-header';
    tr.appendChild(th);
    table.appendChild(tr);
  }

  if (refNoteCount === 7) {
    if (refRowMode === 'families') {
      Object.entries(FAMILIES).forEach(([key, fam]) => addRow(FAMILY_LABEL[key], fam.base));
      Object.entries(EXOTIC).forEach(([key, fam]) => addRow(FAMILY_LABEL[key], fam.base));
      Object.entries(EXTRA_SINGLE).forEach(([name, set]) => addRow(name, set));
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
  } else if (refNoteCount === 5) {
    if (refRowMode === 'families') {
      addRow('Major pentatonic (Gong family)', PENTATONIC.base);
    } else {
      addGroupHeader('Pentatonic (Gong family)');
      PENTATONIC.modes.forEach((name, k) => addRow(name, rotateToDegree(PENTATONIC.base, k)));
    }
  } else if (refNoteCount === 6) {
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
      addGroupHeader('Whole-tone (1 shape — every rotation is the same mode, just transposed)');
      addRow(wholeTone.name, wholeTone.set);
      addGroupHeader('Augmented (2 shapes)');
      addRow(augA.name, augA.set);
      addRow(augB.name, augB.set);
      addGroupHeader('Other hexatonic scales');
      addRow(blues.name, blues.set);
    }
  } else if (refNoteCount === 8) {
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
  }

  wrap.appendChild(table);
}

// ── §6 chord matrix ───────────────────────────────────────────────────────────
//
// One column per scale degree, at that degree's own abacus x (atX(rootPc)) —
// same true chromatic axis as the abacus, so spacing between columns is as
// uneven as the scale itself, not evenly redistributed. Each chord's tones
// stack vertically underneath, condensed (just the 3-4 actual tones, no
// blank chromatic slots), root closest to the abacus, roman numeral below.

let chordSevenths   = localStorage.getItem('n4a-chord-sevenths-2') === 'true'; // default: triad
let chordColorMode  = localStorage.getItem('n4a-chord-color') || 'scale';    // 'scale' | 'chord'
let chordExpanded   = localStorage.getItem('n4a-chord-expanded') === 'true'; // default: collapsed
let selectedChordDegree = null; // 0..6, or null — click a column to select/deselect

const CH_BR = 9;        // chord-tone bead radius
const CH_GAP = 22;      // vertical distance between stacked tone centers
const CH_TOP = 6;       // gap between the abacus track and the first bead
const CH_LABEL_GAP = 22; // gap between the last bead's edge and the roman-numeral baseline (~half a text line-height more than the beads' own spacing, so the labels read as clearly separate from the bead stack)
const CH_LABEL_LINE = 12; // baseline-to-baseline spacing from the roman numeral down to the absolute chord name below it

// tonePc is a pitch class relative to the scale root (same convention as
// scaleOffsets/icolor). In chord-root mode, recolor relative to the chord's
// own root instead, so every chord of a given quality reads as one color.
function chordToneColor(chord, tonePc) {
  const rel = chordColorMode === 'chord' ? ((tonePc - chord.rootPc) % 12 + 12) % 12 : tonePc;
  return icolor(rel);
}
function chordToneTextColor(chord, tonePc) {
  const rel = chordColorMode === 'chord' ? ((tonePc - chord.rootPc) % 12 + 12) % 12 : tonePc;
  return textColorFor(rel);
}

function renderChordMatrix() {
  const svg = document.getElementById('chord-matrix');
  svg.innerHTML = '';
  if (scaleOffsets.length < 3) return; // need at least a triad's worth of notes

  const chords = chordsInScale(scaleOffsets, chordSevenths, compositeAddedInfoFor(scaleOffsets));
  const toneCount = chordSevenths ? 4 : 3;
  const lastCy = CH_TOP + CH_BR + (toneCount - 1) * CH_GAP;
  const h = lastCy + CH_BR + CH_LABEL_GAP + CH_LABEL_LINE;
  svg.setAttribute('viewBox', `0 0 760 ${h}`);
  svg.setAttribute('height', h);

  chords.forEach((chord, i) => {
    const x = atX(chord.rootPc);
    const selected = selectedChordDegree === i;

    const col = mk('g', { class: 'chord-col' });
    col.appendChild(mk('title', {}, chordFullName(chord)));
    col.appendChild(mk('rect', {
      x: x - AB_STEP / 2, y: 0, width: AB_STEP, height: h,
      fill: selected ? 'rgba(255,255,255,0.08)' : 'transparent'
    }));
    col.appendChild(mk('line', {
      x1: x, y1: 0, x2: x, y2: lastCy + CH_BR,
      stroke: '#1d2b4a', 'stroke-width': 1
    }));

    chord.tonesPc.forEach((pc, pos) => {
      const cy = CH_TOP + CH_BR + pos * CH_GAP;
      if (pos === 0) {
        col.appendChild(mk('circle', {
          cx: x, cy, r: CH_BR + 3, fill: 'none',
          stroke: 'rgba(255,255,255,0.7)', 'stroke-width': 1.5,
          'stroke-dasharray': chord.approximate ? '3,2' : 'none'
        }));
      }
      col.appendChild(mk('circle', {
        cx: x, cy, r: CH_BR,
        fill: chordToneColor(chord, pc),
        stroke: 'rgba(255,255,255,0.25)', 'stroke-width': 1
      }));
      col.appendChild(mk('text', {
        x, y: cy + 3, 'text-anchor': 'middle', 'font-size': 8, 'font-weight': 'bold',
        fill: chordToneTextColor(chord, pc), 'pointer-events': 'none'
      }, chordToneDisplayLabel(chord, pos, pc)));
    });

    const romanY = lastCy + CH_BR + CH_LABEL_GAP - 3;
    col.appendChild(mk('text', {
      x, y: romanY, 'text-anchor': 'middle',
      'font-size': 11, 'font-weight': 'bold',
      fill: chord.quality.fallback ? 'rgba(255,255,255,0.5)' : '#ffffff',
      'font-style': chord.quality.fallback ? 'italic' : 'normal'
    }, romanNumeralFor(chord)));

    // Absolute chord name, under the relative (roman numeral) one — same
    // fallback/approximate treatment, just one size down since it's the
    // secondary reading.
    col.appendChild(mk('text', {
      x, y: romanY + CH_LABEL_LINE, 'text-anchor': 'middle',
      'font-size': 9,
      fill: chord.quality.fallback ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.75)',
      'font-style': chord.quality.fallback ? 'italic' : 'normal'
    }, chordAbsoluteSymbol(chord)));

    col.addEventListener('click', () => {
      const wasSelected = selectedChordDegree === i;
      selectedChordDegree = wasSelected ? null : i;
      if (!wasSelected) playChordArpeggio(chord);
      renderChordMatrix();
      renderInstrumentView();
    });

    svg.appendChild(col);
  });
}

function updateChordExpanded() {
  document.getElementById('chord-matrix-wrap').style.display = chordExpanded ? 'block' : 'none';
  document.getElementById('chord-chevron').innerHTML = chordExpanded ? '&#9660;' : '&#9654;';
}

function setChordSevenths(v) {
  chordSevenths = v;
  localStorage.setItem('n4a-chord-sevenths-2', v);
  updateChordToggleButtons();
  renderChordMatrix();
}

function setChordColorMode(v) {
  chordColorMode = v;
  localStorage.setItem('n4a-chord-color', v);
  updateChordToggleButtons();
  renderChordMatrix();
  renderInstrumentView();
}

function updateChordToggleButtons() {
  document.getElementById('chord-triad-btn').classList.toggle('active', !chordSevenths);
  document.getElementById('chord-seventh-btn').classList.toggle('active', chordSevenths);
  document.getElementById('chord-color-scale-btn').classList.toggle('active', chordColorMode === 'scale');
  document.getElementById('chord-color-chord-btn').classList.toggle('active', chordColorMode === 'chord');
}

// ── §7 audio (Tone.js) ────────────────────────────────────────────────────────
//
// Per the "what's worth playing" call: a held root drone (the audible twin of
// the armband — hear the modal color change as the tonic rotates),
// click-a-bead-to-hear-it, click-a-chord-to-hear-its-arpeggio, and sequential
// playback of the scale and the diatonic-chord progression, left to right.
//
// Notes/chords use Tone's official Salamander grand-piano sample set (real
// piano recordings, pitch-shifted per note by Tone.Sampler) rather than a
// synthesized approximation — genuinely "piano," not piano-ish. The drone
// stays a synth (a sampled piano note decays and can't hold indefinitely,
// wrong shape for a drone); it's a "fat" detuned-sine stack for a thicker pad,
// through a shared touch of reverb with the piano for a little shared space.

let audioStarted = false;
function ensureAudio() {
  if (audioStarted) return Promise.resolve();
  // Tone.loaded() waits on every sampler/buffer in the app's shared load
  // queue (piano, guitar, bass, drone samples — all fetched from external
  // GitHub Pages/jsdelivr hosts), not just the instrument currently in use.
  // A transient network/CORS hiccup fetching any single one of them used to
  // reject this promise with nothing to catch it (an unhandled rejection),
  // and since audioStarted never flipped true, every later click just
  // re-awaited that same already-rejected promise forever — audio was
  // silently dead for the rest of the session. Catch it, log it, and leave
  // audioStarted false so the next click retries the load instead of being
  // stuck.
  return Promise.all([Tone.start(), Tone.loaded()])
    .then(() => { audioStarted = true; })
    .catch(err => { console.error('Audio failed to start/load — will retry on next click.', err); });
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
// from droneConfig above, since these apply to note clicks and scale/chord
// playback rather than the held drone specifically.
let playbackOctave  = Number(localStorage.getItem('n4a-playback-octave'))  || 0;   // whole octaves, relative to the shared MIDI-60 base
let playbackTempo   = Number(localStorage.getItem('n4a-playback-tempo'))   || 1;   // speed multiplier on the fixed note/chord step durations below
let playbackSustain = Number(localStorage.getItem('n4a-playback-sustain')) || 1;   // seconds a clicked note is held before release

function setPlaybackSetting(key, value) {
  if (key === 'octave') playbackOctave = value;
  else if (key === 'tempo') playbackTempo = value;
  else if (key === 'sustain') playbackSustain = value;
  localStorage.setItem('n4a-playback-' + key, value);
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
const DRONE_SAMPLE_SOURCES = {
  harmonium: { url: 'https://samples.10keyz.com/harmonium/C3.mp3', baseMidi: 48, loopStart: 0.8, loopEnd: 11.7, fade: 0.02 },
  organ:     { url: 'https://samples.10keyz.com/organ/C3.mp3',      baseMidi: 48, loopStart: 0.8, loopEnd: 10.0, fade: 0.02 },
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

const dronePlayers = {};
Object.entries(DRONE_SAMPLE_SOURCES).forEach(([key, src]) => {
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
});

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

function activeDronePlayer() { return dronePlayers[droneConfig.instrument] || null; }

const droneVoice = {
  triggerAttack: freq => {
    const player = activeDronePlayer();
    if (player) {
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

// Real sampled grand piano (Tone.js's official Salamander set), pitch-shifted
// per note from the nearest sample — this is what click-a-bead/chord playback uses.
const noteSynth = new Tone.Sampler({
  urls: {
    A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
    A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
    A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
    A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
    A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3',
    A5: 'A5.mp3', C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3',
    A6: 'A6.mp3', C7: 'C7.mp3', 'D#7': 'Ds7.mp3', 'F#7': 'Fs7.mp3',
    A7: 'A7.mp3', C8: 'C8.mp3'
  },
  release: 1,
  baseUrl: 'https://samples.10keyz.com/piano/'
}).connect(reverb);
noteSynth.volume.value = -4;

// Instrument-matched samples (nbrosowsky/tonejs-instruments — CC-licensed,
// same loading pattern as the piano above) for guitar and bass, rather than
// always reaching for piano regardless of which neck is on screen. Ukulele/
// mandolin/banjo don't have their own recordings in that set, so they
// borrow the acoustic guitar sample as the closest available plucked-string
// timbre — still real strings, just not a perfect match for those specific
// instruments.
const guitarSampler = new Tone.Sampler({
  urls: {
    D2: 'D2.mp3', 'D#2': 'Ds2.mp3', E2: 'E2.mp3', F2: 'F2.mp3', 'F#2': 'Fs2.mp3',
    G2: 'G2.mp3', 'G#2': 'Gs2.mp3', A2: 'A2.mp3', 'A#2': 'As2.mp3', B2: 'B2.mp3',
    C3: 'C3.mp3', 'C#3': 'Cs3.mp3', D3: 'D3.mp3', 'D#3': 'Ds3.mp3', E3: 'E3.mp3',
    F3: 'F3.mp3', 'F#3': 'Fs3.mp3', G3: 'G3.mp3', 'G#3': 'Gs3.mp3', A3: 'A3.mp3',
    'A#3': 'As3.mp3', B3: 'B3.mp3', C4: 'C4.mp3', 'C#4': 'Cs4.mp3', D4: 'D4.mp3',
    'D#4': 'Ds4.mp3', E4: 'E4.mp3', F4: 'F4.mp3', 'F#4': 'Fs4.mp3', G4: 'G4.mp3',
    'G#4': 'Gs4.mp3', A4: 'A4.mp3', 'A#4': 'As4.mp3', B4: 'B4.mp3', C5: 'C5.mp3',
    'C#5': 'Cs5.mp3', D5: 'D5.mp3'
  },
  release: 1,
  baseUrl: 'https://samples.10keyz.com/guitar-acoustic/'
}).connect(reverb);
guitarSampler.volume.value = -4;

const bassSampler = new Tone.Sampler({
  urls: {
    'A#1': 'As1.mp3', 'C#1': 'Cs1.mp3', E1: 'E1.mp3', G1: 'G1.mp3',
    'A#2': 'As2.mp3', 'C#2': 'Cs2.mp3', E2: 'E2.mp3', G2: 'G2.mp3',
    'A#3': 'As3.mp3', 'C#3': 'Cs3.mp3', E3: 'E3.mp3', G3: 'G3.mp3',
    'A#4': 'As4.mp3', 'C#4': 'Cs4.mp3', E4: 'E4.mp3', G4: 'G4.mp3',
    'C#5': 'Cs5.mp3'
  },
  release: 1,
  baseUrl: 'https://samples.10keyz.com/bass-electric/'
}).connect(reverb);
bassSampler.volume.value = -4;

// Which sampler click-a-bead/scale/chord playback should use right now.
function currentNoteSampler() {
  const family = INSTRUMENT_FAMILY[instrument];
  if (family === 'bass') return bassSampler;
  if (family === 'piano') return noteSynth;
  return guitarSampler; // guitar, ukulele, mandolin, banjo
}
// Bass sits an octave below the other instruments (a real bass guitar
// sounds an octave down from a regular guitar) — everything else plays at
// the shared MIDI-60-centered register the app has always used.
function samplerOctaveShift() {
  return INSTRUMENT_FAMILY[instrument] === 'bass' ? -12 : 0;
}

// A pitch class of E (4) or above sits noticeably higher than the C-rooted
// case once mapped onto the shared MIDI-60 register (up to 11 semitones
// above middle C for B) — pull those down an octave so no root/note ends up
// that far above where C already sits. Scale offsets/chord intervals are
// then added on top of whatever this returns, so the whole scale/chord
// still ascends normally from the corrected base.
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
      droneVoice.triggerAttack(midiToFreq(droneBaseMidi()));
    } else {
      droneVoice.triggerRelease();
    }
    updateDroneButton();
  });
}

// Called every render() — if the drone is on and the root moved (root select,
// or the armband's tonic-travels rotation), glide the drone to the new tonic
// instead of retriggering, so it reads as "the same held note sliding."
function updateDronePitch() {
  if (!droneOn || rootPitchClass === droneRootPitchClass) return;
  droneRootPitchClass = rootPitchClass;
  droneVoice.rampFrequency(midiToFreq(droneBaseMidi()), 0.15);
}

function updateDroneButton() {
  const b = document.getElementById('drone-toggle');
  b.textContent = 'Root drone: ' + (droneOn ? 'on' : 'off');
  b.classList.toggle('active', droneOn);
}

// midi: a real, already-octave-correct MIDI note (e.g. a fretboard
// string/fret or a specific piano key) — unlike playScaleDegree, this never
// folds/centers the pitch class, so the same physical spot always sounds at
// its true pitch: low E genuinely sounds two octaves below high E, middle C
// genuinely sits between the octave above and below it, etc.
// playbackOctave/samplerOctaveShift still apply on top, same as every other
// note-playing path, so the Setup dialog's octave slider and the
// bass-family octave-down still work as expected.
function playPhysicalNote(midi) {
  ensureAudio().then(() => {
    const shiftedMidi = midi + 12 * playbackOctave + samplerOctaveShift();
    currentNoteSampler().triggerAttackRelease(midiToFreq(shiftedMidi), playbackSustain);
  });
}

// offset: semitones above the root within the current scale (scaleOffsets[idx],
// always ascending 0-11 — NOT folded to a pitch class). Used by the abacus
// bead clicks so a bead's note stays on the same ascending line
// previewScale/playChordArpeggio already use: center the *root* once, then
// add the raw offset on top. Centering each bead's own absolute pitch class
// independently used to fold each bead separately — any bead landing on E
// or above (pc>=4) dropped a whole octave *relative to the beads next to
// it*, which read as a scale that randomly leapt down mid-run instead of
// just the whole scale sitting an octave lower when the root itself is E or
// later.
function playScaleDegree(offset) {
  ensureAudio().then(() => {
    const midi = 60 + offset + centeredPc(rootPitchClass) + 12 * playbackOctave + samplerOctaveShift();
    currentNoteSampler().triggerAttackRelease(midiToFreq(midi), playbackSustain);
  });
}

function playChordArpeggio(chord) {
  ensureAudio().then(() => {
    // No mod-fold here (unlike an isolated pitch-class lookup): chord.rootPc is
    // already ascending 0-11 across degrees, so folding to a single octave was
    // pulling any chord whose rootPc + rootPitchClass crossed 12 back down —
    // i.e. exactly "the last chord(s) play an octave too low" once the tonic
    // (mode) pushed later degrees past the octave boundary.
    const baseMidi = 60 + chord.rootPc + centeredPc(rootPitchClass) + 12 * playbackOctave + samplerOctaveShift();
    const now = Tone.now();
    const sampler = currentNoteSampler();
    const spacing = 0.16 / playbackTempo;
    chord.intervals.forEach((iv, i) => {
      sampler.triggerAttackRelease(midiToFreq(baseMidi + iv), '4n', now + i * spacing);
    });
  });
}

// Ascending run root -> ... -> octave root. Takes any set (not just the
// currently-loaded scaleOffsets) so the reference table's per-row play
// buttons can preview a scale by ear without touching what's loaded on the
// abacus.
function previewScale(set) {
  ensureAudio().then(() => {
    const now = Tone.now();
    const run = [...set, 12];
    const sampler = currentNoteSampler();
    const shift = samplerOctaveShift();
    const step = 0.24 / playbackTempo;
    run.forEach((offset, i) => {
      const midi = 60 + offset + centeredPc(rootPitchClass) + 12 * playbackOctave + shift;
      sampler.triggerAttackRelease(midiToFreq(midi), step * 0.9, now + i * step);
    });
  });
}

function playScale() {
  previewScale(scaleOffsets);
}

// The diatonic-chord progression, one block chord per degree, left to right
// across the chord-matrix columns (I -> ii -> iii -> ... -> vii°).
function playAllChords() {
  ensureAudio().then(() => {
    if (scaleOffsets.length < 3) return;
    const chords = chordsInScale(scaleOffsets, chordSevenths, compositeAddedInfoFor(scaleOffsets));
    const now = Tone.now();
    const step = 0.75 / playbackTempo;
    const sampler = currentNoteSampler();
    const shift = samplerOctaveShift();
    chords.forEach((chord, ci) => {
      // No mod-fold here (unlike an isolated pitch-class lookup): chord.rootPc is
    // already ascending 0-11 across degrees, so folding to a single octave was
    // pulling any chord whose rootPc + rootPitchClass crossed 12 back down —
    // i.e. exactly "the last chord(s) play an octave too low" once the tonic
    // (mode) pushed later degrees past the octave boundary.
    const baseMidi = 60 + chord.rootPc + centeredPc(rootPitchClass) + 12 * playbackOctave + shift;
      const t = now + ci * step;
      chord.intervals.forEach(iv => {
        sampler.triggerAttackRelease(midiToFreq(baseMidi + iv), step * 0.9, t);
      });
    });
  });
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

function refreshSynthDialogControls() {
  refreshPlaybackControls();
  document.getElementById('synth-drone-instrument').value = droneConfig.instrument;
  const isSample = droneConfig.instrument !== 'synth';
  document.getElementById('synth-osc-rows').style.display = isSample ? 'none' : 'block';
  document.getElementById('synth-sample-hint').style.display = isSample ? 'block' : 'none';

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
  if (wasOn) droneVoice.triggerAttack(midiToFreq(droneBaseMidi()));
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

function wireSynthDialog() {
  [['playback-octave', 'octave'], ['playback-tempo', 'tempo'], ['playback-sustain', 'sustain']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('input', e => {
      setPlaybackSetting(key, Number(e.target.value));
      refreshPlaybackControls();
    });
  });

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
  document.getElementById('synth-close-btn').onclick = () => document.getElementById('synth-dialog').close();
  document.getElementById('synth-settings-btn').onclick = () => {
    refreshSynthDialogControls();
    document.getElementById('synth-dialog').showModal();
  };
}

// ── main render ───────────────────────────────────────────────────────────────

function render() {
  syncArmband();
  renderRoot();
  renderAbacus();
  renderName();
  renderModeLabel();
  renderChordMatrix();
  renderInstrumentView();
  updateDronePitch();
  // Absolute labels in the reference table depend on rootPitchClass too —
  // only worth refreshing when that mode is actually active.
  if (labelMode === 'absolute') renderTable();
}

// wire up abacus drag events once
const abacusSvg = document.getElementById('abacus');
abacusSvg.addEventListener('pointermove', beadMove);
abacusSvg.addEventListener('pointerup',   beadUp);

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

// wire up label mode toggle (relative degree labels vs absolute note names)
document.getElementById('label-mode-relative').onclick = () => setLabelMode('relative');
document.getElementById('label-mode-absolute').onclick = () => setLabelMode('absolute');

// wire up view mode toggle (beginner vs advanced)
document.getElementById('view-mode-beginner').onclick = () => setViewMode('beginner');
document.getElementById('view-mode-advanced').onclick = () => setViewMode('advanced');

// wire up instrument toggle (family buttons + string-count sub-toggles)
document.getElementById('instr-guitar').onclick   = () => setInstrumentFamily('guitar');
document.getElementById('instr-bass').onclick     = () => setInstrumentFamily('bass');
document.getElementById('instr-ukulele').onclick  = () => setInstrumentFamily('ukulele');
document.getElementById('instr-mandolin').onclick = () => setInstrumentFamily('mandolin');
document.getElementById('instr-banjo').onclick    = () => setInstrumentFamily('banjo');
document.getElementById('instr-piano').onclick    = () => setInstrumentFamily('piano');
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
document.querySelectorAll('input[name="rowmode"]').forEach(r => {
  r.addEventListener('change', e => { refRowMode = e.target.value; renderTable(); });
});
document.getElementById('show-empty').addEventListener('change', e => {
  showEmptySlots = e.target.checked; renderTable();
});
document.querySelectorAll('#ref-notecount-wrap button').forEach(b => {
  b.onclick = () => setRefNoteCount(Number(b.dataset.count));
});

// wire up mobile root select
document.getElementById('root-select-mobile').addEventListener('change', e => {
  rootPitchClass = Number(e.target.value); render();
});

// wire up chord matrix controls
document.getElementById('chord-header').addEventListener('click', () => {
  chordExpanded = !chordExpanded;
  localStorage.setItem('n4a-chord-expanded', chordExpanded);
  updateChordExpanded();
  // Collapsing hides the selected chord's highlight/dimming without
  // clearing it — deselect so the fretboard/piano go back to normal and
  // re-expanding doesn't come back with a stale selection.
  if (!chordExpanded && selectedChordDegree !== null) {
    selectedChordDegree = null;
    renderChordMatrix();
    renderInstrumentView();
  }
});
document.getElementById('chord-triad-btn').onclick   = () => setChordSevenths(false);
document.getElementById('chord-seventh-btn').onclick = () => setChordSevenths(true);
document.getElementById('chord-color-scale-btn').onclick = () => setChordColorMode('scale');
document.getElementById('chord-color-chord-btn').onclick = () => setChordColorMode('chord');

// color legend — swatches pull straight from PAL so they can never drift
// out of sync with what the abacus/fretboard/piano actually render.
document.querySelectorAll('.legend-swatch').forEach(el => {
  el.style.background = PAL[Number(el.dataset.degree)];
});
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
document.getElementById('play-chords-btn').onclick = () => playAllChords();
wireSynthDialog();


renderHandToggle();
updateInstrumentUI();
document.getElementById('label-mode-relative').classList.toggle('active', labelMode === 'relative');
document.getElementById('label-mode-absolute').classList.toggle('active', labelMode === 'absolute');
setViewMode(viewMode); // syncs beginner/advanced UI + renders the table once

updateChordExpanded();
updateChordToggleButtons();
render();
