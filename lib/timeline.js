'use strict';

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeTimeline(state, duration) {
  assertPositiveFinite(duration, 'duration');
  const minGap = Math.min(0.05, duration);
  const zoom = clamp(Number.isFinite(state.zoom) ? state.zoom : 1, 1, 64);
  const visible = duration / zoom;
  const scrollSec = clamp(Number.isFinite(state.scrollSec) ? state.scrollSec : 0, 0, duration - visible);

  let startSec = clamp(Number.isFinite(state.startSec) ? state.startSec : 0, 0, duration);
  let endSec = clamp(Number.isFinite(state.endSec) ? state.endSec : duration, 0, duration);
  if (endSec - startSec < minGap) {
    endSec = Math.min(duration, startSec + minGap);
    if (endSec - startSec < minGap) startSec = Math.max(0, endSec - minGap);
  }

  const playheadSec = clamp(Number.isFinite(state.playheadSec) ? state.playheadSec : 0, 0, duration);
  return { ...state, startSec, endSec, zoom, scrollSec, playheadSec };
}

function xToTime(x, width, state, duration) {
  assertPositiveFinite(width, 'width');
  assertPositiveFinite(duration, 'duration');
  return clamp(state.scrollSec + x * duration / (width * state.zoom), 0, duration);
}

function timeToX(t, width, state, duration) {
  assertPositiveFinite(width, 'width');
  assertPositiveFinite(duration, 'duration');
  return (t - state.scrollSec) * width * state.zoom / duration;
}

function zoomAt(state, newZoom, anchorX, width, duration) {
  assertPositiveFinite(width, 'width');
  assertPositiveFinite(duration, 'duration');
  const oldZoom = clamp(Number.isFinite(state.zoom) ? state.zoom : 1, 1, 64);
  const zoom = clamp(Number.isFinite(newZoom) ? newZoom : 1, 1, 64);
  const anchorTime = state.scrollSec + anchorX * duration / (width * oldZoom);
  const visible = duration / zoom;
  const scrollSec = clamp(anchorTime - anchorX * duration / (width * zoom), 0, duration - visible);
  return { ...state, zoom, scrollSec };
}

export { normalizeTimeline, xToTime, timeToX, zoomAt };
