import { StringDecoder } from 'node:string_decoder';

const MAX_LINE_BYTES = 1024 * 1024;
const PREFIXES = [
  ['ytcut-progress:', 'progress'],
  ['ytcut-postprocess:', 'postprocess'],
  ['ytcut-output:', 'output'],
];

export function createLineDecoder(onLine) {
  const decoder = new StringDecoder('utf8');
  let line = '';
  let lineBytes = 0;
  let dropping = false;
  let previousWasCR = false;

  function finishLine() {
    if (!dropping && line.length > 0) onLine(line);
    line = '';
    lineBytes = 0;
    dropping = false;
  }

  function consume(text) {
    for (const char of text) {
      if (char === '\r') {
        finishLine();
        previousWasCR = true;
        continue;
      }
      if (char === '\n') {
        if (!previousWasCR) finishLine();
        previousWasCR = false;
        continue;
      }
      previousWasCR = false;
      if (dropping) continue;
      const size = Buffer.byteLength(char, 'utf8');
      if (lineBytes + size > MAX_LINE_BYTES) {
        line = '';
        lineBytes = 0;
        dropping = true;
        continue;
      }
      line += char;
      lineBytes += size;
    }
  }

  return {
    write(chunk) {
      consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      consume(decoder.end());
      if (line.length || dropping) finishLine();
    },
  };
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function isFfmpegProgressLine(line) {
  return /^(?:frame|fps|bitrate|total_size|out_time_us|out_time_ms|out_time|speed|dup_frames|drop_frames|stream_[^=]+|progress)=/.test(line);
}

export function parseProgressLine(line) {
  if (typeof line !== 'string') return null;
  if (line === 'progress=end') return { kind: 'ffmpeg-end' };
  const time = /^out_time_us=(\d+(?:\.\d+)?)$/.exec(line);
  if (time && Number.isFinite(Number(time[1]))) return { kind: 'ffmpeg-time', seconds: Number(time[1]) / 1e6 };
  const speed = /^speed=\s*(\d+(?:\.\d+)?)x$/.exec(line);
  if (speed && Number.isFinite(Number(speed[1]))) return { kind: 'ffmpeg-speed', factor: Number(speed[1]) };
  const match = PREFIXES.find(([prefix]) => line.startsWith(prefix));
  if (!match) return null;
  const [prefix, kind] = match;
  let payload;
  try {
    payload = JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }

  if (kind === 'output') {
    return typeof payload === 'string' ? { kind: 'output', path: payload } : null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (kind === 'postprocess') {
    return {
      kind,
      percent: null,
      downloadedBytes: null,
      totalBytes: null,
      speedBps: null,
      etaSec: null,
      status: typeof payload.status === 'string' ? payload.status : null,
    };
  }

  const downloadedBytes = finiteNonNegative(payload.downloaded_bytes);
  const totalBytes = finiteNonNegative(payload.total_bytes)
    ?? finiteNonNegative(payload.total_bytes_estimate);
  const percent = downloadedBytes !== null && totalBytes !== null && totalBytes > 0
    ? Math.min(100, downloadedBytes / totalBytes * 100)
    : null;
  return {
    kind,
    percent,
    downloadedBytes,
    totalBytes,
    speedBps: finiteNonNegative(payload.speed),
    etaSec: finiteNonNegative(payload.eta),
    status: typeof payload.status === 'string' ? payload.status : null,
  };
}
