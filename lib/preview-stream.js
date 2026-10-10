import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const LIMIT = 65536;
const TTL = 30 * 60 * 1000;
const unavailable = () => Object.assign(new Error('미리보기를 준비할 수 없습니다. 잠시 후 다시 시도하세요.'), { code: 'PREVIEW_UNAVAILABLE' });

const RANGE_CHUNK = 10_000_000;
const RANGE_TIMEOUT = 30_000;
const RANGE_RESUMES = 3;
const safeMediaUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) ? url : null;
  } catch { return null; }
};

/** Serves seekable, bounded HTTP byte ranges for ffmpeg's HTTPS-only inputs. */
export async function createRangeInputProxy({ urls, signal, fetchImpl = globalThis.fetch,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (signal?.aborted) throw new Error('Range proxy creation cancelled');
  if (!Array.isArray(urls) || (urls.length !== 1 && urls.length !== 2) || urls.some(url => !safeMediaUrl(url))) {
    throw new Error('Invalid media input URL');
  }
  const token = randomBytes(16).toString('hex');
  const sessionController = new AbortController();
  const listeners = new Set();
  const requests = new Set();
  const generations = urls.map(() => ({ id: 0, controller: null }));
  const sockets = new Set(), probes = new Set();
  let firstFailure, closed = false, serverClosed = false, server;
  const abortError = () => Object.assign(new Error('Range proxy closed'), { name: 'AbortError' });
  const fail = error => {
    if (closed || sessionController.signal.aborted || signal?.aborted || firstFailure) return;
    firstFailure = error instanceof Error ? error : new Error(String(error));
    for (const listener of [...listeners]) { try { listener(firstFailure); } catch {} }
    listeners.clear();
  };
  const onRootAbort = () => close();
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onRootAbort);
    sessionController.abort(abortError());
    for (const state of probes) { if (state.timer) clearTimeoutImpl(state.timer); state.controller.abort(abortError()); }
    for (const generation of generations) generation.controller?.abort(abortError());
    for (const state of requests) {
      if (state.timer) clearTimeoutImpl(state.timer);
      state.reader?.cancel().catch(() => {});
      if (!state.res.destroyed) state.res.destroy();
    }
    requests.clear();
    for (const socket of sockets) socket.destroy();
    if (server && !serverClosed) { serverClosed = true; server.close(); }
  }
  signal?.addEventListener('abort', onRootAbort, { once: true });
  const cancellable = (promise, controller) => new Promise((resolve, reject) => {
    const abort = () => reject(controller.signal.reason || abortError());
    if (controller.signal.aborted) { reject(controller.signal.reason || abortError()); return; }
    controller.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
  });

  const fetchResponse = async (initial, init, state) => {
    let target = safeMediaUrl(initial);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!target) throw new Error('Rejected media redirect URL');
      const controller = state?.controller || sessionController;
      if (controller.signal.aborted) throw controller.signal.reason || abortError();
      const pending = Promise.resolve(fetchImpl(target.href, { ...init, redirect: 'manual', signal: controller.signal }));
      pending.then(response => { if (controller.signal.aborted) response.body?.cancel().catch(() => {}); }, () => {});
      const response = await cancellable(pending, controller);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        try { await response.body?.cancel(); } catch {}
        if (!location || redirects === 3) throw new Error('Too many or invalid media redirects');
        target = safeMediaUrl(new URL(location, target).href);
        continue;
      }
      return response;
    }
    throw new Error('Too many media redirects');
  };
  const readProbe = async url => {
    const state = { controller: new AbortController(), timer: null, reader: null };
    probes.add(state);
    let response;
    const abort = () => { state.controller.abort(sessionController.signal.reason || abortError()); state.reader?.cancel().catch(() => {}); };
    sessionController.signal.addEventListener('abort', abort, { once: true });
    try {
      state.timer = setTimeoutImpl(() => { state.controller.abort(new Error('Range probe timed out')); state.reader?.cancel().catch(() => {}); }, RANGE_TIMEOUT);
      response = await fetchResponse(url, { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } }, state);
      if (response.status !== 206 || response.headers.get('content-encoding') && response.headers.get('content-encoding').toLowerCase() !== 'identity') throw new Error('Invalid range probe response');
      const match = /^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range') || '');
      const size = match && Number(match[1]);
      if (!Number.isSafeInteger(size) || size <= 0 || (response.headers.has('content-length') && response.headers.get('content-length') !== '1')) throw new Error('Invalid range probe length');
      state.reader = response.body?.getReader();
      if (!state.reader) throw new Error('Missing range probe body');
      let bytes = 0;
      for (;;) { const { done, value } = await cancellable(state.reader.read(), state.controller); if (done) break; bytes += value.byteLength; if (bytes > 1) throw new Error('Oversized range probe body'); }
      if (bytes !== 1) throw new Error('Short range probe body');
      return size;
    } finally {
      try { await state.reader?.cancel(); } catch {}
      if (!state.reader) { try { await response?.body?.cancel(); } catch {} }
      clearTimeoutImpl(state.timer);
      sessionController.signal.removeEventListener('abort', abort);
    }
  };
  const sizes = [];
  try {
    for (const url of urls) sizes.push(await readProbe(url));
    if (closed || signal?.aborted) throw abortError();

    server = createServer({ highWaterMark: 65_536 }, (req, res) => {
      const state = { req, res, timer: null, reader: null, controller: null };
      if (closed) { res.destroy(); return; }
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      const match = new RegExp(`^/${token}/(0|1)$`).exec(path);
      if (!match) { res.writeHead(404); res.end(); return; }
      const index = Number(match[1]);
      if (index >= urls.length) { res.writeHead(404); res.end(); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      const size = sizes[index];
      let start = 0, end = size - 1, ranged = false;
      const ranges = req.headers.range;
      if (ranges !== undefined) {
        const parsed = typeof ranges === 'string' && /^bytes=(\d*)-(\d*)$/.exec(ranges);
        if (!parsed || (!parsed[1] && !parsed[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
        ranged = true;
        if (!parsed[1]) {
          const suffix = Number(parsed[2]);
          if (!Number.isSafeInteger(suffix) || suffix <= 0) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
          start = Math.max(0, size - suffix);
        } else {
          start = Number(parsed[1]); end = parsed[2] ? Number(parsed[2]) : size - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
          end = Math.min(end, size - 1);
        }
      }
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1) };
      if (ranged) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      if (req.method === 'HEAD') { res.writeHead(ranged ? 206 : 200, headers); res.end(); return; }
      const generation = generations[index];
      generation.controller?.abort(abortError());
      const readId = ++generation.id;
      const controller = new AbortController(); generation.controller = controller;
      state.controller = controller; requests.add(state);
      let position = start, totalWritten = 0, ended = false;
      const finish = (error) => {
        if (ended) return; ended = true;
        if (state.timer) clearTimeoutImpl(state.timer);
        requests.delete(state);
        if (generation.id !== readId) { if (!res.destroyed) res.destroy(); return; }
        if (error) {
          if (!controller.signal.aborted && generation.id === readId) fail(error);
          controller.abort(error); state.reader?.cancel().catch(() => {});
          if (!res.destroyed) res.destroy();
        }
      };
      const onClose = () => { if (!ended) { controller.abort(abortError()); state.reader?.cancel().catch(() => {}); finish(); } };
      res.once('close', onClose);
      controller.signal.addEventListener('abort', () => { state.reader?.cancel().catch(() => {}); if (state.timer) clearTimeoutImpl(state.timer); if (!res.destroyed) res.destroy(); }, { once: true });
      const writeData = async value => {
        if (generation.id !== readId || closed || controller.signal.aborted) throw abortError();
        if (totalWritten + value.byteLength > end - start + 1) throw new Error('Upstream body exceeded requested range');
        totalWritten += value.byteLength;
        if (!res.write(Buffer.from(value))) await new Promise((resolve, reject) => {
          const drain = () => { cleanup(); resolve(); }, error = err => { cleanup(); reject(err); }, cancelled = () => error(abortError()), cleanup = () => { res.removeListener('drain', drain); res.removeListener('error', error); res.removeListener('close', cancelled); controller.signal.removeEventListener('abort', cancelled); };
          res.once('drain', drain); res.once('error', error); res.once('close', cancelled); controller.signal.addEventListener('abort', cancelled, { once: true });
        });
      };
      const streamChunks = async () => {
        res.writeHead(ranged ? 206 : 200, headers);
        // 타임아웃은 업스트림(네트워크) 응답을 기다리는 동안에만 건다. 소비자(ffmpeg→브라우저)가 느려서 drain 을 기다리는 시간은 포함하지 않는다.
        const armTimeout = () => {
          if (state.timer) clearTimeoutImpl(state.timer);
          state.timer = setTimeoutImpl(() => { const error = new Error('Upstream range timed out'); finish(error); }, RANGE_TIMEOUT);
        };
        const disarmTimeout = () => { if (state.timer) clearTimeoutImpl(state.timer); state.timer = null; };
        let resumes = 0;
        while (position <= end) {
          if (generation.id !== readId || closed) throw abortError();
          const chunkEnd = Math.min(position + RANGE_CHUNK - 1, end);
          armTimeout();
          const response = await fetchResponse(urls[index], { headers: { Range: `bytes=${position}-${chunkEnd}`, 'Accept-Encoding': 'identity' } }, { controller });
          disarmTimeout();
          const expected = chunkEnd - position + 1;
          const cr = response.headers.get('content-range');
          if (response.status !== 206 || cr !== `bytes ${position}-${chunkEnd}/${size}` ||
            (response.headers.has('content-length') && response.headers.get('content-length') !== String(expected)) ||
            (response.headers.get('content-encoding') && response.headers.get('content-encoding').toLowerCase() !== 'identity')) {
            try { await response.body?.cancel(); } catch {}
            throw new Error('Invalid upstream range response');
          }
          state.reader = response.body?.getReader(); if (!state.reader) throw new Error('Missing upstream body');
          let received = 0, broken = null;
          for (;;) {
            armTimeout();
            let step;
            try { step = await cancellable(state.reader.read(), controller); }
            catch (error) {
              disarmTimeout();
              if (controller.signal.aborted || closed || generation.id !== readId) throw error;
              broken = error; break;
            }
            disarmTimeout();
            const { done, value } = step;
            if (controller.signal.aborted) throw abortError();
            if (done) break;
            if (received + value.byteLength > expected) { try { await state.reader.cancel(); } catch {} throw new Error('Upstream body exceeded requested range'); }
            received += value.byteLength; await writeData(value);
          }
          if (broken) {
            // 소비자가 느려 응답을 오래 열어 두면 YouTube 가 연결을 끊는다(ECONNRESET, 약 2분). 이미 전달한 만큼은 두고 그 다음 위치부터 이어 받는다.
            try { await state.reader.cancel(); } catch {}
            state.reader = null;
            if (resumes >= RANGE_RESUMES) throw broken;
            resumes++; position += received;
            continue;
          }
          if (received !== expected) throw new Error('Truncated upstream range');
          try { await state.reader.cancel(); } catch {}
          state.reader = null; clearTimeoutImpl(state.timer); state.timer = null;
          resumes = 0;
          position = chunkEnd + 1;
        }
        if (generation.id === readId && !res.destroyed) { res.end(); finish(); }
      };
      void streamChunks().catch(error => finish(error));
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => {
      const onError = error => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); if (closed) { server.close(); reject(abortError()); } else resolve(); };
      server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
    });
    if (closed || signal?.aborted) { close(); throw abortError(); }
    const address = server.address();
    const inputUrls = urls.map((_, index) => `http://127.0.0.1:${address.port}/${token}/${index}`);
    return { inputUrls, close, onFailure(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      if (firstFailure) { listener(firstFailure); return () => {}; }
      if (closed) return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    } };
  } catch (error) {
    close();
    throw error;
  }
}
export const validVideoId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
export const validToken = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const PREVIEW_HEIGHTS = new Set([360, 480, 720]);
const validPreviewHeight = value => PREVIEW_HEIGHTS.has(value);
export function selectPreviewStreams(formats, maxHeight = 480) {
  if (!Array.isArray(formats) || !validPreviewHeight(maxHeight)) return null;
  const candidates = formats.filter(format => {
    if (!format || format.protocol !== 'https' || typeof format.url !== 'string') return false;
    try {
      const url = new URL(format.url);
      return url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'));
    } catch { return false; }
  });
  const videoCodec = format => typeof format.vcodec === 'string' && format.vcodec.startsWith('avc1');
  const audioCodec = format => typeof format.acodec === 'string' && format.acodec.startsWith('mp4a');
  const height = format => Number.isFinite(format.height) && format.height > 0 && format.height <= maxHeight;
  const bitrate = value => Number.isFinite(value) ? value : 0;
  const bestVideo = values => values.sort((a, b) => b.height - a.height || bitrate(b.tbr) - bitrate(a.tbr))[0];
  const video = bestVideo(candidates.filter(f => videoCodec(f) && f.acodec === 'none' && height(f)));
  const audio = candidates.filter(f => audioCodec(f) && f.vcodec === 'none')
    .sort((a, b) => bitrate(b.abr) - bitrate(a.abr))[0];
  if (video && audio) return { video: video.url, audio: audio.url };
  if (!video && !audio) {
    const muxed = bestVideo(candidates.filter(f => videoCodec(f) && audioCodec(f) && height(f)));
    if (muxed) return { muxed: muxed.url };
  }
  return null;
}
export function parseStart(value = '0') {
  if (typeof value !== 'string' || !/^\d{1,6}(\.\d{1,3})?$/.test(value) || Number(value) >= 86400) throw new Error('Invalid start');
  return value;
}
export function parseUrls(output) {
  const urls = output.trim().split(/\r?\n/).map(line => line.trim());
  if (urls.length < 1 || urls.length > 2 || urls.some(value => {
    try { const url = new URL(value); return !/^https:\/\//.test(value) || url.protocol !== 'https:' || !url.hostname || !!url.username || !!url.password; } catch { return true; }
  })) throw unavailable();
  return urls;
}
export function buildPreviewArgs(urls, start) {
  parseStart(start);
  parseUrls(urls.join('\n'));
  return buildInputArgs(urls, start);
}
function buildInputArgs(urls, start) {
  const args = ['-hide_banner', '-loglevel', 'error', '-probesize', '64k', '-analyzeduration', '0', '-ss', start, '-i', urls[0]];
  if (urls.length === 2) args.push('-ss', start, '-i', urls[1], '-map', '0:v:0', '-map', '1:a:0');
  else args.push('-map', '0:v:0', '-map', '0:a:0?');
  return args.concat(['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']);
}
export function createPreviewStream({ spawnImpl = spawn, now = Date.now, randomBytesImpl = randomBytes,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, platform = process.platform,
  getYtdlpPath, getFfmpegPath = () => 'ffmpeg', rangeProxyFactory = createRangeInputProxy } = {}) {
  const videos = new Map(), tokens = new Map(), resolvers = new Set(), streamCache = new Map();
  let active, selected, closed = false;
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
  async function resolveUrls(videoId, maxHeight) {
    try {
      const binary = await getYtdlpPath();
      if (closed) throw unavailable();
      return await new Promise((resolve, reject) => {
        let child, timer, settled = false, bytes = 0;
        const chunks = [];
        const finish = (error, value) => {
          if (settled) return;
          settled = true; clearTimeoutImpl(timer); resolvers.delete(cancel);
          error ? reject(unavailable()) : resolve(value);
        };
        const cancel = () => { finish(true); killTree(child); };
        try {
          child = spawnImpl(binary, ['--ignore-config', '--no-playlist', '--encoding', 'utf-8', '-g', '-f', `bv*[height<=${maxHeight}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${maxHeight}][vcodec^=avc1][acodec^=mp4a]`, '--', `https://www.youtube.com/watch?v=${videoId}`], { shell: false, windowsHide: true });
          resolvers.add(cancel);
          timer = setTimeoutImpl(cancel, 45000);
          child.stdout.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > LIMIT) return cancel();
            chunks.push(Buffer.from(chunk));
          });
          child.stderr.on('data', () => {});
          child.once('error', cancel);
          child.once('close', code => {
            if (settled) return;
            if (code !== 0) return finish(true);
            try { finish(null, parseUrls(Buffer.concat(chunks).toString('utf8'))); } catch { finish(true); }
          });
        } catch { cancel(); }
      });
    } catch { throw unavailable(); }
  }
  function stop() { active?.cancel(); }
  async function prepare(videoId, maxHeight = 480) {
    if (!validVideoId(videoId)) throw Object.assign(new Error('올바른 영상 ID가 필요합니다.'), { code: 'INVALID_VIDEO_ID' });
    if (!validPreviewHeight(maxHeight)) throw Object.assign(new Error('미리보기 해상도가 올바르지 않습니다.'), { code: 'INVALID_PREVIEW_RESOLUTION' });
    if (closed) throw unavailable();
    const key = `${videoId}:${maxHeight}`;
    if (selected !== key) { stop(); selected = key; }
    const metadata = streamCache.get(videoId);
    const revision = metadata?.revision ?? 0;
    const cached = videos.get(key);
    if (cached && cached.formatsRevision === revision && now() - cached.created < TTL) return { path: `/preview/${cached.token}.mp4` };
    if (cached?.pending && cached.formatsRevision === revision) return cached.pending;
    const entry = { videoId, maxHeight, formatsRevision: revision, token: randomBytesImpl(16).toString('hex'), created: -Infinity };
    if (!validToken(entry.token)) throw unavailable();
    videos.set(key, entry);
    entry.pending = (async () => {
      const freshMetadata = streamCache.get(videoId);
      const fresh = freshMetadata?.revision === revision && now() - freshMetadata.resolvedAt < TTL;
      const streams = fresh ? selectPreviewStreams(freshMetadata.formats, maxHeight) : null;
      entry.fromMetadata = !!streams;
      entry.urls = streams
        ? (streams.muxed ? [streams.muxed] : [streams.video, streams.audio])
        : await resolveUrls(videoId, maxHeight);
      entry.created = entry.fromMetadata ? freshMetadata.resolvedAt : now(); tokens.set(entry.token, entry);
      if (videos.get(key) !== entry) return { path: `/preview/${entry.token}.mp4` };
      return { path: `/preview/${entry.token}.mp4` };
    })();
    try { return await entry.pending; } finally { delete entry.pending; }
  }
  function serve(req, res, token, start = '0', headers = {}) {
    const entry = validToken(token) && tokens.get(token);
    const send = status => { res.writeHead(status, headers); res.end(); };
    if (!entry || closed) return send(404);
    try { start = parseStart(start); } catch { return send(400); }
    stop();
    const mediaHeaders = { ...headers, 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' };
    if (req.method === 'HEAD') { res.writeHead(200, mediaHeaders); return res.end(); }
    const controller = new AbortController();
    let child, proxy, unsubscribe, detachChild, generation = 0;
    let cancelled = false, started = false, urlRefreshUsed = false, rangeFallbackUsed = false, failing = false;
    const releaseLaunch = () => {
      const oldProxy = proxy, oldChild = child;
      proxy = child = undefined;
      unsubscribe?.(); unsubscribe = undefined;
      oldProxy?.close();
      detachChild?.(); detachChild = undefined;
      oldChild?.stdout.unpipe(res); killTree(oldChild);
    };
    const cleanup = () => {
      if (cancelled) return;
      cancelled = true; controller.abort(); ++generation;
      releaseLaunch();
      if (active === session) active = undefined;
      req.removeListener('aborted', cancel); req.removeListener('close', requestClose);
      res.removeListener('close', cancel); res.removeListener('finish', cleanup);
    };
    const cancel = () => { cleanup(); if (!res.destroyed && !res.writableEnded) res.destroy(); };
    // IncomingMessage close also fires after a normally completed request.
    const requestClose = () => { if (req.aborted || !req.complete) cancel(); };
    const session = { cancel };
    active = session;
    req.once('aborted', cancel); req.once('close', requestClose);
    res.once('close', cancel); res.once('finish', cleanup);
    const live = stamp => !cancelled && !controller.signal.aborted && active === session && generation === stamp;
    const fail = async stamp => {
      if (!live(stamp) || failing) return;
      failing = true;
      const retryStamp = ++generation;
      releaseLaunch();
      if (!started && !urlRefreshUsed && (entry.fromMetadata || now() - entry.created >= 10 * 60 * 1000)) {
        urlRefreshUsed = true;
        try {
          if (!live(retryStamp)) return;
          const urls = await resolveUrls(entry.videoId, entry.maxHeight);
          if (!live(retryStamp)) return;
          entry.urls = urls; entry.created = now(); entry.fromMetadata = false; streamCache.delete(entry.videoId);
          await launch(); return;
        } catch {}
      }
      if (!live(retryStamp)) return;
      if (started) cancel(); else { send(502); cleanup(); }
    };
    async function launch() {
      const stamp = ++generation;
      failing = false;
      try {
        if (!live(stamp)) return;
        if (now() - entry.created >= TTL && !urlRefreshUsed) {
          urlRefreshUsed = true;
          const urls = await resolveUrls(entry.videoId, entry.maxHeight);
          if (!live(stamp)) return;
          entry.urls = urls; entry.created = now(); entry.fromMetadata = false; streamCache.delete(entry.videoId);
        }
        if (!live(stamp)) return;
        const binary = await getFfmpegPath();
        if (!live(stamp)) return;
        const sourceUrls = [...entry.urls];
        let args = buildPreviewArgs(sourceUrls, start);
        if (!rangeFallbackUsed) {
          let opened;
          try { opened = await rangeProxyFactory({ urls: [...sourceUrls], signal: controller.signal }); }
          catch {
            if (!live(stamp)) return;
            rangeFallbackUsed = true;
          }
          if (opened) {
            if (!live(stamp)) { opened.close(); return; }
            proxy = opened;
            const inputs = opened.inputUrls;
            if (!Array.isArray(inputs) || inputs.length !== sourceUrls.length) throw unavailable();
            let origin;
            for (const [index, value] of inputs.entries()) {
              const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/([0-9a-f]{32})\/(0|1)$/.exec(value);
              if (!match || Number(match[1]) > 65535 || Number(match[3]) !== index) throw unavailable();
              const base = `${match[1]}/${match[2]}`;
              if (origin && origin !== base) throw unavailable();
              origin = base;
            }
            args = buildInputArgs(inputs, start);
            const remove = opened.onFailure(() => void fail(stamp));
            if (!live(stamp)) { remove(); return; }
            unsubscribe = remove;
          } else if (!rangeFallbackUsed) throw unavailable();
        }
        if (!live(stamp)) return;
        child = spawnImpl(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const current = child;
        const discard = () => {};
        const first = () => { if (live(stamp)) { started = true; res.writeHead(200, mediaHeaders); } };
        const error = () => void fail(stamp);
        const exit = code => { if (!live(stamp)) return; if (code !== 0 || !started) void fail(stamp); else res.end(); };
        current.stderr.on('data', discard);
        current.stdout.once('data', first);
        current.stdout.on('error', error); current.once('error', error); current.once('close', exit);
        detachChild = () => {
          current.stderr.removeListener('data', discard); current.stdout.removeListener('data', first);
          current.stdout.removeListener('error', error); current.removeListener('error', error); current.removeListener('close', exit);
          // Late stream/process errors must remain harmless after ownership is released.
          current.stdout.on('error', discard); current.on('error', discard);
        };
        // Defer end until process exit, so an empty failed stream can still return 502.
        current.stdout.pipe(res, { end: false });
      } catch { void fail(stamp); }
    }
    void launch();
  }
  return { prepare, serve, stop,
    cacheFormats(videoId, formats) {
      if (!closed && validVideoId(videoId)) {
        const prior = streamCache.get(videoId);
        const copied = Array.isArray(formats) ? formats.map(format => format && ({ ...format })) : null;
        streamCache.set(videoId, { formats: copied, resolvedAt: now(), revision: (prior?.revision ?? 0) + 1 });
      }
    },
    close() { closed = true; stop(); for (const cancel of resolvers) cancel(); videos.clear(); tokens.clear(); streamCache.clear(); } };
}
