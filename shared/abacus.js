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

  function render() {
    svgEl.innerHTML = '';
    beads = [];

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
        // readings are visible at once.
        const axisLabel = labelMode === 'relative' ? NOTE_NAMES[mod12(i + rootPitchClass)] : TABLE_LABELS[i];
        svgEl.appendChild(mk('text', {
          x, y: cfg.y + 29, 'text-anchor': 'middle', 'font-size': 10, fill: '#ffffff',
        }, axisLabel));
      }
    }

    scaleOffsets.forEach((pos, idx) => {
      const x = atX(pos);
      const color = colorOf(pos);
      const fixed = idx === 0;
      const label = beadLabelAt(idx, pos, scaleOffsets, labelMode, rootPitchClass);

      const circle = mk('circle', {
        cx: x, cy: cfg.y, r: cfg.beadRadius,
        fill: color, stroke: 'rgba(255,255,255,0.25)', 'stroke-width': 1.5,
        'pointer-events': 'none',
      });
      const lbl = mk('text', {
        x, y: cfg.y + 5, 'text-anchor': 'middle',
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
  }

  function beadDown(e, idx) {
    e.preventDefault();
    const rect = svgEl.getBoundingClientRect();
    const startPos = scaleOffsets[idx];
    drag = { idx, rect, scale: svgEl.viewBox.baseVal.width / rect.width, startX: e.clientX, moved: false, lastPlayedPos: startPos };
    svgEl.setPointerCapture(e.pointerId);
    if (cfg.onBeadPlay) cfg.onBeadPlay(startPos);
  }

  function beadMove(e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
    const { idx, rect, scale } = drag;
    const svgX = (e.clientX - rect.left) * scale;

    const minP = idx > 1 ? scaleOffsets[idx - 1] + 1 : 1;
    const maxP = idx < scaleOffsets.length - 1 ? scaleOffsets[idx + 1] - 1 : 11;
    const cx = Math.max(atX(minP), Math.min(atX(maxP), svgX));
    const pos = Math.round(xToPos(cx));

    beads[idx].circle.setAttribute('cx', cx);
    beads[idx].lbl.setAttribute('x', cx);
    beads[idx].hit.setAttribute('cx', cx);
    beads[idx].circle.setAttribute('fill', colorOf(pos));
    beads[idx].lbl.setAttribute('fill', textColorFor(pos));
    beads[idx].lbl.textContent = beadLabelAt(idx, pos, scaleOffsets, labelMode, rootPitchClass);

    if (pos !== drag.lastPlayedPos) {
      drag.lastPlayedPos = pos;
      if (cfg.onBeadPlay) cfg.onBeadPlay(pos);
    }
  }

  function beadUp(e) {
    if (!drag) return;
    const { idx, rect, scale } = drag;
    const svgX = (e.clientX - rect.left) * scale;
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
