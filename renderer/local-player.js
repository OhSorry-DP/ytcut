const POLL_MS = 250, SEEK_MS = 120, BUFFERING_DELAY_MS = 250, LOAD_TIMEOUT_MS = 15000, RECOVER_COOLDOWN_MS = 15000;
const FRONT_BUFFER_SEC = 180, RESUME_FRONT_SEC = 170, BACK_BUFFER_SEC = 60;
const INIT_LIMIT = 1024 * 1024, SLICE_SIZE = 256 * 1024;
const failure = () => new Error('대체 플레이어를 불러오지 못했습니다');

// 크기와 부모 경계를 검증한다. 미완성 최상위 상자는 다음 read에서 이어 받는다.
function boxAt(bytes, at, end, partial = false) {
  if (end - at < 8) { if (partial) return; throw failure(); }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(at), header = 8;
  if (size === 1) {
    if (end - at < 16) { if (partial) return; throw failure(); }
    size = view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12); header = 16;
  }
  if (!Number.isSafeInteger(size) || size < header || (partial && size > INIT_LIMIT)) throw failure();
  if (at + size > end) { if (partial) return; throw failure(); }
  const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
  return { type, start: at + header, end: at + size };
}
function boxes(bytes, start, end) {
  const result = [];
  while (start < end) { const box = boxAt(bytes, start, end); result.push(box); start = box.end; }
  return result;
}
function child(bytes, parent, type, skip = 0) {
  const box = boxes(bytes, parent.start + skip, parent.end).find(value => value.type === type);
  if (!box) throw failure();
  return box;
}
function descriptor(bytes, at, end) {
  if (at >= end) throw failure();
  const tag = bytes[at++]; let size = 0, done = false;
  for (let i = 0; i < 4; i++) {
    if (at >= end) throw failure();
    const value = bytes[at++]; size = size * 128 + (value & 127);
    if (!(value & 128)) { done = true; break; }
  }
  if (!done || at + size > end) throw failure();
  return { tag, start: at, end: at + size };
}
function audioCodec(bytes, esds) {
  let es = descriptor(bytes, esds.start + 4, esds.end);
  if (es.tag !== 3 || es.end - es.start < 3) throw failure();
  let at = es.start + 3; const flags = bytes[es.start + 2];
  if (flags & 128) at += 2;
  if (flags & 64) { if (at >= es.end) throw failure(); at += 1 + bytes[at]; }
  if (flags & 32) at += 2;
  const config = descriptor(bytes, at, es.end);
  if (config.tag !== 4 || config.end - config.start < 13 || bytes[config.start] !== 0x40) throw failure();
  const asc = descriptor(bytes, config.start + 13, config.end);
  if (asc.tag !== 5 || asc.end - asc.start < 2) throw failure();
  let aot = bytes[asc.start] >> 3;
  if (aot === 31) { if (asc.end - asc.start < 3) throw failure(); aot = 32 + ((bytes[asc.start] & 7) << 3) + (bytes[asc.start + 1] >> 5); }
  if (!aot) throw failure();
  return `mp4a.40.${aot}`;
}
function initInfo(bytes) {
  let at = 0, ftyp = false;
  while (at < bytes.length) {
    const box = boxAt(bytes, at, bytes.length, true);
    if (!box) return;
    if (box.type === 'ftyp') ftyp = true;
    if (box.type === 'moov') {
      if (!ftyp) throw failure();
      const codecs = [];
      for (const trak of boxes(bytes, box.start, box.end).filter(value => value.type === 'trak')) {
        const mdia = child(bytes, trak, 'mdia'), minf = child(bytes, mdia, 'minf');
        const stbl = child(bytes, minf, 'stbl'), stsd = child(bytes, stbl, 'stsd');
        if (stsd.end - stsd.start < 8) throw failure();
        const entries = boxes(bytes, stsd.start + 8, stsd.end);
        const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(stsd.start + 4);
        if (count !== entries.length || count !== 1) throw failure();
        for (const entry of entries) {
          if (entry.type === 'avc1') {
            const avcc = child(bytes, entry, 'avcC', 78);
            if (avcc.end - avcc.start < 7 || bytes[avcc.start] !== 1) throw failure();
            codecs.unshift(`avc1.${Array.from(bytes.subarray(avcc.start + 1, avcc.start + 4), value => value.toString(16).padStart(2, '0')).join('')}`);
          } else if (entry.type === 'mp4a') {
            if (entry.end - entry.start < 28 || bytes[entry.start + 8] || bytes[entry.start + 9]) throw failure();
            codecs.push(audioCodec(bytes, child(bytes, entry, 'esds', 28)));
          } else throw failure();
        }
      }
      if (!codecs.some(codec => codec.startsWith('avc1.'))) throw failure();
      return { end: box.end, mime: `video/mp4; codecs="${codecs.join(', ')}"` };
    }
    at = box.end;
  }
}
function covering(ranges, time) {
  for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= time && time < ranges.end(i)) return i;
  return -1;
}

export function createLocalPlayer(containerId, { prepare, onTime, onError, onBuffering } = {}) {
  const container = document.getElementById(containerId), video = document.createElement('video');
  video.className = 'local-player'; video.playsInline = true; video.preload = 'auto';
  container.replaceChildren(video);
  let destroyed = false, generation = 0, streamGeneration = 0, prepareGeneration = 0, stream;
  let duration = 0, videoId, path, wantPlay = false, ended = false, retried = false, failed = false, lastRecoverAt = 0;
  let preparing = false, target, pendingTarget, seekTimer, bufferingTimer, prepareTimer, buffering = false, loadWait;
  const seekWaiters = [];
  const clamp = sec => Math.min(duration, Math.max(0, Number(sec) || 0));
  const owns = s => !destroyed && stream === s && s.generation === streamGeneration && !s.dead;
  const videoOwns = s => s && owns(s) && video.src === s.url && (!video.currentSrc || video.currentSrc === s.url);
  const actual = () => clamp((stream?.offset || 0) + (Number(video.currentTime) || 0) - (stream?.base || 0));
  const getTime = () => ended ? duration : pendingTarget ?? target ?? actual();
  function stopBuffering() {
    clearTimeout(bufferingTimer); bufferingTimer = undefined;
    if (buffering) { buffering = false; onBuffering?.(false); }
  }
  function startBuffering() {
    stopBuffering(); const token = generation, sg = streamGeneration;
    bufferingTimer = setTimeout(() => {
      if (!destroyed && token === generation && sg === streamGeneration && target !== undefined && !failed) {
        buffering = true; onBuffering?.(true);
      }
    }, BUFFERING_DELAY_MS);
  }
  function settleLoad(error) {
    if (!loadWait) return;
    const wait = loadWait; loadWait = undefined; clearTimeout(wait.timer);
    if (error) wait.reject(error); else wait.resolve();
  }
  function settleSeeks() {
    clearTimeout(seekTimer); seekTimer = undefined;
    for (const resolve of seekWaiters.splice(0)) resolve();
  }
  function cancelReader(s) {
    if (!s || s.stopped) return;
    s.stopped = true; clearTimeout(s.timer); s.controller.abort();
    try { Promise.resolve(s.reader?.cancel()).catch(() => {}); } catch {}
    s.wake?.(); s.wake = undefined;
  }
  function dispose() {
    const s = stream; if (!s) return;
    s.dead = true; clearTimeout(s.timer); cancelReader(s); s.operation?.reject(new Error('SUPERSEDED')); s.operation = undefined;
    s.openReject?.(new Error('SUPERSEDED'));
    for (const [object, name, fn] of s.listeners) object.removeEventListener(name, fn);
    s.listeners.length = 0;
    video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(s.url);
    stream = undefined;
  }
  function finalFailure() {
    if (destroyed || failed) return;
    failed = true; preparing = false; wantPlay = false; clearTimeout(prepareTimer);
    dispose(); target = pendingTarget = undefined; settleSeeks(); stopBuffering(); video.pause();
    const error = failure(); settleLoad(error); onError?.(error);
  }
  async function recover(s) {
    if (s && !owns(s)) return;
    if (destroyed || failed || preparing) return;
    target = getTime(); pendingTarget = undefined; settleSeeks();
    dispose(); stopBuffering();
    // 복구는 직전 복구로부터 쿨다운이 지난 뒤에만 다시 허용한다(긴 재생 중 스트림이 몇 번 끊겨도 이어가되, 연속 실패는 최종 실패로 끝낸다)
    const now = Date.now();
    if (retried && now - lastRecoverAt < RECOVER_COOLDOWN_MS) { finalFailure(); return; }
    retried = true; lastRecoverAt = now; await preparePath();
  }
  function safePath(value) {
    if (typeof value !== 'string' || !/^\/preview\/[A-Za-z0-9_-]+\.mp4$/.test(value)) throw failure();
    return value;
  }
  async function preparePath() {
    const token = generation, prepToken = ++prepareGeneration; preparing = true;
    startBuffering();
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(() => { if (!destroyed && token === generation && prepToken === prepareGeneration) finalFailure(); }, LOAD_TIMEOUT_MS);
    try {
      const value = await prepare(videoId);
      if (destroyed || failed || token !== generation || prepToken !== prepareGeneration) return;
      clearTimeout(prepareTimer);
      path = safePath(value.path); preparing = false;
      const latest = pendingTarget ?? target; pendingTarget = undefined; settleSeeks();
      if (latest === duration) endpoint(); else openStream(latest);
    } catch {
      if (!destroyed && token === generation && prepToken === prepareGeneration) { preparing = false; finalFailure(); }
    }
  }
  async function play() {
    if (destroyed || failed || preparing || target !== undefined || pendingTarget !== undefined || !wantPlay || ended) return;
    const token = generation, s = stream;
    try { await video.play(); } catch {
      if (!destroyed && generation === token && stream === s) { wantPlay = false; onError?.(failure()); }
    }
  }
  function align() {
    const s = stream;
    if (!videoOwns(s) || failed || preparing || seekTimer !== undefined || !s.baseKnown) return;
    const desired = pendingTarget ?? target;
    if (desired === undefined) return;
    let relative = desired - s.offset + s.base;
    if (covering(video.buffered, relative) < 0) {
      // SourceBuffer와 video의 A/V 교집합 차이만 0.1초까지 허용한다.
      if (desired === s.offset && video.buffered.length && video.buffered.start(0) > relative) {
        const gap = video.buffered.start(0) - relative;
        if (gap > 0.1) { void recover(s); return; }
        relative = video.buffered.start(0);
      } else return;
    }
    if (s.assigned !== relative) {
      try { video.currentTime = relative; s.assigned = relative; } catch { return; }
    }
    if (video.seeking || video.readyState < 3 || Math.abs(video.currentTime - relative) > 0.1) return;
    pendingTarget = target = undefined; clearTimeout(s.timer); stopBuffering(); settleLoad(); void play(); s.wake?.();
  }
  function listen(s, object, name, fn) {
    const guarded = () => { if (owns(s)) fn(); };
    object.addEventListener(name, guarded); s.listeners.push([object, name, guarded]);
  }
  function operation(s, kind, bytesOrEnd) {
    if (!owns(s) || s.stopped) return Promise.reject(new Error('SUPERSEDED'));
    return new Promise((resolve, reject) => {
      if (s.sb.updating || s.operation) { reject(failure()); return; }
      s.operation = { resolve, reject };
      try {
        if (kind === 'append') s.sb.appendBuffer(bytesOrEnd); else s.sb.remove(0, bytesOrEnd);
      } catch (error) { s.operation = undefined; reject(error); }
    });
  }
  function removable(s) {
    let end = Math.max(0, video.currentTime - BACK_BUFFER_SEC);
    const desired = pendingTarget ?? target;
    if (desired !== undefined) end = Math.min(end, Math.max(0, desired - s.offset + s.base));
    for (let i = 0; i < s.sb.buffered.length; i++) if (s.sb.buffered.start(i) < end) return end;
    return 0;
  }
  async function prune(s) {
    const end = removable(s); if (end > 0) await operation(s, 'remove', end);
    return end > 0;
  }
  async function append(s, bytes) {
    for (let at = 0; at < bytes.length; at += SLICE_SIZE) {
      const slice = bytes.subarray(at, Math.min(at + SLICE_SIZE, bytes.length));
      try { await operation(s, 'append', slice); } catch (error) {
        if (error.name !== 'QuotaExceededError' || !owns(s) || s.stopped) throw error;
        if (!await prune(s)) throw error;
        await operation(s, 'append', slice);
      }
      if (!owns(s) || s.stopped) throw new Error('SUPERSEDED');
      if (!s.baseKnown && s.sb.buffered.length) { s.base = s.sb.buffered.start(0); s.baseKnown = true; }
      align();
    }
  }
  function front(s) {
    const i = covering(video.buffered, video.currentTime);
    return i < 0 ? 0 : video.buffered.end(i) - video.currentTime;
  }
  async function waitCap(s) {
    if (!s.capped && front(s) < FRONT_BUFFER_SEC) return;
    s.capped = true;
    if (front(s) > FRONT_BUFFER_SEC && !s.overshootReported) {
      s.overshootReported = true; console.debug('MSE fragment buffer cap overshoot', front(s) - FRONT_BUFFER_SEC);
    }
    while (owns(s) && !s.stopped && front(s) > RESUME_FRONT_SEC) {
      await new Promise(resolve => { s.wake = resolve; }); s.wake = undefined;
      if (owns(s) && !s.stopped) await prune(s);
    }
    s.capped = false;
  }
  async function consume(s) {
    try {
      const response = await fetch(`${path}?start=${s.offset.toFixed(3)}`, { signal: s.controller.signal });
      if (!owns(s) || s.stopped) { try { await response.body?.cancel(); } catch {} return; }
      if (!response.ok || !response.body) throw failure();
      s.reader = response.body.getReader();
      let init = new Uint8Array(0), info;
      while (owns(s) && !s.stopped) {
        if (s.sb) { await prune(s); await waitCap(s); }
        if (!owns(s) || s.stopped) return;
        const result = await s.reader.read();
        if (!owns(s) || s.stopped) return;
        if (result.done) {
          if (!info) throw failure();
          await prune(s);
          if (owns(s) && !s.stopped && !s.sb.updating && s.ms.readyState === 'open') {
            s.ms.endOfStream(); s.eof = true;
          }
          return;
        }
        const bytes = result.value;
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw failure();
        if (!info) {
          const take = Math.min(bytes.length, INIT_LIMIT - init.length);
          const merged = new Uint8Array(init.length + take); merged.set(init); merged.set(bytes.subarray(0, take), init.length);
          init = merged; info = initInfo(init);
          if (!info) { if (init.length >= INIT_LIMIT) throw failure(); continue; }
          if (!MediaSource.isTypeSupported(info.mime)) throw failure();
          await s.open;
          if (!owns(s) || s.stopped) return;
          s.sb = s.ms.addSourceBuffer(info.mime); s.sb.mode = 'segments';
          listen(s, s.sb, 'updateend', () => {
            const op = s.operation; s.operation = undefined; op?.resolve(); align(); s.wake?.();
          });
          for (const name of ['error', 'abort']) listen(s, s.sb, name, () => {
            const op = s.operation; s.operation = undefined; op?.reject(failure()); void recover(s);
          });
          await append(s, init.subarray(0, info.end));
          await append(s, init.subarray(info.end)); init = undefined;
          await append(s, bytes.subarray(take));
        } else await append(s, bytes);
      }
    } catch { if (owns(s) && !s.stopped) void recover(s); }
  }
  function openStream(sec) {
    dispose(); streamGeneration++;
    target = clamp(sec); pendingTarget = undefined; ended = false; video.pause();
    const ms = new MediaSource();
    const s = { ms, offset: target, base: 0, baseKnown: false, generation: streamGeneration,
      controller: new AbortController(), listeners: [], url: URL.createObjectURL(ms) };
    stream = s;
    s.timer = setTimeout(() => { if (owns(s)) void recover(s); }, LOAD_TIMEOUT_MS);
    s.open = new Promise((resolve, reject) => { s.openReject = reject; listen(s, ms, 'sourceopen', resolve); });
    // 교체가 sourceopen보다 빠를 때의 reject도 처리한다.
    s.open.catch(() => {});
    listen(s, ms, 'sourceclose', () => { if (!s.eof && !s.stopped) void recover(s); });
    video.src = s.url; video.load(); startBuffering();
    void consume(s);
  }
  function endpoint() {
    prepareGeneration++; preparing = false; clearTimeout(prepareTimer);
    cancelReader(stream); settleSeeks(); pendingTarget = target = undefined;
    ended = true; wantPlay = false; video.pause(); stopBuffering(); settleLoad(); onTime?.(duration);
  }
  function maintenance() {
    const s = stream;
    if (!videoOwns(s)) return;
    align();
    s.wake?.();
    if (s.stopped && !ended && !failed && !preparing && target === undefined && pendingTarget === undefined && front(s) <= 10) openStream(actual());
  }
  const listeners = {};
  for (const name of ['loadedmetadata', 'canplay', 'playing', 'seeked', 'timeupdate']) listeners[name] = maintenance;
  listeners.error = () => { if (videoOwns(stream) && !stream.stopped) void recover(stream); };
  listeners.ended = () => {
    if (videoOwns(stream) && stream.eof && !video.seeking && target === undefined && pendingTarget === undefined) endpoint();
  };
  listeners.click = () => { void api.togglePlay(); };
  for (const [name, fn] of Object.entries(listeners)) video.addEventListener(name, fn);
  const pollTimer = setInterval(() => { if (!destroyed) { maintenance(); onTime?.(getTime()); } }, POLL_MS);
  const api = {
    load(metadata, timeSec = 0) {
      if (destroyed) return Promise.reject(new Error('SUPERSEDED'));
      generation++; clearTimeout(prepareTimer); stopBuffering(); settleSeeks(); settleLoad(new Error('SUPERSEDED')); dispose();
      videoId = metadata.videoId; duration = Math.max(0, Number(metadata.durationSec) || 0);
      target = clamp(timeSec); pendingTarget = undefined; path = undefined;
      wantPlay = ended = retried = failed = preparing = false;
      const promise = new Promise((resolve, reject) => {
        loadWait = { resolve, reject, timer: setTimeout(finalFailure, LOAD_TIMEOUT_MS) };
      });
      if (target === duration) endpoint(); else void preparePath();
      return promise;
    },
    seek(sec) {
      if (destroyed || failed) return Promise.resolve();
      const next = clamp(sec); ended = false;
      if (next === duration) { endpoint(); return Promise.resolve(); }
      const s = stream, relative = next - (s?.offset || 0) + (s?.base || 0);
      pendingTarget = next;
      if (!preparing && s?.baseKnown && owns(s) && covering(video.buffered, relative) >= 0) {
        settleSeeks(); stopBuffering(); target = next; s.assigned = undefined;
        clearTimeout(s.timer); s.timer = setTimeout(() => { if (owns(s)) void recover(s); }, LOAD_TIMEOUT_MS);
        align(); s.wake?.();
        return Promise.resolve();
      }
      cancelReader(s); video.pause();
      clearTimeout(seekTimer); seekTimer = undefined;
      const promise = new Promise(resolve => seekWaiters.push(resolve));
      if (!preparing) seekTimer = setTimeout(() => {
        target = pendingTarget; pendingTarget = undefined; settleSeeks();
        if (path) openStream(target); else void preparePath();
      }, SEEK_MS);
      return promise;
    },
    async seekAndPlay(sec) { const pending = api.seek(sec); wantPlay = true; await pending; await play(); },
    async pause() { wantPlay = false; video.pause(); },
    async togglePlay() { if (destroyed) return; if (wantPlay || !video.paused) await api.pause(); else { wantPlay = true; await play(); } },
    getTime,
    destroy() {
      if (destroyed) return;
      destroyed = true; generation++; clearTimeout(prepareTimer); stopBuffering(); settleSeeks(); settleLoad(new Error('SUPERSEDED')); dispose();
      target = pendingTarget = undefined; clearInterval(pollTimer);
      for (const [name, fn] of Object.entries(listeners)) video.removeEventListener(name, fn);
      video.pause(); video.removeAttribute('src'); video.load(); container.replaceChildren();
    },
  };
  return api;
}
