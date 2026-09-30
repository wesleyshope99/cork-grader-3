import * as db from './db.js';
import { drawNormalizedDisk, transformFromCalibration, CANVAS_SIZE, DISK_PX } from './crop.js';
import { measureDisk } from './measure.js';

function $(id) { return document.getElementById(id); }

let sharedStream = null;
let calibVideoW = 0, calibVideoH = 0;
let calibState = null; // { cx, cy, radius } in native pixel coords, for the calibration screen only
let calibRafId = null;

let gradeVideoW = 0, gradeVideoH = 0;
let calibrationPixels = null; // { transform, circle } reconstructed from stored fractional calibration
let isGradeScreenVisible = false;

const offscreen = document.createElement('canvas');
offscreen.width = CANVAS_SIZE;
offscreen.height = CANVAS_SIZE;
const offscreenCtx = offscreen.getContext('2d');

async function getSharedStream() {
  if (sharedStream) return sharedStream;
  sharedStream = await navigator.mediaDevices.getUserMedia({
    // "ideal" is a soft hint -- the browser still picks the closest mode it
    // supports. Without this, some browsers default a live preview stream to
    // a much lower resolution than the camera is actually capable of, which
    // under-detects the small/shallow pores the grading pipeline was tuned
    // to see in full-resolution reference photos.
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } },
    audio: false,
  });
  return sharedStream;
}

function coverParams(containerRect, nativeW, nativeH) {
  const scale = Math.max(containerRect.width / nativeW, containerRect.height / nativeH);
  return {
    scale,
    offX: (containerRect.width - nativeW * scale) / 2,
    offY: (containerRect.height - nativeH * scale) / 2,
  };
}
function nativeToCss(x, y, cover) { return { x: x * cover.scale + cover.offX, y: y * cover.scale + cover.offY }; }
function cssToNative(x, y, cover) { return { x: (x - cover.offX) / cover.scale, y: (y - cover.offY) / cover.scale }; }

// Draws a circle guide (in native video pixel coords) onto an overlay canvas
// that sits on top of a <video>, accounting for the video's object-fit:cover
// cropping. Shared by the calibration screen (editable circle) and the live
// grading screen (a fixed reminder of where the calibrated disk position is).
function drawCircleGuide(canvasEl, nativeW, nativeH, circle) {
  const rect = canvasEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width = rect.width * dpr;
  canvasEl.height = rect.height * dpr;
  const ctx = canvasEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!circle || !nativeW) return;

  const cover = coverParams(rect, nativeW, nativeH);
  const center = nativeToCss(circle.cx, circle.cy, cover);
  const radiusCss = circle.radius * cover.scale;

  ctx.strokeStyle = '#5ea6b2';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radiusCss, 0, Math.PI * 2);
  ctx.stroke();
}

// ============================= Calibration =============================
// Reused verbatim from cork-grader-2/js/grade.js -- calibrating "where is
// the disk in the frame" has nothing to do with how the disk gets graded
// once cropped.

function drawCalibPreview() {
  if (!calibState || !calibVideoW) return;
  const video = $('calib-video');
  const t = transformFromCalibration(calibState, calibVideoW, calibVideoH, { canvasSize: 300, diskPx: DISK_PX });
  drawNormalizedDisk($('calib-preview').getContext('2d'), video, t, { canvasSize: 300, diskPx: DISK_PX });
}

function calibLoop() {
  drawCircleGuide($('calib-overlay'), calibVideoW, calibVideoH, calibState);
  drawCalibPreview();
  calibRafId = requestAnimationFrame(calibLoop);
}

function wireCalibPointerEvents() {
  const canvas = $('calib-overlay');
  const pointers = new Map();
  let dragLast = null;
  let pinchStartDist = null;
  let pinchStartRadius = null;

  function currentPinchDist() {
    const pts = [...pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) dragLast = { x: e.clientX, y: e.clientY };
    else if (pointers.size === 2) { pinchStartDist = currentPinchDist(); pinchStartRadius = calibState.radius; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = canvas.getBoundingClientRect();
    const cover = coverParams(rect, calibVideoW, calibVideoH);

    if (pointers.size === 1 && dragLast) {
      const prevNative = cssToNative(dragLast.x - rect.left, dragLast.y - rect.top, cover);
      const curNative = cssToNative(e.clientX - rect.left, e.clientY - rect.top, cover);
      calibState.cx += curNative.x - prevNative.x;
      calibState.cy += curNative.y - prevNative.y;
      dragLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const dist = currentPinchDist();
      if (pinchStartDist) calibState.radius = Math.max(20, pinchStartRadius * (dist / pinchStartDist));
    }
  });
  function release(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { pinchStartDist = null; pinchStartRadius = null; }
    dragLast = pointers.size === 1 ? [...pointers.values()][0] : null;
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    calibState.radius = Math.max(20, calibState.radius * (1 - e.deltaY * 0.001));
  }, { passive: false });
}

async function startCalibrationScreen() {
  $('grade-calibrate-prompt').hidden = true;
  $('grading-screen').hidden = true;
  $('calibration-screen').hidden = false;

  const stream = await getSharedStream();
  const video = $('calib-video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise((resolve) => {
    if (video.videoWidth) resolve();
    else video.addEventListener('loadedmetadata', resolve, { once: true });
  });
  calibVideoW = video.videoWidth;
  calibVideoH = video.videoHeight;

  const existing = await db.getSetting('calibration', null);
  if (existing) {
    calibState = {
      cx: existing.fx * calibVideoW,
      cy: existing.fy * calibVideoH,
      radius: existing.fr * calibVideoW,
    };
  } else {
    calibState = {
      cx: calibVideoW / 2,
      cy: calibVideoH / 2,
      radius: Math.min(calibVideoW, calibVideoH) * 0.3,
    };
  }

  calibLoop();
}

function stopCalibrationScreen() {
  if (calibRafId) cancelAnimationFrame(calibRafId);
  calibRafId = null;
  $('calibration-screen').hidden = true;
}

async function confirmCalibration() {
  await db.setSetting('calibration', {
    fx: calibState.cx / calibVideoW,
    fy: calibState.cy / calibVideoH,
    fr: calibState.radius / calibVideoW,
  });
  stopCalibrationScreen();
  await showGradingScreenIfReady();
}

// ============================= Grading (tap-to-grade) =============================
//
// v2 found continuous auto-grading confidently wrong on partial/unstable
// frames, so grading here is tap-triggered only too -- same reasoning, now
// applied to the deterministic pipeline instead of the ML one.

function setResultOverlay(result) {
  const overlay = $('grade-result-overlay');
  const letter = $('grade-result-letter');
  const metrics = $('grade-result-metrics');
  overlay.className = 'result-overlay' + (result ? ` grade-${result.grade}` : '');
  letter.textContent = result ? result.grade : '';
  metrics.textContent = result ? `porosity ${result.porosityPct}%  ·  top-3 holes ${result.top3Mm}mm` : '';
  overlay.hidden = !result;
}

async function commitGrade(result, sourceCanvas, diameterMm) {
  await db.addLogEntry({
    grade: result.grade,
    porosityPct: result.porosityPct,
    top3Mm: result.top3Mm,
    numPores: result.numPores,
    diameterMm,
  });
  setResultOverlay(result);
  $('grade-status').textContent = `Graded: ${result.grade} (porosity ${result.porosityPct}%, top-3 holes ${result.top3Mm}mm)`;
  $('last-graded').textContent = `${result.grade} at ${new Date().toLocaleTimeString()}`;
  $('grade-crop-preview').getContext('2d').drawImage(sourceCanvas, 0, 0, 90, 90);
  if (navigator.vibrate) navigator.vibrate(80);
}

function redrawGradeOverlay() {
  if (!calibrationPixels || !gradeVideoW) return;
  drawCircleGuide($('grade-overlay'), gradeVideoW, gradeVideoH, calibrationPixels.circle);
}

async function showGradingScreenIfReady() {
  const calibration = await db.getSetting('calibration', null);

  $('grade-calibrate-prompt').hidden = !!calibration;
  $('grading-screen').hidden = !calibration;
  $('calibration-screen').hidden = true;

  if (!calibration) return;

  const lastDiameter = await db.getSetting('lastDiameter', null);
  if (lastDiameter && !$('session-diameter').value) {
    $('session-diameter').value = lastDiameter;
  }

  const stream = await getSharedStream();
  const video = $('grade-video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise((resolve) => {
    if (video.videoWidth) resolve();
    else video.addEventListener('loadedmetadata', resolve, { once: true });
  });
  gradeVideoW = video.videoWidth;
  gradeVideoH = video.videoHeight;

  const circle = { cx: calibration.fx * gradeVideoW, cy: calibration.fy * gradeVideoH, radius: calibration.fr * gradeVideoW };
  calibrationPixels = {
    transform: transformFromCalibration(circle, gradeVideoW, gradeVideoH, { canvasSize: CANVAS_SIZE, diskPx: DISK_PX }),
    circle,
  };

  setResultOverlay(null);
  $('grade-status').textContent = 'Enter the disk diameter, line the disk up in the circle, then tap to grade.';
  redrawGradeOverlay();
}

async function handleManualGrade() {
  const video = $('grade-video');
  const diameterMm = parseFloat($('session-diameter').value);
  if (!diameterMm || diameterMm <= 0) {
    $('grade-status').textContent = 'Enter the disk diameter (mm) before grading.';
    return;
  }
  if (!video.videoWidth || !calibrationPixels) return;

  await db.setSetting('lastDiameter', diameterMm);
  drawNormalizedDisk(offscreenCtx, video, calibrationPixels.transform, { canvasSize: CANVAS_SIZE, diskPx: DISK_PX });
  try {
    const result = measureDisk(offscreen, diameterMm);
    // Every real disc in the reference set had dozens of detected pores at
    // minimum, even at the cleanest (Extra) grade -- a reading of zero means
    // the capture failed (out of focus, lens cap, nothing in frame), not
    // that a flawless disc was found. Don't log a grade for a failed capture.
    if (result.numPores === 0) {
      setResultOverlay(null);
      $('grade-status').textContent = 'No texture detected -- likely an out-of-focus or empty capture. Not logged; try again.';
      return;
    }
    await commitGrade(result, offscreen, diameterMm);
  } catch (err) {
    $('grade-status').textContent = err.message;
  }
}

export async function initGradeTab() {
  $('btn-start-calibration').addEventListener('click', startCalibrationScreen);
  $('btn-confirm-calibration').addEventListener('click', confirmCalibration);
  $('btn-cancel-calibration').addEventListener('click', async () => { stopCalibrationScreen(); await showGradingScreenIfReady(); });
  $('btn-recalibrate').addEventListener('click', startCalibrationScreen);
  $('btn-manual-grade').addEventListener('click', handleManualGrade);
  wireCalibPointerEvents();

  window.addEventListener('resize', () => {
    if (isGradeScreenVisible) redrawGradeOverlay();
  });

  window.addEventListener('tab-shown', (e) => {
    isGradeScreenVisible = e.detail.tab === 'grade';
    if (isGradeScreenVisible) showGradingScreenIfReady();
  });

  isGradeScreenVisible = true; // grade is the default active tab on load
  await showGradingScreenIfReady();
}
