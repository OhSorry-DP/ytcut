'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { buildMetadataArgs, buildDownloadArgs } from './yt-args.js';
import { createLineDecoder, parseProgressLine, isFfmpegProgressLine } from './progress.js';
import { selectPreviewStreams } from './preview-stream.js';
import { CLASSIFIED_CODES, classifyToolError, classifyToolWarning } from './tool-errors.js';
const LIMIT = 8 * 1024 * 1024;
function failure(code, message) { return { code, message }; }
function toolFailure(code, stderr) {
  const classified = classifyToolError({ code, stderr, context: 'source' });
  // 포괄 분류는 기존 오류 코드를 유지하고 안전한 일반 문구만 사용한다.
  if (CLASSIFIED_CODES.includes(classified.code) && !['TOOL_FAILED', 'SOURCE_UNAVAILABLE'].includes(classified.code)) return classified;
  return failure(code, classifyToolError().message);
}
function truncateStem(value, limit) {
  let end = Math.min(value.length, limit);
  if (end && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}
function normalizeFileName(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function defaultFileStem(title) {
  let stem = normalizeFileName(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  return stem || 'clip';
}
function createRunner({ spawnImpl = spawn, platform = process.platform, now = Date.now } = {}) {
  function killTree(child) {
    if (!child) return;
    const fallback = () => { try { child.kill(); } catch {} };
    try {
      if (platform === 'win32' && child.pid) {
        const killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
        killer.once('error', fallback);
        killer.once('close', code => { if (code !== 0) fallback(); });
      } else fallback();
    } catch { fallback(); }
  }
  function metadataWithStreams(url, settings = {}) {
    return new Promise((resolve, reject) => {
      let child, timer, settled = false, stdout = [], bytes = 0, stderr = '';
      const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); settings.signal?.removeEventListener('abort', abort); err ? reject(err) : resolve(value); };
      const stop = (code, message) => { if (settled) return; finish(failure(code, message)); killTree(child); };
      const abort = () => stop('ABORTED', 'Metadata aborted');
      if (settings.signal?.aborted) { abort(); return; }
      try { child = spawnImpl(settings.ytDlpPath || 'yt-dlp', buildMetadataArgs(url), { shell: false, windowsHide: true }); } catch (err) { finish(failure(err.code || 'SPAWN_ERROR', err.message)); return; }
      timer = setTimeout(() => stop('TIMEOUT', 'Metadata timed out'), 45000);
      settings.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => { if (settled) return; const b = Buffer.from(chunk); bytes += b.length; if (bytes > LIMIT) return stop('OUTPUT_LIMIT', 'Metadata exceeds 8 MiB'); stdout.push(b); });
      const errors = createLineDecoder(line => { stderr = (stderr + line + '\n').slice(-65536); });
      child.stderr.on('data', chunk => { if (!settled) errors.write(chunk); });
      child.on('error', err => finish(failure(err.code || 'SPAWN_ERROR', 'Unable to start the tool')));
      child.once('close', code => {
        if (settled) return;
        errors.end();
        if (code !== 0) return finish(toolFailure('METADATA_FAILED', stderr));
        try {
          const v = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (v.is_live || v.is_upcoming || ['is_live', 'is_upcoming'].includes(v.live_status) || !Number.isFinite(v.duration) || v.duration <= 0) return finish(failure('INVALID_DURATION', 'Only finite non-live videos are supported'));
          if (typeof v.id !== 'string' || typeof v.title !== 'string') return finish(failure('INVALID_METADATA', 'Missing video id or title'));
          const formats = Array.isArray(v.formats) ? v.formats.map(format => {
            const copy = {};
            if (!format || typeof format !== 'object' || Array.isArray(format)) return copy;
            for (const key of ['protocol', 'url', 'vcodec', 'acodec', 'height', 'tbr', 'abr']) {
              if (Object.hasOwn(format, key)) copy[key] = format[key];
            }
            return copy;
          }) : null;
          const warning = stderr && classifyToolWarning(stderr);
          finish(null, {
            video: { url: buildMetadataArgs(url).at(-1), videoId: v.id, title: v.title, durationSec: v.duration },
            streams: formats ? selectPreviewStreams(formats, settings.previewResolution ?? 480) : null,
            formats,
            ...(warning && ['JS_RUNTIME_MISSING', 'JS_CHALLENGE_FAILED'].includes(warning.code) ? { warnings: [warning] } : {}),
          });
        } catch (err) { finish(failure('INVALID_METADATA', err.message)); }
      });
      if (settings.signal?.aborted) abort();
    });
  }
  function start(item, onUpdate = () => {}) {
    let child, settled = false, cancelled = false, validating = false, marker, stderr = '', resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const duration = item.snapshot.timeline.endSec - item.snapshot.timeline.startSec;
    let seconds = 0, factor = null, processing = false, lastUpdate, currentProgress = 0;
    const finish = (err, value) => { if (settled) return; settled = true; err ? reject(err) : resolve(value); };
    const update = value => {
      if (settled || cancelled) return;
      const signature = JSON.stringify(value);
      if (signature === lastUpdate) return;
      lastUpdate = signature;
      if (typeof value.progress === 'number') currentProgress = value.progress;
      try { onUpdate({ ...value, timestamp: now() }); } catch {}
    };
    const ffmpegUpdate = () => update({
      phase: processing ? 'processing' : 'downloading',
      progress: processing ? 99 : Math.min(99, Math.round(seconds / duration * 1000) / 10),
      etaSec: processing || factor === null ? null : Math.max(0, Math.round((duration - seconds) / factor)),
    });
    const line = text => {
      if (settled || cancelled) return;
      const parsed = parseProgressLine(text);
      if (!parsed) return;
      if (parsed.kind === 'output') marker = parsed.path;
      else if (parsed.kind.startsWith('ffmpeg-')) {
        if (!(duration > 0)) return;
        if (parsed.kind === 'ffmpeg-time') seconds = parsed.seconds;
        if (parsed.kind === 'ffmpeg-speed' && parsed.factor > 0) factor = parsed.factor;
        if (parsed.kind === 'ffmpeg-end') processing = true;
        ffmpegUpdate();
      } else if (parsed.kind === 'postprocess' && parsed.status === 'started') {
        processing = true;
        update({ ...parsed, phase: 'processing', percent: 99, progress: 99, etaSec: null });
      } else if (processing) {
        update({ ...parsed, phase: 'processing', percent: 99, progress: 99, etaSec: null });
      } else update({ ...parsed, phase: parsed.kind === 'postprocess' ? 'processing' : 'downloading',
        progress: parsed.percent === null ? currentProgress : Math.min(99, parsed.percent),
        percent: parsed.percent === null ? null : Math.min(99, parsed.percent) });
    };
    const output = createLineDecoder(line);
    const errors = createLineDecoder(text => {
      if (!isFfmpegProgressLine(text) && !parseProgressLine(text)) stderr = (stderr + text + '\n').slice(-65536);
      line(text);
    });
    const cancel = () => {
      if (settled || cancelled) return;
      cancelled = true;
      // A close may already be validating the file; its result must not win cancellation.
      killTree(child);
      if (!child) finish(failure('CANCELLED', 'Download cancelled'));
    };
    try {
      const attemptDir = path.resolve(item.execution.outputDir, item.id, `attempt-${item.attempt}`);
      const args = buildDownloadArgs(item);
      child = spawnImpl(item.execution.ytDlpPath || 'yt-dlp', args, { shell: false, windowsHide: true });
      child.stdout.on('data', chunk => { if (!settled && !cancelled) output.write(chunk); });
      child.stderr.on('data', chunk => { if (!settled && !cancelled) errors.write(chunk); });
      child.on('error', err => { if (!validating) finish(failure(cancelled ? 'CANCELLED' : err.code || 'SPAWN_ERROR', cancelled ? 'Download cancelled' : 'Unable to start the tool')); });
      child.once('close', async code => {
        if (settled) return;
        output.end(); errors.end();
        if (cancelled) return finish(failure('CANCELLED', 'Download cancelled'));
        if (code !== 0) return finish(toolFailure('DOWNLOAD_FAILED', stderr));
        if (!marker) return finish(failure('OUTPUT_MISSING', 'Missing after_move output marker'));
        validating = true;
        let published, owned, outputRoot;
        const rollback = async () => {
          if (!published || !owned) return;
          try {
            const current = await fs.lstat(published);
            if (current.dev === owned.dev && current.ino === owned.ino && current.birthtimeMs === owned.birthtimeMs) await fs.unlink(published);
          } catch (err) { if (err.code !== 'ENOENT') throw failure('OUTPUT_PUBLISH_FAILED', err.message); }
        };
        try {
          const root = await fs.realpath(attemptDir), file = await fs.realpath(path.resolve(attemptDir, marker));
          const relative = path.relative(root, file);
          if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw failure('OUTPUT_OUTSIDE_ATTEMPT', 'Output is outside attemptDir');
          if (path.extname(file) !== '.' + item.snapshot.format) throw failure('OUTPUT_FORMAT_MISMATCH', 'Output extension differs from snapshot.format');
          if (!(await fs.stat(file)).isFile()) throw failure('OUTPUT_MISSING', 'Output is not a file');
          if (settled) return;
          if (cancelled) return finish(failure('CANCELLED', 'Download cancelled'));
          let outputPath = file;
          if (item.execution.outputLayout === 'flat-v1') {
            outputRoot = await fs.realpath(item.execution.outputDir);
            const stem = normalizeFileName(item.fileName ?? item.snapshot.fileName) || defaultFileStem(item.snapshot.video.title);
            let names;
            for (let number = 1; number <= 9999; number++) {
              if (cancelled) throw failure('CANCELLED', 'Download cancelled');
              const suffix = number === 1 ? '' : ` (${number})`;
              const name = truncateStem(stem, 120 - suffix.length) + suffix + '.' + item.snapshot.format;
              const candidate = path.join(outputRoot, name);
              if (candidate.length > 240) throw failure('OUTPUT_PATH_TOO_LONG', 'Output path exceeds 240 UTF-16 units');
              names ??= new Set((await fs.readdir(outputRoot)).map(entry => entry.toLowerCase()));
              if (names.has(name.toLowerCase())) continue;
              try {
                owned = await fs.lstat(file);
                await fs.link(file, candidate);
              }
              catch (err) {
                if (err.code === 'EEXIST') continue;
                if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL'].includes(err.code)) throw failure('OUTPUT_PUBLISH_FAILED', err.message);
                try {
                  await fs.copyFile(file, candidate, constants.COPYFILE_EXCL);
                  published = candidate;
                  owned = await fs.lstat(candidate);
                } catch (copyError) {
                  if (copyError.code === 'EEXIST') continue;
                  throw failure('OUTPUT_PUBLISH_FAILED', copyError.message);
                }
              }
              published = candidate;
              outputPath = candidate;
              break;
            }
            if (!published) throw failure('OUTPUT_NAME_EXHAUSTED', 'All output names are occupied');
          }
          if (cancelled) throw failure('CANCELLED', 'Download cancelled');
          update({ phase: 'completed', progress: 100, etaSec: null });
          if (cancelled) throw failure('CANCELLED', 'Download cancelled');
          if (outputRoot) {
            const jobDir = path.dirname(attemptDir);
            try {
              if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.basename(jobDir)) &&
                  path.dirname(jobDir) === outputRoot && !(await fs.lstat(jobDir)).isSymbolicLink()) {
                if (cancelled) throw failure('CANCELLED', 'Download cancelled');
                await fs.rm(jobDir, { recursive: true, force: true });
              }
            } catch {}
          }
          if (cancelled) throw failure('CANCELLED', 'Download cancelled');
          finish(null, { outputPath, outputFileName: path.basename(outputPath) });
        } catch (err) {
          try { await rollback(); } catch (cleanupError) { err = cleanupError; }
          finish(failure(cancelled ? 'CANCELLED' : err.code?.startsWith('OUTPUT_') ? err.code : 'OUTPUT_MISSING', err.message));
        }
      });
      update({ phase: 'downloading', progress: 0 });
    } catch (err) { finish(failure(err.code || 'SPAWN_ERROR', err.message)); }
    return { done, cancel };
  }
  const metadata = async (url, settings) => {
    const result = await metadataWithStreams(url, settings);
    return result.video;
  };
  return { metadata, metadataWithStreams, start };
}
export { createRunner };
