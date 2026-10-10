import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPlayer } from '../renderer/local-player.js';

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const join = (...parts) => Uint8Array.from(parts.flatMap(part => Array.from(part)));
const u32 = value => Uint8Array.of(value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255);
const textBytes = value => Uint8Array.from(value, char => char.charCodeAt(0));
const box = (type, ...payload) => { const bytes = join(...payload); return join(u32(bytes.length + 8), textBytes(type), bytes); };
const desc = (tag, payload) => join([tag, payload.length], payload);
function initBytes({ audio = true, profile = [0x42, 0xc0, 0x1e], badDescriptor = false } = {}) {
  const avcc = box('avcC', [1, ...profile, 255, 224, 0]);
  const avc = box('avc1', new Uint8Array(78), avcc);
  const track = entry => box('trak', box('mdia', box('minf', box('stbl', box('stsd', u32(0), u32(1), entry)))));
  const config = desc(4, join([0x40, 0x15], new Uint8Array(11), desc(5, [0x12, 0x10])));
  const es = desc(3, join([0, 1, 0], config, desc(6, [2])));
  if (badDescriptor) es[1] = 127;
  const aac = box('mp4a', new Uint8Array(28), box('esds', u32(0), es));
  // 디코이의 ASCII 문자열은 실제 nested avcC와 무관하다.
  return join(box('ftyp', textBytes('isom'), u32(0), textBytes('isom')), box('free', textBytes('avcC\u0001\u0064\u0000\u0033')),
    box('moov', track(avc), ...(audio ? [track(aac)] : [])));
}
class Events {
  listeners = new Map();
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { const set = this.listeners.get(name); set?.delete(fn); if (!set?.size) this.listeners.delete(name); }
  emit(name) { for (const fn of [...(this.listeners.get(name) || [])]) fn(); }
}
const rangesOf = owner => ({ get length() { return owner.ranges.length; }, start: i => owner.ranges[i][0], end: i => owner.ranges[i][1] });
class FakeVideo extends Events {
  _currentTime = 0; paused = true; src = ''; currentSrc = ''; sources = []; ranges = []; readyState = 0; seeking = false;
  delayedSeek = false; throwBeforeMetadata = false; assignments = []; playCalls = 0; rejectPlay = false;
  buffered = rangesOf(this);
  get currentTime() { return this._currentTime; }
  set currentTime(value) {
    if (this.throwBeforeMetadata && !this.readyState) throw new Error('metadata unavailable');
    this.assignments.push(value);
    if (this.delayedSeek) { this.seekTarget = value; this.seeking = true; } else this._currentTime = value;
  }
  completeSeek() { this._currentTime = this.seekTarget; this.seeking = false; this.emit('seeked'); }
  load() { this.currentSrc = this.src; this._currentTime = 0; this.ranges = []; this.readyState = 0; this.seeking = false; this.paused = true; if (this.src) this.sources.push(this.src); }
  async play() { this.playCalls++; if (this.rejectPlay) throw new Error('autoplay'); this.paused = false; }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = new Map(['document', 'MediaSource', 'fetch'].map(name => [name, globalThis[name]]));
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const video = new FakeVideo(), errors = [], times = [], buffering = [], sources = [], fetches = [], live = new Set(), revoked = [];
  let prepareCalls = 0, auto = options.auto !== false, supported = true;
  class SourceBuffer extends Events {
    mode = ''; timestampOffset = 0; updating = false; ranges = []; buffered = rangesOf(this);
    calls = []; attempts = []; quota = 0; operation;
    appendBuffer(bytes) {
      assert.equal(this.updating, false); this.attempts.push(Uint8Array.from(bytes));
      if (this.quota > 0) { this.quota--; throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); }
      this.calls.push(['append', Uint8Array.from(bytes)]); this.updating = true; this.operation = 'append';
      if (auto) Promise.resolve().then(() => this.finish());
    }
    remove(start, end) {
      assert.equal(this.updating, false); this.calls.push(['remove', start, end]); this.updating = true; this.operation = 'remove';
      if (auto) Promise.resolve().then(() => this.finish());
    }
    finish(ranges) {
      if (!this.updating) return;
      if (this.operation === 'remove') {
        const end = this.calls.at(-1)[2]; this.ranges = this.ranges.filter(range => range[1] > end).map(([a, b]) => [Math.max(a, end), b]); video.ranges = this.ranges.map(range => [...range]);
      } else if (ranges) { this.ranges = ranges.map(range => [...range]); video.ranges = ranges.map(range => [...range]); }
      else if (this.calls.filter(call => call[0] === 'append').length > 1 && !this.ranges.length) {
        this.ranges = [[options.base || 0, (options.base || 0) + 5]]; video.ranges = this.ranges.map(range => [...range]);
      }
      if (this.videoRanges) video.ranges = this.videoRanges;
      if (auto) video.readyState = 3;
      this.updating = false; this.emit('updateend');
    }
    fail(name = 'error') { this.emit(name); this.updating = false; this.emit('updateend'); }
  }
  class MS extends Events {
    static checks = [];
    static isTypeSupported(mime) { MS.checks.push(mime); return supported; }
    readyState = 'closed'; eos = 0; sb; mime;
    constructor() { super(); sources.push(this); }
    open() { this.readyState = 'open'; this.emit('sourceopen'); }
    addSourceBuffer(mime) { assert.equal(this.readyState, 'open'); this.mime = mime; return this.sb = new SourceBuffer(); }
    endOfStream() { assert.equal(this.sb.updating, false); assert.equal(this.readyState, 'open'); this.eos++; this.readyState = 'ended'; }
  }
  URL.createObjectURL = () => { const url = `blob:test/${sources.length}`; live.add(url); return url; };
  URL.revokeObjectURL = url => { assert.equal(live.delete(url), true); revoked.push(url); };
  globalThis.document = { getElementById: () => ({ replaceChildren() {} }), createElement: () => video };
  globalThis.MediaSource = MS;
  globalThis.fetch = (url, { signal }) => {
    const request = { url, signal, reads: 0, cancels: 0, active: 0, maxActive: 0, queue: [], waiter: undefined, cancelled: false };
    request.push = result => { if (request.waiter) { const fn = request.waiter; request.waiter = undefined; fn(result); } else request.queue.push(result); };
    request.reader = {
      async read() {
        request.reads++; request.active++; request.maxActive = Math.max(request.maxActive, request.active); assert.equal(request.active, 1);
        try {
          const value = request.queue.length ? request.queue.shift() : await new Promise(resolve => { request.waiter = resolve; });
          if (value instanceof Error) throw value;
          return value;
        } finally { request.active--; }
      },
      cancel() { request.cancels++; request.cancelled = true; request.push({ done: true }); return Promise.resolve(); },
    };
    const bytes = options.init || initBytes(options);
    const cuts = options.split ? [3, 9, 17, 43, bytes.length] : [bytes.length]; let previous = 0;
    for (const end of cuts) { request.queue.push({ value: bytes.subarray(previous, end), done: false }); previous = end; }
    request.queue.push({ value: Uint8Array.of(1, 2, 3), done: false });
    fetches.push(request);
    const response = { ok: true, body: { getReader: () => request.reader, cancel: () => { request.bodyCancelled = true; return Promise.resolve(); } } };
    if (options.fetch) return options.fetch(request, response);
    return Promise.resolve(response);
  };
  const player = createLocalPlayer('player', {
    prepare: async id => { prepareCalls++; return options.prepare ? options.prepare(id, prepareCalls) : { path: `/preview/token${prepareCalls === 1 ? '' : prepareCalls}.mp4` }; },
    onError: error => errors.push(error), onTime: time => times.push(time), onBuffering: value => buffering.push(value),
  });
  t.after(() => {
    player.destroy(); assert.equal(live.size, 0);
    for (const source of sources) { assert.equal(source.listeners.size, 0); if (source.sb) assert.equal(source.sb.listeners.size, 0); }
    assert.equal(video.listeners.size, 0);
    for (const [name, value] of saved) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; }
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
  });
  const f = { player, video, errors, times, buffering, sources, fetches, live, revoked, MS,
    get prepares() { return prepareCalls; }, get sb() { return sources.at(-1)?.sb; },
    setAuto(value) { auto = value; }, setSupported(value) { supported = value; },
    start(start = 10, durationSec = 1000) {
      const pending = player.load({ videoId: 'abcdefghijk', durationSec }, start); pending.catch(() => {}); return pending;
    },
    async ready() { await flush(); sources.at(-1)?.open(); await flush(); video.emit('canplay'); await flush(); },
    async load(start = 10, duration = 1000) { const pending = f.start(start, duration); await f.ready(); await pending; },
    range(ranges, current = video.currentTime) { f.sb.ranges = ranges.map(range => [...range]); video.ranges = ranges.map(range => [...range]); video._currentTime = current; },
    async dispatch(sec) { const pending = player.seek(sec); t.mock.timers.tick(120); await pending; await flush(); },
    async push(bytes) { fetches.at(-1).push(bytes instanceof Error ? bytes : bytes === null ? { done: true } : { value: bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), done: false }); await flush(); },
  };
  return f;
}

test('local time uses stream offset and measured buffered origin and polls every 250ms', async t => {
  const f = fixture(t, { base: 12.345 }); await f.load(70);
  assert.equal(f.fetches[0].url, '/preview/token.mp4?start=70.000'); assert.match(f.video.src, /^blob:/);
  assert.equal(f.video.currentTime, 12.345); assert.equal(f.player.getTime(), 70);
  f.video._currentTime = 26.595; assert.equal(f.player.getTime(), 84.25);
  t.mock.timers.tick(249); assert.deepEqual(f.times, []); t.mock.timers.tick(1); assert.deepEqual(f.times, [84.25]);
});
test('buffered seek changes time only; outside seek replaces source and preserves playback and play rejection', async t => {
  const f = fixture(t); await f.load(10); f.range([[0, 40]]); await f.player.togglePlay();
  await f.player.seek(25); assert.equal(f.video.currentTime, 15); assert.equal(f.fetches.length, 1);
  await f.dispatch(70.1234); assert.equal(f.fetches.at(-1).url, '/preview/token.mp4?start=70.123'); assert.equal(f.video.paused, true);
  await f.ready(); assert.equal(f.video.currentTime, 0); assert.equal(f.player.getTime(), 70.1234); assert.equal(f.video.paused, false);
  await f.player.pause(); await f.dispatch(5); await f.ready(); assert.equal(f.player.getTime(), 5); assert.equal(f.video.paused, true);
  f.video.rejectPlay = true; const pending = f.player.seekAndPlay(80); t.mock.timers.tick(120); await pending; await f.ready();
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].message, '대체 플레이어를 불러오지 못했습니다'); assert.equal(f.video.paused, true);
});
test('rapid seeks accumulate 20 times in both directions, clamp endpoint, and debounce from last input', async t => {
  const f = fixture(t); await f.load(60); f.range([[0, 40]]);
  let pending = [];
  for (let i = 0; i < 20; i++) { pending.push(f.player.seek(f.player.getTime() + 10)); assert.equal(f.player.getTime(), 70 + 10 * i); }
  t.mock.timers.tick(119); await flush(); assert.equal(f.fetches.length, 1); assert.equal(f.fetches[0].signal.aborted, true);
  t.mock.timers.tick(1); await Promise.all(pending); await flush(); assert.equal(f.fetches.length, 2); assert.equal(f.fetches.at(-1).url, '/preview/token.mp4?start=260.000'); assert.equal(f.player.getTime(), 260);
  await f.ready(); await f.load(500); f.range([[0, 40]]); pending = [];
  for (let i = 0; i < 20; i++) { pending.push(f.player.seek(f.player.getTime() - 10)); assert.equal(f.player.getTime(), 490 - 10 * i); }
  t.mock.timers.tick(120); await Promise.all(pending); await flush(); assert.equal(f.fetches.at(-1).url, '/preview/token2.mp4?start=300.000'); await f.ready();
  await f.load(60, 100); const base = f.fetches.length; pending = [];
  for (let i = 0; i < 20; i++) { pending.push(f.player.seek(f.player.getTime() + 10)); assert.equal(f.player.getTime(), Math.min(100, 70 + 10 * i)); }
  t.mock.timers.tick(120); await Promise.all(pending); assert.equal(f.fetches.length, base); assert.equal(f.video.paused, true); assert.equal(f.times.at(-1), 100);
  await f.load(60); pending = [f.player.seek(260)]; t.mock.timers.tick(119); pending.push(f.player.seek(f.player.getTime() + 10));
  t.mock.timers.tick(119); await flush(); const count = f.fetches.length; assert.equal(f.player.getTime(), 270);
  pending.push(f.player.seek(280)); t.mock.timers.tick(12); await flush(); assert.equal(f.fetches.length, count);
  t.mock.timers.tick(108); await Promise.all(pending); await flush(); assert.equal(f.fetches.length, count + 1); assert.equal(f.fetches.at(-1).url, '/preview/token4.mp4?start=280.000');
});
test('media error prepares once at actual position and reports only the second failure', async t => {
  const f = fixture(t); await f.load(10); f.video._currentTime = 17;
  f.video.emit('error'); await flush(); assert.equal(f.prepares, 2); assert.equal(f.fetches.at(-1).url, '/preview/token2.mp4?start=27.000'); await f.ready();
  assert.equal(f.player.getTime(), 27); f.video.emit('error'); await flush(); assert.equal(f.prepares, 2); assert.equal(f.errors.length, 1); assert.equal(f.video.paused, true);
});
test('long playback recovers again after the cooldown but a failure inside it ends playback', async t => {
  // 실사고: 로드당 복구가 1번뿐이라, 재생 중 업스트림이 두 번 끊기면 「대체 플레이어를 불러오지 못했습니다」 가 떴다
  const f = fixture(t); await f.load(10);
  let clock = 1_000_000; t.mock.method(Date, 'now', () => clock);
  f.video.emit('error'); await flush(); assert.equal(f.prepares, 2); await f.ready();
  clock += 16_000; f.video.emit('error'); await flush(); assert.equal(f.prepares, 3); assert.equal(f.errors.length, 0); await f.ready();
  clock += 1_000; f.video.emit('error'); await flush(); assert.equal(f.prepares, 3); assert.equal(f.errors.length, 1);
});
test('destroy removes source and ignores late prepare results and timers', async t => {
  let resolve; const f = fixture(t, { prepare: () => new Promise(done => { resolve = done; }) });
  const pending = f.start(); const rejected = assert.rejects(pending, /SUPERSEDED/); f.player.destroy(); resolve({ path: '/preview/late.mp4' }); await rejected; await flush();
  t.mock.timers.tick(16000); assert.equal(f.video.src, ''); assert.equal(f.fetches.length, 0); assert.equal(f.video.listeners.size, 0); assert.deepEqual(f.errors, []); assert.deepEqual(f.times, []);
});
test('ended pauses and reports metadata duration and EOF buffered seek needs no fetch', async t => {
  const f = fixture(t); await f.load(70); await f.player.togglePlay(); await f.push(null);
  assert.equal(f.sources[0].eos, 1); await f.player.seek(72); assert.equal(f.fetches.length, 1);
  f.video.emit('ended'); assert.equal(f.player.getTime(), 1000); assert.equal(f.video.paused, true); assert.equal(f.times.at(-1), 1000);
  t.mock.timers.tick(250); assert.equal(f.times.at(-1), 1000);
});
test('load targets clamp, retain fractional offsets, and exact endpoint avoids empty fetch', async t => {
  const f = fixture(t);
  for (const target of [-5, 0, 10, 29.999, 30, 30.001, 70.1234, 99.5]) {
    await f.load(target, 100); const clamped = Math.max(0, target);
    assert.equal(f.fetches.at(-1).url, `/preview/token${f.prepares === 1 ? '' : f.prepares}.mp4?start=${clamped.toFixed(3)}`);
    assert.equal(f.video.currentTime, 0); assert.equal(f.player.getTime(), clamped);
  }
  const count = f.fetches.length; await f.load(110, 100); assert.equal(f.player.getTime(), 100); assert.equal(f.fetches.length, count);
  await f.dispatch(90); await f.ready(); assert.equal(f.player.getTime(), 90);
});
test('buffering waits 250ms and clears only after covered, aligned readiness', async t => {
  const f = fixture(t); await f.load(); f.setAuto(false); await f.dispatch(70);
  t.mock.timers.tick(249); assert.deepEqual(f.buffering, []); t.mock.timers.tick(1); assert.deepEqual(f.buffering, [true]);
  f.video.readyState = 3; f.video.emit('canplay'); f.video.emit('playing'); assert.deepEqual(f.buffering, [true]);
  f.sources.at(-1).open(); await flush(); f.sb.finish(); await flush(); f.sb.finish([[0, 5]]); await flush();
  assert.deepEqual(f.buffering, [true, false]); assert.equal(f.player.getTime(), 70);
});
test('immediate and buffered seeks never notify buffering even on waiting', async t => {
  const f = fixture(t); await f.load(); f.range([[0, 180]]); await f.player.seek(25); f.video.emit('waiting');
  t.mock.timers.tick(500); assert.deepEqual(f.buffering, []); await f.dispatch(800); await f.ready(); t.mock.timers.tick(500); assert.deepEqual(f.buffering, []);
});
test('error and destroy clear buffering and invalidate delayed notifications', async t => {
  const f = fixture(t); await f.load(); await f.dispatch(80); t.mock.timers.tick(250); assert.deepEqual(f.buffering, [true]);
  f.video.emit('error'); await flush(); assert.deepEqual(f.buffering, [true, false]); t.mock.timers.tick(250); assert.deepEqual(f.buffering, [true, false, true]);
  f.video.emit('error'); await flush(); assert.deepEqual(f.buffering, [true, false, true, false]); assert.equal(f.errors.length, 1);
  f.player.destroy(); const count = f.buffering.length; t.mock.timers.tick(16000); assert.equal(f.buffering.length, count);
});
test('destroy before buffering delay never emits a stale true', async t => {
  const f = fixture(t); await f.load(); await f.dispatch(80); f.player.destroy(); t.mock.timers.tick(16000); assert.deepEqual(f.buffering, []);
});
test('backward seeks inside buffered stream are immediate and preserve source', async t => {
  const f = fixture(t); await f.load(40); f.range([[0, 100]], 30); await f.player.seek(69); assert.equal(f.video.currentTime, 29);
  await f.player.seek(60); assert.equal(f.video.currentTime, 20); assert.equal(f.player.getTime(), 60); t.mock.timers.tick(500); assert.equal(f.fetches.length, 1); assert.deepEqual(f.buffering, []);
});
test('load waits for metadata, coverage, async setter completion and readiness in order', async t => {
  const f = fixture(t, { auto: false }); f.video.delayedSeek = true; f.video.throwBeforeMetadata = true;
  let done = false; const pending = f.start(70).then(() => { done = true; }); await flush();
  f.video.emit('canplay'); f.video.emit('playing'); assert.equal(done, false); assert.equal(f.video.assignments.length, 0);
  f.sources[0].open(); await flush(); f.sb.finish(); await flush(); f.sb.finish([[0, 5]]); await flush();
  assert.equal(done, false); assert.equal(f.video.assignments.length, 0); t.mock.timers.tick(250); assert.deepEqual(f.buffering, [true]);
  f.video.readyState = 1; f.video.emit('loadedmetadata'); assert.equal(f.video.seeking, true); assert.equal(f.player.getTime(), 70);
  f.video.emit('canplay'); f.video.emit('playing'); assert.equal(done, false); assert.equal(f.video.paused, true);
  f.video.completeSeek(); await flush(); assert.equal(done, false); f.video.readyState = 3; f.video.emit('canplay'); await pending;
  assert.equal(done, true); assert.equal(f.player.getTime(), 70); assert.deepEqual(f.buffering, [true, false]);
});
test('seekAndPlay stays paused until ready and honors the latest pause or toggle', async t => {
  const f = fixture(t); await f.load(); await f.player.togglePlay(); f.video.delayedSeek = true;
  let pending = f.player.seekAndPlay(500); t.mock.timers.tick(120); await pending; await flush(); assert.equal(f.video.paused, true);
  await f.player.pause(); await f.ready(); f.video.completeSeek(); await flush(); assert.equal(f.video.paused, true);
  pending = f.player.seekAndPlay(800); t.mock.timers.tick(120); await pending; await f.ready(); assert.equal(f.video.paused, true);
  f.video.completeSeek(); await flush(); assert.equal(f.video.paused, false); assert.equal(f.player.getTime(), 800);
});
test('new seeks replace stale targets and cancellation returns to buffer without reusing aborted reader', async t => {
  const f = fixture(t); await f.load(100); f.range([[0, 180]], 60); f.video.delayedSeek = true;
  const pending = [];
  for (let i = 0; i < 20; i++) { pending.push(f.player.seek(f.player.getTime() + 1)); assert.equal(f.player.getTime(), 161 + i); }
  assert.equal(f.video.currentTime, 60); assert.equal(f.video.seekTarget, 80); assert.equal(f.fetches.length, 1); f.video.completeSeek(); await Promise.all(pending);
  assert.equal(f.video.currentTime, 80); assert.equal(f.player.getTime(), 180);
  const outside = f.player.seek(900); assert.equal(f.fetches[0].signal.aborted, true); const reads = f.fetches[0].reads;
  await f.player.seek(175); await outside; f.video.completeSeek(); t.mock.timers.tick(120); await flush(); assert.equal(f.fetches.length, 1); assert.equal(f.player.getTime(), 175);
  f.video._currentTime = 175; f.video.emit('timeupdate'); await flush(); assert.equal(f.fetches.length, 2); assert.equal(f.fetches[0].reads, reads); assert.equal(f.prepares, 1); assert.deepEqual(f.errors, []);
});
test('errors recover from requested targets, include recovery bursts, and stop on second failure', async t => {
  let resolve; const f = fixture(t, { prepare: (_id, calls) => calls === 2 ? new Promise(done => { resolve = done; }) : { path: '/preview/token.mp4' } });
  await f.load(10); await f.dispatch(80); f.video.emit('error'); await flush(); assert.equal(f.prepares, 2);
  const burst = [f.player.seek(600), f.player.seek(700)]; assert.equal(f.player.getTime(), 700); resolve({ path: '/preview/retry.mp4' }); await flush(); await Promise.all(burst);
  assert.equal(f.fetches.at(-1).url, '/preview/retry.mp4?start=700.000'); await f.ready(); assert.equal(f.player.getTime(), 700);
  f.video.emit('error'); await flush(); assert.equal(f.prepares, 2); assert.equal(f.errors.length, 1); assert.equal(f.errors[0].message, '대체 플레이어를 불러오지 못했습니다');
});
test('superseded loads and destroy invalidate late events timers and pending seeks', async t => {
  const f = fixture(t); const old = f.start(70); const rejected = assert.rejects(old, /SUPERSEDED/); await flush(); const source = f.sources[0];
  const newer = f.start(10); await rejected; await f.ready(); await newer; source.open(); source.emit('sourceclose'); assert.equal(f.player.getTime(), 10);
  const seeks = []; for (let i = 0; i < 20; i++) seeks.push(f.player.seek(f.player.getTime() + 10));
  const replacement = f.start(5); await Promise.all(seeks); await f.ready(); await replacement; assert.equal(f.player.getTime(), 5);
  const base = f.fetches.length; t.mock.timers.tick(120); t.mock.timers.tick(250); await flush(); assert.equal(f.fetches.length, base); assert.equal(f.times.includes(210), false);
  const pending = f.player.seek(800); f.player.destroy(); await pending; const callbacks = [f.times.length, f.errors.length, f.buffering.length];
  f.video.emit('canplay'); source.emit('sourceopen'); t.mock.timers.tick(16000); f.player.destroy();
  assert.equal(f.video.src, ''); assert.deepEqual([f.times.length, f.errors.length, f.buffering.length], callbacks); assert.deepEqual(f.errors, []);
});

test('nested init parser honors split box boundaries, real AVC profile and AVC-only', async t => {
  const f = fixture(t, { split: true, profile: [0x64, 0, 0x33], audio: false }); await f.load();
  assert.equal(f.sources[0].mime, 'video/mp4; codecs="avc1.640033"'); assert.deepEqual(f.MS.checks, [f.sources[0].mime]); assert.equal(f.sb.mode, 'segments'); assert.equal(f.sb.timestampOffset, 0);
  assert.equal(f.fetches[0].maxActive, 1); assert.deepEqual(f.sb.calls[0][1], initBytes({ profile: [0x64, 0, 0x33], audio: false }));
});
test('AAC MIME derives from esds and unsupported MIME recovers once then fails', async t => {
  const f = fixture(t); await f.load(); assert.equal(f.sources[0].mime, 'video/mp4; codecs="avc1.42c01e, mp4a.40.2"');
  f.setSupported(false); const pending = f.start(); await f.ready(); await flush(); await f.ready(); await assert.rejects(pending, /대체 플레이어를 불러오지 못했습니다/);
  assert.equal(f.errors.length, 1); assert.equal(f.MS.checks.length, 3);
});
for (const [name, bytes] of [
  ['truncated', initBytes().subarray(0, 30)], ['malformed box', join(u32(4), textBytes('ftyp'))],
  ['oversized', join(u32(1024 * 1024 + 1), textBytes('moov'))], ['malformed descriptor', initBytes({ badDescriptor: true })],
]) test(`invalid init ${name} has bounded reads and one retry`, async t => {
  const f = fixture(t, { init: bytes }); const pending = f.start(); await flush(); f.fetches[0].push({ done: true }); await flush();
  if (f.fetches[1]) f.fetches[1].push({ done: true }); await flush(); await assert.rejects(pending, /대체 플레이어를 불러오지 못했습니다/);
  assert.equal(f.prepares, 2); assert.equal(f.errors.length, 1); assert.ok(f.fetches.every(request => request.reads <= 3)); assert.ok(f.sources.every(source => source.eos === 0));
});
test('append queue and remove serialize, split large chunk at 256KiB, EOF waits for drain', async t => {
  const f = fixture(t, { auto: false }); const pending = f.start(); await flush(); f.sources[0].open(); await flush();
  assert.equal(f.sb.calls.length, 1); assert.equal(f.fetches[0].reads, 1); assert.equal(f.sources[0].eos, 0);
  f.sb.finish(); await flush(); assert.equal(f.sb.calls.length, 2); f.video.readyState = 3; f.sb.finish([[0, 5]]); await flush(); await pending;
  const bytes = new Uint8Array(600000).fill(7); await f.push(bytes); assert.equal(f.sb.calls.at(-1)[1].length, 256 * 1024);
  const readCount = f.fetches[0].reads; f.fetches[0].push({ done: true }); assert.equal(f.sources[0].eos, 0);
  f.sb.finish(); await flush(); assert.equal(f.sb.calls.at(-1)[1].length, 256 * 1024); assert.equal(f.fetches[0].reads, readCount);
  f.sb.finish(); await flush(); assert.equal(f.sb.calls.at(-1)[1].length, 600000 - 512 * 1024);
  f.sb.finish(); await flush(); assert.equal(f.sources[0].eos, 1); assert.equal(f.fetches[0].maxActive, 1);
});
test('cap stops read at front180, resumes at170, and prunes actual back60 serially', async t => {
  const f = fixture(t); await f.load(); f.range([[40, 280]], 100); await f.push([9]);
  const reads = f.fetches[0].reads; assert.ok(f.sb.calls.some(call => call[0] === 'append'));
  t.mock.timers.tick(250); await flush(); assert.equal(f.fetches[0].reads, reads);
  f.video._currentTime = 109; f.video.emit('timeupdate'); await flush(); assert.equal(f.fetches[0].reads, reads);
  f.video._currentTime = 110; f.video.emit('timeupdate'); await flush(); assert.equal(f.fetches[0].reads, reads + 1);
  f.video._currentTime = 120; await f.push([8]); assert.ok(f.sb.calls.some(call => call[0] === 'remove' && call[1] === 0 && call[2] === 60));
  assert.equal(f.video.paused, true); assert.deepEqual(f.buffering, []);
});
test('range ends and gaps are outside while range starts are covered', async t => {
  const f = fixture(t); await f.load(0); f.range([[0, 20], [30, 50]]);
  const gap = f.player.seek(25); assert.equal(f.fetches[0].signal.aborted, true); assert.equal(f.player.getTime(), 25);
  await f.player.seek(30); await gap; assert.equal(f.video.currentTime, 30); t.mock.timers.tick(120); assert.equal(f.fetches.length, 1);
  const end = f.player.seek(20); t.mock.timers.tick(120); await end; await flush(); assert.equal(f.fetches.at(-1).url, '/preview/token.mp4?start=20.000');
});
test('quota preserves bytes, removes back60, retries once before any new read', async t => {
  const f = fixture(t); await f.load(); f.range([[0, 280]], 100); f.sb.quota = 1; f.setAuto(false);
  await f.push([8, 7, 6]); const sb = f.sb; const readCount = f.fetches[0].reads;
  assert.deepEqual(sb.calls.at(-1), ['remove', 0, 40]); const bytes = sb.attempts.at(-1);
  sb.finish(); await flush(); assert.equal(sb.calls.at(-1)[0], 'append'); assert.deepEqual(sb.calls.at(-1)[1], bytes); assert.equal(f.fetches[0].reads, readCount);
  sb.finish(); await flush(); assert.equal(f.prepares, 1);
});
test('quota retry failure and no removable bytes have finite recovery budget', async t => {
  const f = fixture(t); await f.load(); f.range([[0, 280]], 100); f.sb.quota = 2; await f.push([8]); await flush(); assert.equal(f.prepares, 2); await f.ready();
  f.range([[0, 5]], 0); f.sb.quota = 1; await f.push([9]); assert.equal(f.prepares, 2); assert.equal(f.errors.length, 1); assert.equal(f.video.paused, true);
});
test('async append error followed by updateend cannot finish a load or normal EOS', async t => {
  const f = fixture(t, { auto: false }); let done = false; const pending = f.start().then(() => { done = true; }); pending.catch(() => {});
  await flush(); f.sources[0].open(); await flush(); const sb = f.sb; sb.fail(); await flush(); assert.equal(done, false); assert.equal(f.prepares, 2); assert.equal(f.sources[0].eos, 0);
  f.sources[1].open(); await flush(); f.sb.fail(); await assert.rejects(pending, /대체 플레이어를 불러오지 못했습니다/); assert.equal(done, false); assert.equal(f.errors.length, 1);
});
test('initial AV intersection gap over0.1 fails and small gap aligns honestly', async t => {
  const f = fixture(t, { auto: false }); let pending = f.start(70); await flush(); f.sources[0].open(); await flush(); f.sb.finish(); await flush();
  f.video.readyState = 3; f.sb.videoRanges = [[0.05, 5]]; f.sb.finish([[0, 5]]); f.video.emit('canplay'); await flush(); await pending; assert.equal(f.video.currentTime, 0.05); assert.equal(f.player.getTime(), 70.05);
  pending = f.start(70); await flush(); f.sources.at(-1).open(); await flush(); f.sb.finish(); await flush(); f.sb.videoRanges = [[0.5, 5]]; f.video.readyState = 3; f.sb.finish([[0, 5]]); f.video.emit('canplay'); await flush();
  assert.equal(f.prepares, 3); f.sources.at(-1).open(); await flush(); f.sb.finish(); await flush(); f.sb.videoRanges = [[0.5, 5]]; f.video.readyState = 3; f.sb.finish([[0, 5]]); f.video.emit('canplay'); await flush();
  await assert.rejects(pending, /대체 플레이어를 불러오지 못했습니다/); assert.equal(f.errors.length, 1);
});
test('preparing bursts retain20 targets and timeout includes initial prepare', async t => {
  let resolve; const f = fixture(t, { prepare: () => new Promise(done => { resolve = done; }) }); const pending = f.start(60); await flush();
  const seeks = []; for (let i = 0; i < 20; i++) { seeks.push(f.player.seek(f.player.getTime() + 10)); assert.equal(f.player.getTime(), 70 + i * 10); }
  t.mock.timers.tick(250); assert.equal(f.times.at(-1), 260); resolve({ path: '/preview/token.mp4' }); await flush(); await Promise.all(seeks); assert.equal(f.fetches[0].url, '/preview/token.mp4?start=260.000'); await f.ready(); await pending;
  const timeout = f.start(); t.mock.timers.tick(14999); assert.equal(f.errors.length, 0); t.mock.timers.tick(1); await assert.rejects(timeout, /대체 플레이어를 불러오지 못했습니다/); assert.equal(f.errors.length, 1);
});
for (const scenario of ['prepare', 'HTTP', 'body', 'read']) test(`${scenario} failure has exact Korean surface and correct retry budget`, async t => {
  const options = scenario === 'prepare' ? { prepare: () => { throw new Error('secret'); } }
    : scenario === 'HTTP' ? { fetch: () => Promise.resolve({ ok: false, body: {} }) }
      : scenario === 'body' ? { fetch: () => Promise.resolve({ ok: true, body: null }) }
        : { fetch: (request, response) => { request.queue = [new Error('read failed')]; return Promise.resolve(response); } };
  const f = fixture(t, options); const pending = f.start(); await flush(); await assert.rejects(pending, /^Error: 대체 플레이어를 불러오지 못했습니다$/);
  assert.equal(f.prepares, scenario === 'prepare' ? 1 : 2); assert.equal(f.errors.length, 1); assert.equal(f.video.paused, true); assert.deepEqual(f.buffering, []); assert.ok(f.sources.every(source => source.eos === 0));
});
test('late response after abort cancels its body and never acquires a reader', async t => {
  let resolve; const f = fixture(t, { fetch: (_request, response) => new Promise(done => { resolve = () => done(response); }) }); const pending = f.start(); await flush();
  f.player.destroy(); resolve(); await flush(); await assert.rejects(pending, /SUPERSEDED/); assert.equal(f.fetches[0].bodyCancelled, true); assert.equal(f.fetches[0].reads, 0);
});
test('20 reloads leave no live URL reader listeners or callbacks and destroy twice is safe', async t => {
  const f = fixture(t); for (let i = 0; i < 20; i++) { await f.load(i); assert.equal(f.live.size, 1); }
  f.player.destroy(); const revokeCount = f.revoked.length; f.player.destroy(); assert.equal(revokeCount, 20); assert.equal(f.revoked.length, 20); assert.equal(f.live.size, 0);
  await flush(); assert.ok(f.fetches.every(request => request.cancels === 1 && request.active === 0));
  const counts = [f.times.length, f.errors.length, f.buffering.length]; t.mock.timers.tick(16000); assert.deepEqual([f.times.length, f.errors.length, f.buffering.length], counts);
});
test('endpoint cancels a pending prepare without late fetch and can seek backwards afterwards', async t => {
  const resolvers = []; const f = fixture(t, { prepare: () => new Promise(resolve => resolvers.push(resolve)) });
  const pending = f.start(60, 100); await flush(); await f.player.seek(100); await pending;
  resolvers[0]({ path: '/preview/stale.mp4' }); await flush(); assert.equal(f.fetches.length, 0); assert.equal(f.player.getTime(), 100);
  const back = f.player.seek(50); t.mock.timers.tick(120); await back; await flush(); resolvers[1]({ path: '/preview/fresh.mp4' }); await flush(); await f.ready();
  assert.equal(f.fetches[0].url, '/preview/fresh.mp4?start=50.000'); assert.equal(f.player.getTime(), 50); assert.deepEqual(f.errors, []);
});
test('endpoint cancels the aborted stream readiness timeout and emits no later recovery', async t => {
  const f = fixture(t); await f.load(); await f.dispatch(900); await f.player.seek(1000); t.mock.timers.tick(16000); await flush();
  assert.equal(f.player.getTime(), 1000); assert.equal(f.prepares, 1); assert.equal(f.fetches.length, 2); assert.deepEqual(f.errors, []);
});
test('replacement readiness timeout after a completed load recovers once then fails', async t => {
  const f = fixture(t); await f.load(); await f.dispatch(900); t.mock.timers.tick(15000); await flush(); assert.equal(f.prepares, 2); assert.equal(f.player.getTime(), 900);
  t.mock.timers.tick(15000); await flush(); assert.equal(f.prepares, 2); assert.equal(f.errors.length, 1); assert.equal(f.video.paused, true); assert.equal(f.buffering.at(-1), false);
});
test('buffered delayed setters accumulate ten +10 seeks with no fetch or debounce', async t => {
  const f = fixture(t); await f.load(100); f.range([[0, 180]], 60); f.video.delayedSeek = true;
  const promises = []; for (let i = 0; i < 10; i++) { promises.push(f.player.seek(f.player.getTime() + 10)); assert.equal(f.player.getTime(), 170 + i * 10); }
  assert.equal(f.video.seekTarget, 160); assert.equal(f.fetches.length, 1); assert.equal(f.video.assignments.length, 11);
  t.mock.timers.tick(250); assert.equal(f.times.at(-1), 260); assert.equal(f.fetches.length, 1); assert.deepEqual(f.buffering, []);
  f.video.completeSeek(); await Promise.all(promises); assert.equal(f.video.currentTime, 160); assert.equal(f.player.getTime(), 260);
});
test('duplicate video and SourceBuffer errors share one pending prepare recovery', async t => {
  let resolve; const f = fixture(t, { prepare: (_id, calls) => calls === 2 ? new Promise(done => { resolve = done; }) : { path: '/preview/token.mp4' } });
  await f.load(); const sb = f.sb; f.video.emit('error'); sb.emit('error'); f.video.emit('error'); await flush(); assert.equal(f.prepares, 2); assert.deepEqual(f.errors, []);
  resolve({ path: '/preview/retry.mp4' }); await f.ready(); assert.equal(f.player.getTime(), 10); assert.deepEqual(f.errors, []);
});
test('video events from an old currentSrc cannot recover or align the new stream', async t => {
  const f = fixture(t); await f.load(70); const oldURL = f.video.src; await f.dispatch(800);
  f.video.currentSrc = oldURL; await f.ready(); f.video.emit('error'); f.video.emit('ended'); await flush();
  assert.equal(f.prepares, 1); assert.equal(f.player.getTime(), 800); assert.equal(f.video.assignments.at(-1), 0); assert.deepEqual(f.errors, []);
  f.video.currentSrc = f.video.src; f.video.emit('canplay'); await flush(); assert.equal(f.player.getTime(), 800);
});
test('returning to a covered target cancels buffering even while its setter is delayed', async t => {
  const f = fixture(t); await f.load(); f.video.delayedSeek = true; await f.dispatch(800);
  t.mock.timers.tick(250); assert.deepEqual(f.buffering, [true]); await f.ready(); assert.equal(f.video.seeking, true);
  await f.player.seek(801); assert.deepEqual(f.buffering, [true, false]); assert.equal(f.player.getTime(), 801); assert.equal(f.fetches.length, 2);
  f.video.completeSeek(); await flush(); assert.equal(f.player.getTime(), 801); assert.equal(f.video.currentTime, 1);
});
for (const stage of ['sourceopen', 'read', 'append', 'remove', 'cap']) test(`destroy while ${stage} settles load and owns all cleanup`, async t => {
  const f = fixture(t); const pending = f.start(); await flush();
  if (stage !== 'sourceopen') { await f.ready(); await pending; }
  f.setAuto(false);
  if (stage === 'append') await f.push([7]);
  if (stage === 'remove' || stage === 'cap') { f.range(stage === 'cap' ? [[40, 280]] : [[0, 280]], 100); await f.push([8]); }
  f.player.destroy(); if (stage === 'sourceopen') await assert.rejects(pending, /SUPERSEDED/);
  await flush(); assert.equal(f.live.size, 0); assert.equal(f.fetches[0].signal.aborted, true); assert.equal(f.fetches[0].active, 0); assert.equal(f.sources[0].eos, 0); assert.deepEqual(f.errors, []);
});
