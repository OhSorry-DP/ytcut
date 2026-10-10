'use strict';

const STATUSES = new Set(['waiting', 'running', 'completed', 'failed', 'cancelled']);
const FORMATS = new Set(['mkv', 'mp4']);
const RESERVED_FILE_STEMS = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

function normalizeFileName(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new RangeError('INVALID_FILE_NAME');
  const normalized = value.trim().normalize('NFC');
  if (normalized.length > 120 || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(normalized) ||
      normalized.includes('..') || normalized.endsWith('.') ||
      /\.(?:mp4|mkv)$/i.test(normalized) ||
      RESERVED_FILE_STEMS.test(normalized.split('.', 1)[0])) {
    throw new RangeError('INVALID_FILE_NAME');
  }
  return normalized;
}

function defaultFileStem(title) {
  if (typeof title !== 'string') title = '';
  let stem = title.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .trim()
    .replace(/[. ]+$/u, '')
    .replace(/\.\./gu, '_');
  if (RESERVED_FILE_STEMS.test(stem.split('.', 1)[0])) stem = `_${stem}`;
  if (stem.length > 120) {
    stem = stem.slice(0, 120);
    if (/^[\uD800-\uDBFF]$/u.test(stem.at(-1))) stem = stem.slice(0, -1);
  }
  stem = stem.replace(/[. ]+$/u, '');
  return stem || 'clip';
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new RangeError('snapshot must be an object');
  }

  if (!FORMATS.has(snapshot.format)) {
    throw new RangeError('snapshot.format must be "mkv" or "mp4"');
  }

  if (Object.hasOwn(snapshot, 'fileName')) {
    if (typeof snapshot.fileName !== 'string' || normalizeFileName(snapshot.fileName) !== snapshot.fileName) {
      throw new RangeError('snapshot.fileName must be canonical');
    }
  }

  const { video, timeline } = snapshot;
  if (!video || typeof video !== 'object' || Array.isArray(video) ||
      typeof video.url !== 'string' || typeof video.videoId !== 'string' ||
      typeof video.title !== 'string' || !Number.isFinite(video.durationSec) ||
      video.durationSec < 0) {
    throw new RangeError('snapshot.video is invalid');
  }

  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) {
    throw new RangeError('snapshot.timeline is invalid');
  }
  const { startSec, endSec, zoom, scrollSec, playheadSec } = timeline;
  if (![startSec, endSec, zoom, scrollSec, playheadSec].every(Number.isFinite) ||
      startSec < 0 || endSec < startSec || endSec > video.durationSec ||
      zoom <= 0 || scrollSec < 0 || playheadSec < 0 || playheadSec > video.durationSec) {
    throw new RangeError('snapshot.timeline is invalid');
  }

  if (typeof snapshot.cutMode !== 'string' || snapshot.cutMode.length === 0) {
    throw new RangeError('snapshot.cutMode is invalid');
  }
}

function transition(item, event, nowIso) {
  if (!item || typeof item !== 'object' || !event || typeof event !== 'object') {
    throw new RangeError('item and event are required');
  }
  if (!Number.isInteger(event.attempt) || event.attempt < 1) {
    throw new RangeError('event.attempt must be a positive integer');
  }
  if (event.attempt !== item.attempt) return item;

  const { type } = event;
  const status = item.status;
  if (type === 'cancel' && (status === 'cancelled' || status === 'completed')) return item;
  if (type === 'complete' && status === 'cancelled') return item;

  const timestamp = nowIso;
  if (type === 'start' && status === 'waiting') {
    return { ...item, status: 'running', progress: 0, etaSec: null, startedAt: timestamp, updatedAt: timestamp };
  }
  if (type === 'complete' && status === 'running') {
    return {
      ...item,
      status: 'completed',
      progress: 100,
      etaSec: null,
      outputPath: event.outputPath,
      completedAt: timestamp,
      updatedAt: timestamp,
    };
  }
  if (type === 'fail' && status === 'running') {
    return { ...item, status: 'failed', error: event.error, failedAt: timestamp, updatedAt: timestamp };
  }
  if (type === 'cancel' && (status === 'waiting' || status === 'running')) {
    return { ...item, status: 'cancelled', cancelledAt: timestamp, updatedAt: timestamp };
  }
  if (type === 'retry' && (status === 'failed' || status === 'cancelled')) {
    return {
      ...item,
      status: 'waiting',
      attempt: item.attempt + 1,
      progress: 0,
      etaSec: null,
      error: undefined,
      outputPath: undefined,
      outputFileName: undefined,
      missingOutputPath: undefined,
      fileDeleted: false,
      startedAt: undefined,
      completedAt: undefined,
      failedAt: undefined,
      cancelledAt: undefined,
      updatedAt: timestamp,
    };
  }

  throw new RangeError(`invalid ${String(type)} transition from ${String(status)}`);
}

function recoverItems(items, nowIso) {
  if (!Array.isArray(items)) throw new RangeError('items must be an array');
  return items.map((item) => {
    if (!item || typeof item !== 'object') throw new RangeError('item must be an object');
    if (!STATUSES.has(item.status)) throw new RangeError('item.status is invalid');
    if (Object.hasOwn(item, 'fileDeleted') && typeof item.fileDeleted !== 'boolean') throw new RangeError('item.fileDeleted must be a boolean');
    if (Object.hasOwn(item, 'fileName') &&
        (typeof item.fileName !== 'string' || normalizeFileName(item.fileName) !== item.fileName)) {
      throw new RangeError('item.fileName must be canonical');
    }
    if (item.execution && Object.hasOwn(item.execution, 'outputLayout') && item.execution.outputLayout !== 'flat-v1') {
      throw new RangeError('item.execution.outputLayout is invalid');
    }
    if (Object.hasOwn(item, 'missingOutputPath') &&
        (typeof item.missingOutputPath !== 'string' || !isAbsolutePath(item.missingOutputPath))) {
      throw new RangeError('item.missingOutputPath must be an absolute path');
    }
    if (item.status !== 'running') return item;
    return {
      ...item,
      status: 'failed',
      etaSec: null,
      error: { code: 'INTERRUPTED', message: ' 작업 중 프로세스가 종료되었습니다.' },
      failedAt: nowIso,
      updatedAt: nowIso,
    };
  });
}

function isAbsolutePath(value) {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value) || value.startsWith('/');
}

export { normalizeFileName, defaultFileStem, validateSnapshot, transition, recoverItems };
