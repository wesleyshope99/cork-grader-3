// Deterministic (no-ML) disk grading: porosity % + average diameter of the
// top-3 largest pores, both measured via classical image thresholding +
// connected-component analysis. Ported from analysis/analyze_pores.py
// (validated against 44 hand-graded reference photos -- see
// analysis/draft_thresholds_top3.py, "Ship-Option Gamma").
//
// Unlike the Python validation script, this does NOT need to find the disk
// in an arbitrary photo -- the caller has already normalized the source
// into a CANVAS_SIZE x CANVAS_SIZE canvas with the disk centered as a known
// DISK_PX-diameter circle (crop.js's drawNormalizedDisk), via the app's
// calibration step. So there's no hue segmentation, no contour finding, no
// minEnclosingCircle -- just pore detection on a known circle. That's also
// why this is hand-rolled instead of pulling in opencv.js: what's left to
// port (grayscale black-hat morphology, fixed-circle rim insets, connected
// components) is small and fast enough at this resolution to not need it.
//
// Tunables below were re-validated at THIS resolution (300x300 canvas,
// 260px disk), not just carried over from the full-photo (~1175px disk)
// Python numbers -- see analysis/validate_300px_resolution.py, which
// resampled all 44 validation photos down to exactly this scale and
// confirmed accuracy held (31/44 = 70.5%, vs. 30/44 = 68.2% at full res).

import { CANVAS_SIZE, DISK_PX } from './crop.js';

const BLACKHAT_THRESH = 65;      // black-hat response threshold (photometric, not spatial -- unchanged from Python)
const DARK_VALUE_MAX = 80;       // absolute-darkness backstop (photometric -- unchanged from Python)
const BH_KERNEL_RADIUS = 6;      // px; ~13px-diameter circular kernel, rescaled from Python's 61px at ~1175px disk
const MIN_PORE_AREA_PX = 1;      // px^2; rescaled from Python's 15px^2 at ~1175px disk
const TOP_N_HOLES = 3;
const RIM_INSET_FRAC_BLACKHAT = 0.01;
const RIM_INSET_FRAC_DARK = 0.05;

const GRADE_ORDER = ['Extra', 'AAA', 'A', 'B', 'C']; // best to worst
const POROSITY_CUTS = [1.75, 2.70, 4.97, 8.20];      // % , cut points between adjacent grades
const TOP3_CUTS = [1.10, 1.20, 1.70, 2.40];          // mm, user-selected (accuracy-tuned) cut points

function bucket(value, cuts) {
  for (let i = 0; i < cuts.length; i++) {
    if (value <= cuts[i]) return GRADE_ORDER[i];
  }
  return GRADE_ORDER[GRADE_ORDER.length - 1];
}

/** A disk is graded by whichever of its two metrics is WORSE (closer to C). */
export function gradeFor(porosityPct, top3Mm) {
  const g1 = bucket(porosityPct, POROSITY_CUTS);
  const g2 = bucket(top3Mm, TOP3_CUTS);
  return GRADE_ORDER.indexOf(g1) >= GRADE_ORDER.indexOf(g2) ? g1 : g2;
}

function circleOffsets(radius) {
  const offsets = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) offsets.push([dx, dy]);
    }
  }
  return offsets;
}
const BH_OFFSETS = circleOffsets(BH_KERNEL_RADIUS);

/** Grayscale dilate ('max') or erode ('min') with the given kernel offsets. */
function grayMorph(value, w, h, offsets, mode) {
  const out = new Uint8ClampedArray(w * h);
  const takeMax = mode === 'max';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = takeMax ? -1 : 256;
      for (let k = 0; k < offsets.length; k++) {
        const nx = x + offsets[k][0];
        const ny = y + offsets[k][1];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const v = value[ny * w + nx];
        if (takeMax ? v > best : v < best) best = v;
      }
      out[y * w + x] = best < 0 ? 0 : (best > 255 ? 255 : best);
    }
  }
  return out;
}

/** 8-connected component labeling; returns the pixel area of each blob. */
function componentAreas(binaryMask, w, h) {
  const visited = new Uint8Array(w * h);
  const areas = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!binaryMask[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let area = 0;
    while (sp > 0) {
      const cur = stack[--sp];
      area++;
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (binaryMask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
          }
        }
      }
    }
    areas.push(area);
  }
  return areas;
}

function round2(x) { return Math.round(x * 100) / 100; }

function getImageData(source) {
  if (source instanceof ImageData) return source;
  const ctx = source.getContext('2d');
  return ctx.getImageData(0, 0, source.width || CANVAS_SIZE, source.height || CANVAS_SIZE);
}

/**
 * Measure a normalized disk canvas (as produced by crop.js's
 * drawNormalizedDisk, CANVAS_SIZE x CANVAS_SIZE with the disk centered as a
 * DISK_PX circle). `diameterMm` is the disk's known real-world diameter,
 * required to convert the hole-size metric from px to mm.
 * Returns { porosityPct, top3Mm, numPores, grade }.
 */
export function measureDisk(source, diameterMm) {
  if (!diameterMm || diameterMm <= 0) {
    throw new Error('measureDisk requires a positive diameterMm');
  }
  const { data, width, height } = getImageData(source);

  const value = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    value[i] = Math.max(data[o], data[o + 1], data[o + 2]);
  }

  const cx = width / 2;
  const cy = height / 2;
  const diskRadius = DISK_PX / 2;
  const bhInsetPx = Math.max(1, Math.round(diskRadius * RIM_INSET_FRAC_BLACKHAT));
  const darkInsetPx = Math.max(1, Math.round(diskRadius * RIM_INSET_FRAC_DARK));
  const bhRadius = diskRadius - bhInsetPx;
  const darkRadius = diskRadius - darkInsetPx; // larger inset -- used as the porosity% denominator, matching analyze_pores.py
  const searchArea = Math.PI * darkRadius * darkRadius;

  const dilated = grayMorph(value, width, height, BH_OFFSETS, 'max');
  const closed = grayMorph(dilated, width, height, BH_OFFSETS, 'min'); // closing = dilate then erode

  const bhRadius2 = bhRadius * bhRadius;
  const darkRadius2 = darkRadius * darkRadius;
  const pore = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const dx = x + 0.5 - cx; // pixel-center distance, matches canvas-center convention
      const dy = y + 0.5 - cy;
      const distSq = dx * dx + dy * dy;
      const blackhat = closed[idx] - value[idx]; // closing(f) >= f pointwise, so this is always >= 0
      const bhHit = blackhat > BLACKHAT_THRESH && distSq <= bhRadius2;
      const darkHit = value[idx] < DARK_VALUE_MAX && distSq <= darkRadius2;
      if (bhHit || darkHit) pore[idx] = 1;
    }
  }

  const areas = componentAreas(pore, width, height).filter((a) => a >= MIN_PORE_AREA_PX);
  const totalPoreArea = areas.reduce((s, a) => s + a, 0);
  const porosityPct = searchArea ? (100 * totalPoreArea) / searchArea : 0;

  const topAreas = areas.slice().sort((a, b) => b - a).slice(0, TOP_N_HOLES);
  const diamsPx = topAreas.map((a) => 2 * Math.sqrt(a / Math.PI));
  const avgDiamPx = diamsPx.length ? diamsPx.reduce((s, d) => s + d, 0) / diamsPx.length : 0;
  const mmPerPx = diameterMm / DISK_PX;
  const top3Mm = avgDiamPx * mmPerPx;

  const roundedPorosity = round2(porosityPct);
  const roundedTop3 = round2(top3Mm);
  return {
    porosityPct: roundedPorosity,
    top3Mm: roundedTop3,
    numPores: areas.length,
    grade: gradeFor(roundedPorosity, roundedTop3),
  };
}
