// abacus.js — shared draggable scale-abacus component, extracted from
// spicemap's original single-instance implementation. Multi-instance by
// design (each createAbacus() call owns its own state/DOM), since
// fusionmap's planned layout needs two side by side. Depends on theory.js
// being loaded first (PAL/colorOf/textColorFor/beadLabelAt/etc.).
//
// What's NOT here: spicemap's mode-stepping slide/fade animation (the
// prev/next arrows that rotate a fixed 7-note collection) stays in
// spicemap's own app.js for now — it's specifically "rotate this fixed
// collection," which doesn't obviously generalize to "jump to an arbitrary
// preset scale" (fusionmap's case, e.g. a "parallel minor" shortcut can
// change which notes exist, not just their positions). What this module
// DOES expose (`beads`, `atX`/`xToPos`) is exactly what that animation
// needs to keep working externally, so spicemap's existing behavior is
// unaffected by the extraction.

// Uses the shared mk()/SVG_NS from theory.js — load that first.

// svgEl: an <svg> element already sized/viewBox'd by the caller (this
// module draws within whatever box it's given, using `options.left`/
// `options.right`/`options.width` for its own track geometry).
//
// options:
//   scaleOffsets   — initial scale, ascending semitone offsets from root, root included as 0 (default major)
//   rootPitchClass — initial root, 0-11 (default 0 = C)
//   labelMode      — 'relative' | 'absolute' (default 'relative')
//   editable       — draggable beads? (default true; false = display-only, still clickable for playback)
//   left, right, y, beadRadius, width — track geometry in the SVG's own coordinate space (defaults match spicemap's: 40, 720, 42, 15, 760)
//   tickInactiveColor — background-matching color for the empty tick marks (default a neutral dark gray; pass your panel's own solid color for a seamless look)
//   onChange(offsets)   — fired when a drag commits a new scale (bead released at a new position)
//   onBeadPlay(offset)  — fired on bead press, and on each new semitone a drag passes through — hand this to your own audio code; this module has none
function createAbacus(svgEl, options) {
  options = options || {};
  const cfg = {
    left: options.left != null ? options.left : 40,
    right: options.right != null ? options.right : 720,
    y: options.y != null ? options.y : 42,
    beadRadius: options.beadRadius != null ? options.beadRadius : 15,
    width: options.width != null ? options.width : 760,
    hitCap: options.hitCap != null ? options.hitCap : 40,
    editable: options.editable !== false,
    tickInactiveColor: options.tickInactiveColor || '#2a2f3a',
    onChange: typeof options.onChange === 'function' ? options.onChange : null,
    onBeadPlay: typeof options.onBeadPlay === 'function' ? options.onBeadPlay : null,
    // Same signature as the plain shared beadLabelAt (the default) — a host
    // can override it to relabel specific notes for a reason this generic
    // module has no concept of (spicemap's own chord-voicing extensions —
    // "9" instead of "2" for a Major 9th's added tone — are exactly that:
    // meaningful only in spicemap's own CHORD_DICT, not something this
    // shared component should know about).
    labelFn: typeof options.labelFn === 'function' ? options.labelFn : beadLabelAt,
    // Stand the track on end (see setVertical): the whole drawing is rotated
    // a quarter turn and each label counter-rotated about its own anchor, so
    // the bead axis runs down the screen instead of across. Only the
    // rendering and the drag axis change — every coordinate below is still
    // computed in the same horizontal space. Off unless a host asks for it.
    vertical: !!options.vertical,
  };

  let scaleOffsets = (options.scaleOffsets || [0, 2, 4, 5, 7, 9, 11]).slice();
  let rootPitchClass = options.rootPitchClass || 0;
  let labelMode = options.labelMode || 'relative';

  const step = (cfg.right - cfg.left) / 12;
  const atX = pos => cfg.left + pos * step;
  const xToPos = x => (x - cfg.left) / step;

  // Touch target sizing: the visible bead stays small/precise, but on a
  // small screen the SVG is scaled way down from its viewBox, shrinking the
  // bead to a few real pixels — nowhere near tappable. Each bead gets an
  // invisible, larger hit circle sized to half the gap to its nearest
  // neighbor (or the track edge), so adjacent hit areas never overlap.
  function beadHitRadius(idx, pos) {
    const leftGap = idx > 0 ? (pos - scaleOffsets[idx - 1]) * step : pos * step + cfg.left;
    const rightGap = idx < scaleOffsets.length - 1
      ? (scaleOffsets[idx + 1] - pos) * step
      : (12 - pos) * step + (cfg.width - cfg.right);
    return Math.max(cfg.beadRadius, Math.min(cfg.hitCap, Math.min(leftGap, rightGap) / 2));
  }

  let beads = []; // per-bead: { circle, lbl, hit }
  let drag = null;

  // The caller's own (horizontal) viewBox, captured before any rotation so
  // standUpright() can derive the rotated one from it — and restore it —
  // without compounding across redraws.
  const flatViewBox = {
    x: svgEl.viewBox.baseVal.x, y: svgEl.viewBox.baseVal.y,
    width: svgEl.viewBox.baseVal.width, height: svgEl.viewBox.baseVal.height,
  };

  function render() {
    svgEl.innerHTML = '';
    beads = [];
    svgEl.setAttribute('viewBox', `${flatViewBox.x} ${flatViewBox.y} ${flatViewBox.width} ${flatViewBox.height}`);

    svgEl.appendChild(mk('line', {
      x1: cfg.left, y1: cfg.y, x2: cfg.right, y2: cfg.y,
      stroke: '#7d828c', 'stroke-width': 6, 'stroke-linecap': 'round',
    }));

    for (let i = 0; i <= 12; i++) {
      const x = atX(i);
      if (i === 0) {
        svgEl.appendChild(mk('line', { x1: x, y1: cfg.y - 9, x2: x, y2: cfg.y + 9, stroke: '#5566aa', 'stroke-width': 2 }));
      } else if (i === 12) {
        const rx = x + 4;
        svgEl.appendChild(mk('line', { x1: rx, y1: cfg.y - 9, x2: rx, y2: cfg.y + 9, stroke: '#7d828c', 'stroke-width': 3 }));
      } else {
        svgEl.appendChild(mk('line', { x1: x, y1: cfg.y - 9, x2: x, y2: cfg.y + 9, stroke: cfg.tickInactiveColor, 'stroke-width': 2 }));
      }
      if (i < 12) {
        // Complements whatever the beads are showing — relative beads get
        // an absolute-note axis underneath (and vice versa), so both
        // readings are visible at once. This matters beyond convenience
        // now that a host's labelFn can be chord/context-aware (spicemap's
        // own — see chordAwareBeadLabel there — prints "9"/"♭9"/"11"/"13"
        // for a chord's own upper extensions, not just "2"/"4"/"6"): a
        // host that hides its relative/absolute switch entirely and
        // always shows absolute names on the beads themselves (spicemap
        // does, as of this comment) would otherwise make that whole
        // labelFn distinction invisible, since the plain, position-only
        // TABLE_LABELS[i] below has no idea what chord (if any) is loaded.
        // Passing 'relative' here explicitly (not labelMode, which is
        // 'absolute' in that case) is what actually asks for the
        // chord-aware reading INSTEAD OF the raw generic reference table,
        // for whichever positions are real members of the current
        // scale/chord — a position with no such membership (memberIdx -1)
        // falls back to the plain static table, same as always, since
        // there's no note-specific context to compute anything from.
        const memberIdx = scaleOffsets.indexOf(i);
        // labelMode==='relative' branch used to be a flat NOTE_NAMES[...]
        // lookup — always sharp, e.g. printing D♯ under a Phrygian ♭2 that
        // the bead itself (and every other absolute reading in the app,
        // via absoluteNoteName) correctly spells E♭. absoluteNoteName
        // already does exactly the right thing here (spell each note by
        // its OWN relative-degree accidental) — it just wasn't being
        // called from this axis-label branch, only from the OTHER one
        // (labelMode==='absolute', for a member position). Non-member
        // positions (memberIdx -1, not part of the loaded scale/chord at
        // all) have no relative-degree accidental to base a choice on, so
        // those still fall back to the plain sharp spelling, same as
        // TABLE_LABELS[i] already does for the other branch's own
        // non-member case just below.
        const axisLabel = labelMode === 'relative'
          ? (memberIdx !== -1 ? absoluteNoteName(i, scaleOffsets, memberIdx, rootPitchClass) : NOTE_NAMES[mod12(i + rootPitchClass)])
          : (memberIdx !== -1 ? cfg.labelFn(memberIdx, i, scaleOffsets, 'relative', rootPitchClass) : TABLE_LABELS[i]);
        svgEl.appendChild(mk('text', {
          // dominant-baseline: central (not the default alphabetic
          // baseline, nudged down with a +29 y offset as this used to be)
          // makes (x,y) this label's true visual center rather than an
          // arbitrary point a few px above it. That distinction only
          // matters once standUpright() (see below) starts rotating labels
          // about their own (x,y) — rotating around a point that isn't the
          // visual center turns what was an invisible vertical nudge into a
          // very visible horizontal one, reading as "the label sits
          // top-left of where it should."
          // cfg.beadRadius + 9 (not a flat 24) so this stays the same fixed
          // clearance PAST the bead's own edge regardless of how big the
          // bead is — a host that enlarges beadRadius (spicemap's portrait
          // mode, via setBeadRadius) would otherwise have this axis label
          // creep closer and closer to the now-bigger bead, since a flat
          // offset from the shared center point doesn't know the bead grew.
          // 9 reproduces the exact original spacing at the default radius
          // (15 + 9 = 24, today's old hardcoded value), so nothing shifts
          // for any existing consumer using the default size. Standing
          // upright specifically gets a bit more still (12, not 9) — asked
          // for by feel on-device, on top of (not instead of) the
          // radius-aware scaling above. Capped there, not pushed further —
          // the track's fixed viewBox (760×80) only has so much room below
          // center before this label's own text starts clipping against
          // the bottom edge.
          x, y: cfg.y + cfg.beadRadius + (cfg.vertical ? 12 : 9), 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10, fill: '#ffffff',
        }, axisLabel));
      }
    }

    scaleOffsets.forEach((pos, idx) => {
      const x = atX(pos);
      const color = colorOf(pos);
      const fixed = idx === 0;
      const label = cfg.labelFn(idx, pos, scaleOffsets, labelMode, rootPitchClass);

      const circle = mk('circle', {
        cx: x, cy: cfg.y, r: cfg.beadRadius,
        fill: color, stroke: 'rgba(255,255,255,0.25)', 'stroke-width': 1.5,
        'pointer-events': 'none',
      });
      // dominant-baseline: central, not a manual +5 baseline nudge, so
      // (x, cfg.y) is this label's true visual center — see the matching
      // comment on the axis label above for why that matters once
      // standUpright() rotates labels about their own anchor point.
      const lbl = mk('text', {
        x, y: cfg.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': 10, 'font-weight': 'bold',
        fill: textColorFor(pos), 'pointer-events': 'none',
      }, label);
      const draggable = cfg.editable && !fixed;
      const hit = mk('circle', {
        cx: x, cy: cfg.y, r: beadHitRadius(idx, pos),
        fill: 'transparent',
        cursor: draggable ? 'ew-resize' : (cfg.onBeadPlay ? 'pointer' : 'default'),
        style: draggable ? 'touch-action: none;' : '',
      });

      svgEl.appendChild(circle);
      svgEl.appendChild(lbl);
      svgEl.appendChild(hit);
      beads[idx] = { circle, lbl, hit };

      if (draggable) {
        hit.addEventListener('pointerdown', e => beadDown(e, idx));
      } else if (cfg.onBeadPlay) {
        hit.addEventListener('click', () => cfg.onBeadPlay(pos));
      }
    });

    if (cfg.vertical) standUpright();
  }

  // Rotate the finished drawing a quarter turn, counter-rotating each label
  // about its own anchor so text stays upright. rotate(90) maps (x,y) to
  // (-y,x), so the content lands at x ∈ [-H, 0], y ∈ [0, W] — computed from
  // the caller's original viewBox rather than measured, since getBBox() would
  // force a layout on every redraw, and a drag redraws constantly.
  function standUpright() {
    const { width: W, height: H } = flatViewBox;
    const g = mk('g', { transform: 'rotate(90)' });
    while (svgEl.firstChild) g.appendChild(svgEl.firstChild);
    svgEl.appendChild(g);
    g.querySelectorAll('text').forEach(t => {
      t.setAttribute('transform', `rotate(-90, ${t.getAttribute('x')}, ${t.getAttribute('y')})`);
    });
    svgEl.setAttribute('viewBox', `${-H} 0 ${H} ${W}`);
  }

  // Upright, the bead axis runs down the screen, so a drag has to track the
  // pointer's y instead of its x — and scale against the box's other
  // dimension. Everything downstream still works in horizontal coordinates.
  const dragAxis = e => (cfg.vertical ? e.clientY : e.clientX);
  const axisOrigin = rect => (cfg.vertical ? rect.top : rect.left);
  const axisScale = rect => (cfg.vertical
    ? flatViewBox.width / rect.height
    : flatViewBox.width / rect.width);

  function beadDown(e, idx) {
    e.preventDefault();
    const rect = svgEl.getBoundingClientRect();
    const startPos = scaleOffsets[idx];
    drag = { idx, rect, scale: axisScale(rect), startX: dragAxis(e), moved: false, lastPlayedPos: startPos };
    svgEl.setPointerCapture(e.pointerId);
    if (cfg.onBeadPlay) cfg.onBeadPlay(startPos);
  }

  function beadMove(e) {
    if (!drag) return;
    if (Math.abs(dragAxis(e) - drag.startX) > 3) drag.moved = true;
    const { idx, rect, scale } = drag;
    const svgX = (dragAxis(e) - axisOrigin(rect)) * scale;

    const minP = idx > 1 ? scaleOffsets[idx - 1] + 1 : 1;
    const maxP = idx < scaleOffsets.length - 1 ? scaleOffsets[idx + 1] - 1 : 11;
    const cx = Math.max(atX(minP), Math.min(atX(maxP), svgX));
    const pos = Math.round(xToPos(cx));

    beads[idx].circle.setAttribute('cx', cx);
    beads[idx].lbl.setAttribute('x', cx);
    beads[idx].hit.setAttribute('cx', cx);
    // Upright, the label's own counter-rotation (see standUpright) is
    // `rotate(-90, x, y)` — anchored to the (x,y) it had at the last full
    // render. Moving the label during a drag updates its x above but,
    // without this, leaves that rotation still pivoting around the OLD x —
    // rotating a translated point about the wrong pivot doesn't just mis-
    // place it, it moves it along an entirely different apparent axis,
    // which is exactly what read as "the label slides sideways instead of
    // down the track." Reapplying the same rotation with the CURRENT x
    // keeps the pivot glued to the label through the whole drag, same as
    // a fresh render() would compute from scratch.
    if (cfg.vertical) beads[idx].lbl.setAttribute('transform', `rotate(-90, ${cx}, ${cfg.y})`);
    beads[idx].circle.setAttribute('fill', colorOf(pos));
    beads[idx].lbl.setAttribute('fill', textColorFor(pos));
    // A chord-aware labelFn/onBeadPlay (spicemap's own — see
    // chordAwareBeadLabel/chordVoicingOctaveUp there) needs to know the
    // FULL, final note-set to tell whether this note ends up functioning
    // as an extension — that can only be answered by what scaleOffsets
    // would look like if this drag were committed right now, not the
    // stale pre-drag set (scaleOffsets itself isn't actually written
    // until beadUp). Passing a hypothetical copy here is what makes the
    // live label AND the live playback both already show/sound the
    // correct answer mid-drag, matching what a release immediately after
    // would commit to — without this, a user found the two could
    // disagree with EACH OTHER during the drag, and then disagree with
    // what showed up once released.
    const hypothetical = scaleOffsets.slice();
    hypothetical[idx] = pos;
    beads[idx].lbl.textContent = cfg.labelFn(idx, pos, hypothetical, labelMode, rootPitchClass);

    if (pos !== drag.lastPlayedPos) {
      drag.lastPlayedPos = pos;
      if (cfg.onBeadPlay) cfg.onBeadPlay(pos, hypothetical);
    }
  }

  function beadUp(e) {
    if (!drag) return;
    const { idx, rect, scale } = drag;
    const svgX = (dragAxis(e) - axisOrigin(rect)) * scale;
    const minP = idx > 1 ? scaleOffsets[idx - 1] + 1 : 1;
    const maxP = idx < scaleOffsets.length - 1 ? scaleOffsets[idx + 1] - 1 : 11;
    scaleOffsets[idx] = Math.max(minP, Math.min(maxP, Math.round(xToPos(svgX))));
    drag = null;
    render();
    if (cfg.onChange) cfg.onChange(scaleOffsets.slice());
  }

  svgEl.addEventListener('pointermove', beadMove);
  svgEl.addEventListener('pointerup', beadUp);

  render();

  return {
    render,
    getScale: () => scaleOffsets.slice(),
    setScale(offsets) { scaleOffsets = offsets.slice(); render(); },
    getRoot: () => rootPitchClass,
    setRoot(pc) { rootPitchClass = pc; render(); },
    getLabelMode: () => labelMode,
    setLabelMode(mode) { labelMode = mode; render(); },
    isVertical: () => cfg.vertical,
    setVertical(v) {
      if (cfg.vertical === !!v) return;
      cfg.vertical = !!v;
      render();
    },
    // A host that stands the track upright in a narrow column (see
    // setVertical) may also want a bigger bead there — the column is a
    // touch target now, not just a display, and a size tuned for lying
    // flat across a wide row can read as small standing in a thin one.
    getBeadRadius: () => cfg.beadRadius,
    setBeadRadius(r) {
      if (cfg.beadRadius === r) return;
      cfg.beadRadius = r;
      render();
    },
    // Momentary visual "this one just sounded" flourish — grows bead `idx`
    // and gives it a bright outline, then reverts shortly after. Purely
    // cosmetic (no data/state change), for a host stepping through a
    // sequence of notes in real time (e.g. spicemap's own scale playback)
    // to highlight which one is currently sounding, one at a time.
    // isConnected guards against a re-render (a new scale loaded, a drag)
    // having already replaced this exact circle by the time the revert
    // timeout fires — setting attributes on a detached node is a silent
    // no-op, never an error, but the guard keeps that explicit rather than
    // relying on it by accident.
    pulseBead(idx, ms) {
      const b = beads[idx];
      if (!b) return;
      const baseR = cfg.beadRadius;
      b.circle.setAttribute('r', baseR * 1.4);
      b.circle.setAttribute('stroke', '#ffffff');
      b.circle.setAttribute('stroke-width', 3);
      setTimeout(() => {
        if (!b.circle.isConnected) return;
        b.circle.setAttribute('r', baseR);
        b.circle.setAttribute('stroke', 'rgba(255,255,255,0.25)');
        b.circle.setAttribute('stroke-width', 1.5);
      }, ms || 140);
    },
    // Update any subset of scale/root/labelMode in one go, one re-render —
    // for a host whose own master render() already recomputes all three
    // every time (spicemap's does), avoiding 3 separate rebuilds per call.
    sync(opts) {
      if (opts.scaleOffsets) scaleOffsets = opts.scaleOffsets.slice();
      if (opts.rootPitchClass != null) rootPitchClass = opts.rootPitchClass;
      if (opts.labelMode) labelMode = opts.labelMode;
      render();
    },
    atX, xToPos, // exposed so a host can pixel-align other elements (e.g. a chord matrix) to the same track
    get beads() { return beads; }, // exposed for spicemap's own mode-stepping slide animation (see file header)
  };
}
