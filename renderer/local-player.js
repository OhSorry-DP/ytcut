const POLL_MS = 250, SEEK_MS = 120, BUFFERING_DELAY_MS = 250, LOAD_TIMEOUT_MS = 15000, RECOVER_COOLDOWN_MS = 15000;
const FRONT_BUFFER_SEC = 180, RESUME_FRONT_SEC = 170;
const MAX_RANGES = 4, MAX_BUFFERED_SEC = 720, EVICT_BLOCK_SEC = 60, PROTECT_BACK_SEC = 60, PROTECT_FRONT_SEC = 10;
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
  let preparing = false, target, pendingTarget, seekTimer, bufferingTimer, prepareTimer, buffering = false, loadWait, targetRevision = 0, requestId = 0;
  const seekWaiters = [];
  const clamp = sec => Math.min(duration, Math.max(0, Number(sec) || 0));
  const owns = s => !destroyed && stream === s && s.generation === streamGeneration && !s.dead;
  const videoOwns = s => s && owns(s) && video.src === s.url && (!video.currentSrc || video.currentSrc === s.url);
  const actual = () => clamp(Number(video.currentTime) || 0);
  const ownsRequest = (s, r) => owns(s) && s.request === r && !r.stopped;
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
  function cancelReader(s, reason = 'seek') {
    const r = s?.request;
    if (!r || r.stopped) return;
    r.stopped = true; r.stopReason = reason; r.controller.abort();
    clearTimeout(r.timer);
    try { Promise.resolve(r.reader?.cancel()).catch(() => {}); } catch {}
    r.wake?.(); r.wake = undefined;
    clearTimeout(s.timer);
  }
  function dispose() {
    const s = stream; if (!s) return;
    s.dead = true; clearTimeout(s.timer); cancelReader(s, 'dispose'); s.operation?.reject(new Error('SUPERSEDED')); s.operation = undefined;
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
    if (!videoOwns(s) || failed || preparing || seekTimer !== undefined || !s.sb) return;
    const desired = pendingTarget ?? target;
    if (desired === undefined) return;
    let alignedTime = desired;
    if (covering(video.buffered, alignedTime) < 0) {
      // SourceBuffer와 video의 A/V 교집합 차이만 0.1초까지 허용한다.
      const r = s.request;
      const first = Array.from({ length: video.buffered.length }, (_, i) => video.buffered.start(i)).find(start => start >= r?.start);
      if (r?.purpose === 'seek' && r.mediaAppended && desired === r.target && first !== undefined && first > alignedTime) {
        const gap = first - alignedTime;
        if (gap > 0.1) { void recover(s); return; }
        alignedTime = first;
      } else return;
    }
    if (s.assigned !== alignedTime) {
      try { video.currentTime = alignedTime; s.assigned = alignedTime; } catch { return; }
    }
    if (video.seeking || video.readyState < 3 || Math.abs(video.currentTime - alignedTime) > 0.1) return;
    pendingTarget = target = undefined; clearTimeout(s.timer); stopBuffering(); settleLoad(); void play(); s.request?.wake?.();
  }
  function listen(s, object, name, fn) {
    const guarded = () => { if (owns(s)) fn(); };
    object.addEventListener(name, guarded); s.listeners.push([object, name, guarded]);
  }
  function enqueue(s, r, task) {
    const run = s.queue.then(() => {
      if (!owns(s) || (r && !ownsRequest(s, r))) throw new Error('SUPERSEDED');
      return task();
    });
    s.queue = run.catch(() => {});
    return run;
  }
  function operation(s, kind, value) {
    if (!owns(s)) return Promise.reject(new Error('SUPERSEDED'));
    return new Promise((resolve, reject) => {
      if (s.sb.updating || s.operation) { reject(failure()); return; }
      s.operation = { resolve, reject };
      try {
        if (kind === 'append') s.sb.appendBuffer(value); else s.sb.remove(value.start, value.end);
      } catch (error) { s.operation = undefined; reject(error); }
    });
  }
  function snapshot(s) {
    s.ranges = Array.from({ length: s.sb.buffered.length }, (_, i) => ({ start: s.sb.buffered.start(i), end: s.sb.buffered.end(i) }));
    return s.ranges;
  }
  const total = ranges => ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  const overLimit = ranges => ranges.length > MAX_RANGES || total(ranges) > MAX_BUFFERED_SEC;
  function removable(s) {
    const desired = pendingTarget ?? target, anchor = desired ?? actual();
    const windows = [actual(), ...(desired === undefined ? [] : [desired])].map(t => ({ start: Math.max(0, t - PROTECT_BACK_SEC), end: t + PROTECT_FRONT_SEC }));
    const wholeRanges = [], blocks = [];
    for (const range of snapshot(s)) {
      const protectedRange = windows.some(w => w.start < range.end && range.start < w.end);
      const landing = s.request?.purpose === 'seek' && !s.request.stopped && desired !== undefined && Math.abs(desired - s.request.start) <= 0.001 && range.start <= s.request.start && s.request.start < range.end;
      if (!protectedRange && !landing && s.ranges.length > 1) wholeRanges.push(range);
      else {
        // 양 끝만 깎아서 가운데 구멍으로 범위 수가 늘지 않게 한다.
        const overlapping = windows.filter(w => w.start < range.end && range.start < w.end);
        let left = overlapping.length ? Math.min(...overlapping.map(w => w.start)) : range.end;
        let right = overlapping.length ? Math.max(...overlapping.map(w => w.end)) : range.start;
        if (landing) { left = Math.min(left, s.request.start); right = Math.max(right, s.request.start + PROTECT_FRONT_SEC); }
        if (range.start < left) blocks.push({ start: range.start, end: Math.min(left, range.end, range.start + EVICT_BLOCK_SEC) });
        if (range.end > right) blocks.push({ start: Math.max(right, range.start, range.end - EVICT_BLOCK_SEC), end: range.end });
      }
    }
    const distance = r => Math.max(r.start - anchor, anchor - r.end, 0);
    return (wholeRanges.length ? wholeRanges : blocks).filter(r => r.end > r.start).sort((a, b) => distance(b) - distance(a) || a.start - b.start);
  }
  async function pruneNow(s, quota = false) {
    let removed = false;
    while (quota || overLimit(snapshot(s))) {
      const candidate = removable(s)[0]; if (!candidate) return removed;
      const before = total(s.ranges);
      await operation(s, 'remove', candidate);
      if (total(snapshot(s)) >= before) throw failure();
      removed = true;
      if (quota) break;
    }
    return removed;
  }
  function prune(s) { return enqueue(s, undefined, () => pruneNow(s)); }
  async function append(s, r, bytes, isInit = false) {
    for (let at = 0; at < bytes.length; at += SLICE_SIZE) {
      const slice = bytes.subarray(at, Math.min(at + SLICE_SIZE, bytes.length));
      await enqueue(s, r, async () => {
        try { await operation(s, 'append', slice); } catch (error) {
          if (error.name !== 'QuotaExceededError' || !ownsRequest(s, r)) throw error;
          if (!await pruneNow(s, true)) throw error;
          if (!ownsRequest(s, r)) throw new Error('SUPERSEDED');
          await operation(s, 'append', slice);
        }
        snapshot(s);
      });
      if (!ownsRequest(s, r)) throw new Error('SUPERSEDED');
      if (!isInit) r.mediaAppended = true;
      align();
      await prune(s);
    }
  }
  function front(s) {
    const time = pendingTarget ?? target ?? actual(), i = covering(video.buffered, time);
    return i < 0 ? 0 : video.buffered.end(i) - time;
  }
  async function waitCap(s, r) {
    if (!r.capped && front(s) < FRONT_BUFFER_SEC && !overLimit(snapshot(s))) return;
    r.capped = true;
    while (ownsRequest(s, r) && (front(s) > RESUME_FRONT_SEC || overLimit(snapshot(s)))) {
      await new Promise(resolve => { r.wake = resolve; }); r.wake = undefined;
      if (ownsRequest(s, r)) await prune(s);
    }
    r.capped = false;
  }
  async function consume(s, r) {
    // 보충 요청은 재생 준비가 아니라 실제 네트워크 대기만 제한한다.
    const receiving = async task => {
      if (r.purpose === 'refill') r.timer = setTimeout(() => { if (ownsRequest(s, r)) void recover(s); }, LOAD_TIMEOUT_MS);
      try { return await task(); } finally { clearTimeout(r.timer); }
    };
    try {
      const response = await receiving(() => fetch(`${path}?start=${r.start.toFixed(3)}`, { signal: r.controller.signal }));
      if (!ownsRequest(s, r)) { try { await response.body?.cancel(); } catch {} return; }
      if (!response.ok || !response.body) throw failure();
      r.reader = response.body.getReader();
      let init = new Uint8Array(0), info;
      while (ownsRequest(s, r)) {
        if (s.sb && info) { await prune(s); await waitCap(s, r); }
        if (!ownsRequest(s, r)) return;
        const result = await receiving(() => r.reader.read());
        if (!ownsRequest(s, r)) return;
        if (result.done) {
          if (!info) throw failure();
          await prune(s);
          if (ownsRequest(s, r)) {
            if (r.purpose === 'refill') {
              // 요청 시점의 버퍼 끝과 비교해 반올림 오차를 진행량으로 세지 않는다.
              const ranges = Array.from({ length: video.buffered.length }, (_, i) => ({ start: video.buffered.start(i), end: video.buffered.end(i) }));
              const end = ranges.find(range => range.start <= r.bufferEnd && range.end >= r.bufferEnd)?.end ?? r.bufferEnd;
              if (end - r.bufferEnd < 0.001) s.actualEnd = end;
            }
            r.eof = true; r.stopped = true; r.stopReason = 'eof';
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
          if (!ownsRequest(s, r)) return;
          await enqueue(s, r, () => {
            if (s.ms.readyState !== 'open' || (s.mime && s.mime !== info.mime)) throw failure();
            if (!s.sb) {
              s.mime = info.mime; s.sb = s.ms.addSourceBuffer(info.mime); s.sb.mode = 'segments';
              listen(s, s.sb, 'updateend', () => {
                if (s.intentionalAbort) return;
                const op = s.operation; s.operation = undefined; snapshot(s); op?.resolve();
              });
              for (const name of ['error', 'abort']) listen(s, s.sb, name, () => {
                if (name === 'abort' && s.intentionalAbort) return;
                const op = s.operation; s.operation = undefined; op?.reject(failure()); void recover(s);
              });
            } else {
              s.intentionalAbort = true;
              try { s.sb.abort(); } finally { s.intentionalAbort = false; }
            }
            s.sb.appendWindowStart = 0; s.sb.appendWindowEnd = Infinity; s.sb.timestampOffset = r.start;
          });
          await append(s, r, init.subarray(0, info.end), true);
          await append(s, r, init.subarray(info.end)); init = undefined;
          await append(s, r, bytes.subarray(take));
        } else await append(s, r, bytes);
      }
    } catch { if (ownsRequest(s, r)) void recover(s); }
  }
  function armReadiness(s) {
    clearTimeout(s.timer); const revision = targetRevision;
    s.timer = setTimeout(() => { if (owns(s) && revision === targetRevision && target !== undefined) void recover(s); }, LOAD_TIMEOUT_MS);
  }
  function openStream(sec, purpose = 'seek') {
    if (purpose === 'seek' && stream?.sb && covering(video.buffered, sec) >= 0) { target = sec; align(); return; }
    cancelReader(stream);
    if (purpose === 'seek') { target = clamp(sec); pendingTarget = undefined; ended = false; video.pause(); }
    let s = stream;
    if (!s) {
      streamGeneration++; const ms = new MediaSource();
      s = { ms, generation: streamGeneration, listeners: [], url: URL.createObjectURL(ms), queue: Promise.resolve(), ranges: [] };
      stream = s;
      s.open = new Promise((resolve, reject) => { s.openReject = reject; listen(s, ms, 'sourceopen', resolve); });
      s.open.catch(() => {});
      listen(s, ms, 'sourceclose', () => { void recover(s); });
      video.src = s.url; video.load();
    }
    const start = purpose === 'refill' ? Math.min(duration, Math.floor(sec * 1000) / 1000) : Number(clamp(sec).toFixed(3));
    const r = { id: ++requestId, target: clamp(sec), start, bufferEnd: sec, purpose, controller: new AbortController() };
    s.request = r; s.assigned = undefined;
    if (purpose === 'seek') { armReadiness(s); startBuffering(); }
    void consume(s, r).finally(() => clearTimeout(r.timer));
  }
  function endpoint() {
    prepareGeneration++; preparing = false; clearTimeout(prepareTimer);
    targetRevision++; cancelReader(stream, 'endpoint'); clearTimeout(stream?.timer); settleSeeks(); pendingTarget = target = undefined;
    ended = true; wantPlay = false; video.pause(); stopBuffering(); settleLoad(); onTime?.(duration);
  }
  function maintenance() {
    const s = stream;
    if (!videoOwns(s)) return;
    align();
    s.request?.wake?.();
    if (!ended && target === undefined && pendingTarget === undefined &&
        (actual() >= duration - 0.1 || (s.actualEnd !== undefined && actual() >= s.actualEnd - 0.1))) { endpoint(); return; }
    if (s.sb && !s.pruning) {
      s.pruning = true; void prune(s).catch(() => { if (owns(s)) void recover(s); }).finally(() => { s.pruning = false; });
    }
    if (s.request?.stopped && wantPlay && !ended && !failed && !preparing && target === undefined && pendingTarget === undefined && front(s) <= 10) {
      const i = covering(video.buffered, actual());
      const end = i < 0 ? actual() : video.buffered.end(i);
      if (end >= duration - 0.1 || (s.actualEnd !== undefined && end >= s.actualEnd - 0.001)) return;
      openStream(end, 'refill');
    }
  }
  const listeners = {};
  for (const name of ['loadedmetadata', 'canplay', 'playing', 'seeked', 'timeupdate']) listeners[name] = maintenance;
  listeners.error = () => { if (videoOwns(stream)) void recover(stream); };
  listeners.ended = () => {
    if (videoOwns(stream) && !video.seeking && target === undefined && pendingTarget === undefined && actual() >= duration - 0.1) endpoint();
  };
  listeners.click = () => { void api.togglePlay(); };
  for (const [name, fn] of Object.entries(listeners)) video.addEventListener(name, fn);
  const pollTimer = setInterval(() => { if (!destroyed) { maintenance(); onTime?.(getTime()); } }, POLL_MS);
  const api = {
    load(metadata, timeSec = 0) {
      if (destroyed) return Promise.reject(new Error('SUPERSEDED'));
      generation++; targetRevision++; clearTimeout(prepareTimer); stopBuffering(); settleSeeks(); settleLoad(new Error('SUPERSEDED')); dispose();
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
      const next = clamp(sec); ended = false; targetRevision++;
      if (next === duration) { endpoint(); return Promise.resolve(); }
      const s = stream;
      pendingTarget = next;
      if (!preparing && s?.sb && owns(s) && covering(video.buffered, next) >= 0) {
        settleSeeks(); stopBuffering(); target = next; s.assigned = undefined;
        armReadiness(s);
        align(); s.request?.wake?.();
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
