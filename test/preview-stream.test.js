import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { ServerResponse } from 'node:http';
import { setMaxListeners } from 'node:events';
import { createPreviewStream, createRangeInputProxy, selectPreviewStreams, validVideoId, validToken, parseStart, parseUrls, buildPreviewArgs } from '../lib/preview-stream.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const id = 'Abcdef12_-3', token = 'a'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(platform = 'linux', rangeProxyFactory = async () => { throw new Error('Range unsupported'); }) {
  const calls = [], timers = [];
  let time = 0, binary = 'fake-ffmpeg', tokenIndex = 0;
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = 0; child.kill = () => { child.killed++; };
    calls.push({ file, args, options, child });
    return child;
  };
  const preview = createPreviewStream({ spawnImpl, platform, rangeProxyFactory, now: () => time,
    randomBytesImpl: size => { assert.equal(size, 16); const value = tokenIndex++ === 0 ? token : tokenIndex.toString(16).padStart(32, '0'); return Buffer.from(value, 'hex'); },
    getYtdlpPath: async () => 'effective-ytdlp', getFfmpegPath: () => binary,
    setTimeoutImpl: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeoutImpl: timer => { if (timer) timer.cleared = true; },
  });
  const resolve = async (output = 'https://media.test/video\nhttps://media.test/audio\n', code = 0) => {
    await tick(); const child = calls.at(-1).child;
    child.stdout.write(output); child.emit('close', code); await tick();
  };
  const prepare = async () => { const pending = preview.prepare(id); await resolve(); return pending; };
  function response(method = 'GET') {
    const req = new EventEmitter(); req.method = method; req.complete = true;
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    return { req, res, body: () => Buffer.concat(chunks).toString() };
  }
  return { preview, calls, timers, resolve, prepare, response, age: value => { time = value; }, binary: value => { binary = value; } };
}

test('validates video IDs, tokens and start boundaries', async () => {
  assert.equal(validVideoId(id), true);
  for (const value of ['', 'a'.repeat(10), 'a'.repeat(12), 'a'.repeat(10) + '/', null]) assert.equal(validVideoId(value), false);
  assert.equal(validToken(token), true);
  for (const value of ['A'.repeat(32), 'a'.repeat(31), '../x', null]) assert.equal(validToken(value), false);
  for (const value of ['-1', '1e3', '86400', '12.3456', '', '1000000']) assert.throws(() => parseStart(value));
  assert.equal(parseStart(), '0'); assert.equal(parseStart('86399.999'), '86399.999');
  const h = harness();
  await assert.rejects(h.preview.prepare('bad'), { code: 'INVALID_VIDEO_ID' });
  const bad = h.response(); h.preview.serve(bad.req, bad.res, token); assert.equal(bad.res.status, 404);
  await h.prepare();
  const invalid = h.response(); h.preview.serve(invalid.req, invalid.res, token, '-1'); assert.equal(invalid.res.status, 400);
  h.preview.close();
});

test('builds exact one-input and two-input ffmpeg argv', () => {
  const tail = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const prefix = ['-hide_banner', '-loglevel', 'error', '-probesize', '64k', '-analyzeduration', '0', '-ss', '12.345', '-i', 'https://v.test/'];
  assert.deepEqual(buildPreviewArgs(['https://v.test/'], '12.345'), [...prefix, '-map', '0:v:0', '-map', '0:a:0?', ...tail]);
  assert.deepEqual(buildPreviewArgs(['https://v.test/', 'https://a.test/'], '12.345'), [...prefix, '-ss', '12.345', '-i', 'https://a.test/', '-map', '0:v:0', '-map', '1:a:0', ...tail]);
});

const videoFormat = (height = 360, tbr = 100, url = 'https://v.googlevideo.com/video') => ({ protocol: 'https', vcodec: 'avc1.4d', acodec: 'none', height, tbr, url });
const audioFormat = (abr = 128, url = 'https://googlevideo.com/audio') => ({ protocol: 'https', vcodec: 'none', acodec: 'mp4a.40', abr, url });
test('selects AVC height then highest tbr and highest AAC abr without mutating formats', () => {
  const formats = [videoFormat(360, 900), videoFormat(480, 100), videoFormat(480, 200, 'https://v.googlevideo.com/best'), videoFormat(720, 999), audioFormat(64), audioFormat(192, 'https://a.googlevideo.com/best')];
  const before = structuredClone(formats);
  assert.deepEqual(selectPreviewStreams(formats), { video: formats[2].url, audio: formats[5].url });
  assert.deepEqual(selectPreviewStreams(formats, 360), { video: formats[0].url, audio: formats[5].url });
  assert.deepEqual(selectPreviewStreams(formats, 720), { video: formats[3].url, audio: formats[5].url });
  for (const cap of [null, 481, '480', NaN]) assert.equal(selectPreviewStreams(formats, cap), null);
  assert.deepEqual(formats, before);
});
test('excludes HLS, non-HTTPS, deceptive hosts and incompatible codecs', () => {
  for (const override of [{ protocol: 'm3u8' }, { protocol: 'm3u8_native' }, { url: 'http://v.googlevideo.com/x' }, { url: 'https://googlevideo.com.evil.test/x' }, { url: 'https://evilgooglevideo.com/x' }, { url: 'https://user@googlevideo.com/x' }, { url: 'invalid' }, { vcodec: 'vp9' }, { height: 481 }]) {
    assert.equal(selectPreviewStreams([{ ...videoFormat(), ...override }, audioFormat()]), null);
  }
  assert.equal(selectPreviewStreams([videoFormat(), { ...audioFormat(), acodec: 'opus' }]), null);
});
test('preview selector rejects invalid heights and never exceeds the requested cap', () => {
  for (const height of [0, -1, Infinity, NaN, 481, '480']) assert.equal(selectPreviewStreams([videoFormat(height), audioFormat()]), null);
  assert.equal(selectPreviewStreams([videoFormat(720), audioFormat()], 360), null);
  const formats = [videoFormat(360, 900), videoFormat(480, 100), audioFormat()];
  assert.equal(selectPreviewStreams(formats).video, formats[1].url);
});
test('selects muxed only when neither separate candidate exists, otherwise returns null', () => {
  const muxed = { ...videoFormat(480), acodec: 'mp4a.40' };
  assert.deepEqual(selectPreviewStreams([muxed]), { muxed: muxed.url });
  assert.equal(selectPreviewStreams([muxed, videoFormat()]), null);
  assert.equal(selectPreviewStreams([muxed, audioFormat()]), null);
  for (const formats of [undefined, null, {}, [], [null], [videoFormat()], [audioFormat()]]) assert.equal(selectPreviewStreams(formats), null);
});
test('prepare selects cached formats per cap with private URLs and reuses the token', async () => {
  for (const formats of [[videoFormat(), audioFormat()], [{ ...videoFormat(), acodec: 'mp4a.40' }]]) {
    const h = harness(); h.preview.cacheFormats(id, formats); h.age(1799999);
    const prepared = await h.preview.prepare(id);
    assert.deepEqual(prepared, { path: `/preview/${token}.mp4` });
    assert.deepEqual(await h.preview.prepare(id), prepared); assert.equal(h.calls.length, 0);
    const r = h.response(); h.preview.serve(r.req, r.res, token); await tick();
    assert.equal(h.calls[0].file, 'fake-ffmpeg');
    h.preview.close();
  }
});
test('cached formats are copied and independently prepared for each resolution cap', async () => {
  const h = harness();
  const formats = [videoFormat(360, 900), videoFormat(480, 100, 'https://v.googlevideo.com/480'), videoFormat(720, 200, 'https://v.googlevideo.com/720'), audioFormat()];
  h.preview.cacheFormats(id, formats); formats[2].url = 'https://evil.test/changed'; formats.push(null);
  const paths = [];
  for (const cap of [480, 720, 360]) paths.push((await h.preview.prepare(id, cap)).path);
  assert.equal(h.calls.length, 0); assert.equal(new Set(paths).size, 3);
  for (const cap of [480, 720, 360]) assert.equal((await h.preview.prepare(id, cap)).path, paths[[480, 720, 360].indexOf(cap)]);
  for (const cap of [null, 481, '480', NaN]) await assert.rejects(h.preview.prepare(id, cap), { code: 'INVALID_PREVIEW_RESOLUTION' });
  h.preview.close();
});
test('formats revision invalidates prepared reuse and prevents stale pending ownership', async () => {
  const h = harness();
  const pending = h.preview.prepare(id); await tick();
  h.preview.cacheFormats(id, [videoFormat(360, 20, 'https://v.googlevideo.com/new'), audioFormat()]);
  const newer = await h.preview.prepare(id);
  await h.resolve(); await pending;
  assert.equal(newer.path, (await h.preview.prepare(id)).path);
  const r = h.response(); h.preview.serve(r.req, r.res, newer.path.match(/[0-9a-f]{32}/)[0]); await tick();
  assert.ok(h.calls.at(-1).args.includes('https://v.googlevideo.com/new'));
  h.preview.close();
});
test('missing, null and expired metadata cache fall back to yt-dlp -g', async () => {
  for (const mode of ['missing', 'null', 'expired']) {
    const h = harness();
    if (mode !== 'missing') h.preview.cacheFormats(id, mode === 'null' ? null : [videoFormat(), audioFormat()]);
    if (mode === 'expired') h.age(1800000);
    await h.prepare(); assert.equal(h.calls[0].file, 'effective-ytdlp'); assert.ok(h.calls[0].args.includes('-g')); h.preview.close();
  }
});
test('blocked metadata URL refreshes once via -g even before cache ages', async () => {
  const h = harness(); h.preview.cacheFormats(id, [{ ...videoFormat(), acodec: 'mp4a.40' }]); await h.preview.prepare(id);
  const r = h.response(); h.preview.serve(r.req, r.res, token); await tick();
  h.calls[0].child.emit('close', 1); await tick(); assert.equal(h.calls[1].file, 'effective-ytdlp');
  await h.resolve('https://fresh.googlevideo.com/video\n');
  assert.equal(h.calls[2].file, 'fake-ffmpeg'); assert.ok(h.calls[2].args.includes('https://fresh.googlevideo.com/video'));
  h.calls[2].child.emit('close', 1); await tick(); assert.equal(r.res.status, 502);
  assert.equal(h.calls.filter(c => c.file === 'effective-ytdlp' && c.args.includes('-g')).length, 1); h.preview.close();
});
test('main metadata handler returns only video and populates preview cache without Electron', async () => {
  const source = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf("  handle('video:metadata'"), source.indexOf("  handle('queue:add'"));
  const h = harness(), metadataCache = new Map();
  const video = { url: `https://www.youtube.com/watch?v=${id}`, videoId: id, title: 'title', durationSec: 12 };
  let handler;
  vm.runInNewContext(block, { handle: (channel, callback) => { handler = callback; }, URL, structuredClone,
    normalizeYouTubeUrl: value => value, invalid: (code, message) => Object.assign(new Error(message), { code }),
    executionSettings: async () => ({ previewResolution: 720 }), runner: { metadataWithStreams: async (url, settings) => {
      assert.equal(settings.previewResolution, 720);
      return { video, streams: { muxed: videoFormat().url }, formats: [360, 480, 720].map(height => ({ ...videoFormat(height), acodec: 'mp4a.40' })) };
    } },
    metadataCache, preview: h.preview });
  const result = await handler({ url: video.url, requestId: 'request' });
  assert.deepEqual(Object.keys(result).sort(), ['requestId', 'video']); assert.deepEqual(result.video, video);
  assert.deepEqual(metadataCache.get(id), video);
  assert.doesNotMatch(JSON.stringify(result), /googlevideo|formats|streams/);
  for (const height of [480, 720, 360]) await h.preview.prepare(id, height);
  assert.equal(h.calls.length, 0); h.preview.close();
});

test('parses yt-dlp URL output, uses effective binary, bounds output and timeout', async () => {
  assert.deepEqual(parseUrls('https://v.test/\r\nhttps://a.test/\r\n'), ['https://v.test/', 'https://a.test/']);
  assert.deepEqual(parseUrls('https://v.test/\n'), ['https://v.test/']);
  for (const value of ['', 'http://v.test/', 'file:///x', 'https://v.test/\n\nhttps://a.test/', 'https://v.test/\nhttps://a.test/\nhttps://b.test/']) assert.throws(() => parseUrls(value));
  const h = harness(); await h.prepare();
  assert.deepEqual(h.calls[0], { ...h.calls[0], file: 'effective-ytdlp', args: ['--ignore-config', '--no-playlist', '--encoding', 'utf-8', '-g', '-f', 'bv*[height<=480][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=480][vcodec^=avc1][acodec^=mp4a]', '--', `https://www.youtube.com/watch?v=${id}`], options: { shell: false, windowsHide: true } });
  assert.equal(h.timers[0].delay, 45000); assert.equal(h.timers[0].cleared, true);
  assert.deepEqual(await h.preview.prepare(id), { path: `/preview/${token}.mp4` }); assert.equal(h.calls.length, 1);
  h.preview.close();
  for (const mode of ['limit', 'timeout', 'invalid']) {
    const f = harness(); const pending = f.preview.prepare(id); const rejected = assert.rejects(pending, { code: 'PREVIEW_UNAVAILABLE' });
    await tick();
    if (mode === 'limit') f.calls[0].child.stdout.write(Buffer.alloc(65537));
    else if (mode === 'timeout') f.timers[0].fn();
    else { f.calls[0].child.stdout.write('http://secret.test/'); f.calls[0].child.emit('close', 0); }
    await rejected; f.preview.close();
  }
});

test('streams unchanged bytes with media headers and current ffmpeg setting', async () => {
  const h = harness(); await h.prepare(); h.binary('new-ffmpeg');
  const r = h.response(); h.preview.serve(r.req, r.res, token, '2.5'); await tick();
  const call = h.calls.at(-1);
  assert.equal(call.file, 'new-ffmpeg'); assert.deepEqual(call.options, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  call.child.stdout.write('fragment-a'); call.child.stdout.end('fragment-b'); await tick(); call.child.emit('close', 0); await tick();
  assert.equal(r.res.status, 200); assert.equal(r.body(), 'fragment-afragment-b');
  assert.equal(r.res.headers['Content-Type'], 'video/mp4'); assert.equal(r.res.headers['Cache-Control'], 'no-store');
  assert.equal(Object.keys(r.res.headers).some(key => key.toLowerCase() === 'accept-ranges'), false);
  assert.equal(call.child.killed, 1); h.preview.close();
});

test('disconnect, replacement request, new video and app close kill active children', async () => {
  const h = harness(); await h.prepare();
  const first = h.response(); h.preview.serve(first.req, first.res, token); await tick(); const child1 = h.calls.at(-1).child;
  const second = h.response(); h.preview.serve(second.req, second.res, token); assert.equal(child1.killed, 1); await tick();
  const child2 = h.calls.at(-1).child; second.req.emit('close'); assert.equal(child2.killed, 0);
  second.res.emit('close'); assert.equal(child2.killed, 1);
  const third = h.response(); h.preview.serve(third.req, third.res, token); await tick(); const child3 = h.calls.at(-1).child;
  const pending = h.preview.prepare('abcdefghijk'); assert.equal(child3.killed, 1); await h.resolve(); await pending;
  const fourth = h.response(); h.preview.serve(fourth.req, fourth.res, token); await tick(); const child4 = h.calls.at(-1).child;
  h.preview.close(); assert.equal(child4.killed, 1);
  const win = harness('win32'); await win.prepare();
  const wr = win.response(); win.preview.serve(wr.req, wr.res, token); await tick();
  const wc = win.calls.at(-1).child; wc.pid = 42; wr.req.emit('aborted');
  const killer = win.calls.at(-1);
  assert.equal(killer.file, 'taskkill'); assert.deepEqual(killer.args, ['/PID', '42', '/T', '/F']);
  assert.deepEqual(killer.options, { shell: false, windowsHide: true });
  killer.child.emit('close', 1); assert.equal(wc.killed, 1); win.preview.close();
});

test('pre-byte failure returns sanitized 502 and old cache refreshes only once', async () => {
  for (const age of [0, 600000]) {
    const h = harness(); await h.prepare(); h.age(age);
    const r = h.response(); h.preview.serve(r.req, r.res, token); await tick();
    const first = h.calls.at(-1).child; first.stderr.write('secret URL'); first.emit('close', 1); await tick();
    if (age) {
      assert.equal(h.calls.at(-1).file, 'effective-ytdlp');
      await h.resolve('https://fresh.test/\n');
      const retry = h.calls.at(-1).child; assert.equal(h.calls.at(-1).file, 'fake-ffmpeg');
      assert.ok(h.calls.at(-1).args.includes('https://fresh.test/')); retry.emit('close', 1); await tick();
      assert.equal(h.calls.filter(call => call.file === 'effective-ytdlp').length, 2);
    }
    assert.equal(r.res.status, 502); assert.equal(r.body(), ''); h.preview.close();
  }
});

function sessionProxy(count = 2) {
  const listeners = new Set();
  const p = { inputUrls: Array.from({ length: count }, (_, i) => `http://127.0.0.1:43123/${token}/${i}`), closes: 0,
    close() { p.closes++; }, onFailure(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    fail() { for (const fn of [...listeners]) fn(new Error('private signed URL')); }, listeners };
  return p;
}
test('range session replaces only inputs and preserves exact start and output argv', async () => {
  for (const count of [1, 2]) {
    const p = sessionProxy(count); let input;
    const h = harness('linux', async value => { input = value; return p; });
    const pending = h.preview.prepare(id); await h.resolve(count === 1 ? 'https://media.test/video\n' : undefined); await pending;
    const r = h.response(); h.preview.serve(r.req, r.res, token, '12.345'); await tick();
    const expected = buildPreviewArgs(input.urls, '12.345');
    expected.forEach((value, index) => { if (expected[index - 1] === '-i') expected[index] = p.inputUrls[input.urls.indexOf(value)]; });
    assert.deepEqual(h.calls.at(-1).args, expected);
    assert.deepEqual(input.urls, count === 1 ? ['https://media.test/video'] : ['https://media.test/video', 'https://media.test/audio']);
    assert.throws(() => buildPreviewArgs(['http://127.0.0.1:43123/x'], '0'));
    h.calls.at(-1).child.stdout.write('a'); h.calls.at(-1).child.emit('close', 0); await tick();
    assert.equal(p.closes, 1); assert.equal(input.signal.aborted, true); assert.equal(p.listeners.size, 0); h.preview.close();
  }
});
test('range open rejection launches direct once with unchanged bytes and sanitized failure', async () => {
  for (const reason of ['200', '416', 'timeout']) {
    let opens = 0;
    const h = harness('linux', async () => { opens++; throw new Error(reason); }); await h.prepare();
    const r = h.response(); h.preview.serve(r.req, r.res, token, '2.5'); await tick();
    const call = h.calls.at(-1); assert.deepEqual(call.args, buildPreviewArgs(['https://media.test/video', 'https://media.test/audio'], '2.5'));
    call.child.stdout.write('fragment-a'); call.child.stdout.write('fragment-b'); call.child.emit('close', 0); await tick();
    assert.equal(r.body(), 'fragment-afragment-b'); assert.equal(r.res.status, 200);
    assert.equal(r.res.headers['Content-Type'], 'video/mp4'); assert.equal(r.res.headers['Cache-Control'], 'no-store');
    assert.equal(opens, 1); assert.equal(h.calls.length, 2); h.preview.close();
    const f = harness('linux', async () => { throw new Error(reason); }); await f.prepare();
    const bad = f.response(); f.preview.serve(bad.req, bad.res, token); await tick(); f.calls.at(-1).child.emit('close', 1); await tick();
    assert.equal(bad.res.status, 502); assert.equal(bad.body(), ''); assert.equal(f.calls.length, 2); f.preview.close();
  }
});
test('range seek cancels pending open and closes late proxies without stale launches', async () => {
  for (const lateReject of [false, true]) {
    const pending = []; const p = sessionProxy();
    const h = harness('linux', value => new Promise((resolve, reject) => pending.push({ ...value, resolve, reject })));
    await h.prepare(); const first = h.response(); h.preview.serve(first.req, first.res, token, '0'); await tick();
    const second = h.response(); h.preview.serve(second.req, second.res, token, '12.345');
    assert.equal(pending[0].signal.aborted, true); await tick();
    if (lateReject) pending[0].reject(Object.assign(new Error('cancel'), { name: 'AbortError' })); else pending[0].resolve(p);
    await tick(); assert.equal(p.closes, lateReject ? 0 : 1); assert.equal(h.calls.length, 1); assert.equal(first.res.status, undefined);
    const next = sessionProxy(); pending[1].resolve(next); await tick(); const child = h.calls.at(-1).child;
    h.preview.stop(); assert.equal(pending[1].signal.aborted, true); assert.equal(next.closes, 1); assert.equal(child.killed, 1);
    child.stdout.write('late'); child.emit('close', 1); child.emit('error', new Error('late')); next.fail(); await tick();
    assert.equal(second.body(), ''); assert.equal(second.res.status, undefined); assert.equal(h.calls.length, 2); h.preview.close();
  }
});
test('range lifecycle preserves normal request close and aborts all termination paths once', async () => {
  for (const mode of ['aborted', 'close', 'video', 'app', 'finish']) {
    const p = sessionProxy(); let signal;
    const h = harness('linux', async value => { signal = value.signal; return p; }); await h.prepare();
    const r = h.response(); h.preview.serve(r.req, r.res, token); await tick(); const child = h.calls.at(-1).child;
    r.req.emit('close'); assert.equal(signal.aborted, false); assert.equal(child.killed, 0);
    const originalClose = p.close; p.close = () => { assert.equal(signal.aborted, true); originalClose(); };
    if (mode === 'aborted') r.req.emit('aborted');
    if (mode === 'close') r.res.emit('close');
    if (mode === 'app') h.preview.close();
    if (mode === 'finish') { child.stdout.write('a'); child.emit('close', 0); await tick(); }
    if (mode === 'video') { const prepared = h.preview.prepare('abcdefghijk'); assert.equal(signal.aborted, true); await h.resolve(); await prepared; }
    assert.equal(signal.aborted, true); assert.equal(p.closes, 1); assert.equal(child.killed, 1);
    r.res.emit('close'); h.preview.stop(); h.preview.close(); assert.equal(p.closes, 1);
  }
});
test('range post-open errors never append a new MP4 or launch direct', async () => {
  for (const mode of ['before', 'proxy-after', 'child-after', 'sync']) {
    const p = sessionProxy(); let opens = 0;
    if (mode === 'sync') p.onFailure = fn => { fn(new Error('already failed')); return () => {}; };
    const h = harness('linux', async () => { opens++; return p; }); await h.prepare();
    const r = h.response(); h.preview.serve(r.req, r.res, token); await tick();
    const child = mode === 'sync' ? null : h.calls.at(-1).child;
    if (mode.includes('after')) child.stdout.write('fragment-a');
    if (mode === 'child-after') child.emit('close', 1); else if (mode !== 'sync') p.fail();
    p.fail(); await tick();
    assert.equal(opens, 1); assert.equal(h.calls.length, mode === 'sync' ? 1 : 2); assert.equal(p.closes, 1);
    if (mode.includes('after')) { assert.equal(r.res.destroyed, true); assert.equal(r.body(), 'fragment-a'); }
    else { assert.equal(r.res.status, 502); assert.equal(r.body(), ''); }
    child?.stdout.write('stale'); child?.emit('error', new Error('stale')); assert.equal(r.body().includes('stale'), false); h.preview.close();
  }
});
test('range fallback and URL refresh have independent budgets and cancelled refresh cannot launch', async () => {
  for (const mode of ['direct', 'proxy', 'cancel']) {
    const p = sessionProxy(1); let opens = 0;
    const h = harness('linux', async () => { opens++; if (mode === 'direct' || opens === 2) throw new Error('200'); return p; });
  h.preview.cacheFormats(id, [{ ...videoFormat(), acodec: 'mp4a.40' }]); await h.preview.prepare(id);
    const r = h.response(); h.preview.serve(r.req, r.res, token); await tick();
    const old = h.calls.at(-1).child; old.stderr.write('signed URL secret'); old.emit('close', 1); old.emit('error', new Error('duplicate')); await tick();
    assert.equal(h.calls.at(-1).file, 'effective-ytdlp');
    if (mode === 'cancel') h.preview.stop();
    await h.resolve('https://fresh.googlevideo.com/video\n');
    if (mode === 'cancel') { assert.equal(opens, 1); assert.equal(h.calls.length, 2); assert.equal(r.res.status, undefined); }
    else {
      assert.equal(opens, mode === 'direct' ? 1 : 2); assert.equal(h.calls.length, 3);
      assert.deepEqual(h.calls.at(-1).args, buildPreviewArgs(['https://fresh.googlevideo.com/video'], '0'));
      h.calls.at(-1).child.emit('close', 1); await tick(); assert.equal(r.res.status, 502); assert.equal(r.body(), ''); assert.equal(h.calls.length, 3);
    }
    h.preview.close();
  }
});

function rangeFixture({ size = 20_000_003, urls, responseMode = () => 'ok', blockSize = 65_536 } = {}) {
  const calls = [], timers = [], active = new Set(), events = new EventEmitter(); let maxActive = 0, closed = false;
  const media = urls || ['https://v.googlevideo.com/video'];
  const body = (start, end, call) => {
    let pos = start;
    return new ReadableStream({
      pull(controller) {
        call.pulls++;
        if (pos > end) { controller.close(); active.delete(call); return; }
        const n = Math.min(blockSize, end - pos + 1), bytes = new Uint8Array(n);
        for (let i = 0; i < n; i++) bytes[i] = (pos + i) % 251;
        controller.enqueue(bytes); pos += n; events.emit('pull', call);
      },
      cancel() { call.cancelled++; active.delete(call); }
    }, { highWaterMark: 0 });
  };
  const fetchImpl = async (url, init) => {
    const range = init.headers.Range, match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    const index = media.indexOf(url); const probe = range === 'bytes=0-0';
    const call = { url, range, probe, index, signal: init.signal, cancelled: 0, pulls: 0 }; calls.push(call); events.emit('call', call);
    assert.equal(init.redirect, 'manual'); assert.equal(init.headers['Accept-Encoding'], 'identity');
    if (!probe) { assert.equal([...active].some(c => c.index === index), false); active.add(call); maxActive = Math.max(maxActive, active.size); }
    init.signal.addEventListener('abort', () => active.delete(call), { once: true });
    let start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : size - 1;
    const mode = responseMode(call, calls.length);
    let status = 206, contentRange = `bytes ${start}-${end}/${size}`, length = end - start + 1, encoding = 'identity';
    if (mode === '200') { status = 200; contentRange = null; }
    if (mode === 'wrong-start') contentRange = `bytes ${start + 1}-${probe ? end + 1 : end}/${size}`;
    if (mode === 'wrong-end') contentRange = `bytes ${start}-${end - 1}/${size}`;
    if (mode === 'wrong-total') contentRange = `bytes ${start}-${end}/${size + 1}`;
    if (mode === 'wrong-length') length--;
    if (mode === 'gzip') encoding = 'gzip';
    if (mode === '416') status = 416;
    let stream = body(start, end, call);
    if (mode === '200' && probe) stream = body(0, 2, call);
    if (mode === 'short') stream = body(start, Math.max(start - 1, end - 1), call);
    if (mode === 'long') stream = body(start, end + 1, call);
    if (mode === 'throw') stream = new ReadableStream({ pull() { active.delete(call); throw new Error('reader failed'); } });
    // 업스트림이 응답 도중 연결을 끊는 경우(ECONNRESET): 블록 하나를 보낸 뒤 읽기 오류
    if (mode === 'reset-mid') {
      let sent = false;
      stream = new ReadableStream({
        pull(controller) {
          if (sent) { active.delete(call); throw new Error('read ECONNRESET'); }
          sent = true;
          const n = Math.min(blockSize, end - start + 1), bytes = new Uint8Array(n);
          for (let i = 0; i < n; i++) bytes[i] = (start + i) % 251;
          controller.enqueue(bytes);
        }
      }, { highWaterMark: 0 });
    }
    if (mode === 'pending') stream = new ReadableStream({ start(controller) { call.controller = controller; }, cancel() { call.cancelled++; active.delete(call); } });
    const headers = new Headers();
    if (contentRange) headers.set('content-range', contentRange);
    if (length != null) headers.set('content-length', String(length));
    if (encoding) headers.set('content-encoding', encoding);
    if (init.signal) setMaxListeners(0, init.signal);
    return { status, headers, body: stream };
  };
  const setTimeoutImpl = (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; };
  const clearTimeoutImpl = timer => { if (timer) timer.cleared = true; };
  return { calls, timers, events, fetchImpl, setTimeoutImpl, clearTimeoutImpl, get maxActive() { return maxActive; },
    waitCall(predicate) { return calls.some(predicate) ? Promise.resolve(calls.find(predicate)) : new Promise(resolve => { const listener = c => { if (predicate(c)) { events.off('call', listener); resolve(c); } }; events.on('call', listener); }); },
    async open(opts = {}) { return createRangeInputProxy({ urls: media, fetchImpl: this.fetchImpl, setTimeoutImpl, clearTimeoutImpl, ...opts }); },
    async get(input, range) { return fetch(input, { headers: range ? { Range: range } : {} }); },
    async close(proxy) { if (!closed) { closed = true; proxy?.close(); } } };
}

test('range proxy streams exact 10 MB chunk boundaries and final chunk', async t => {
  const f = rangeFixture(); let proxy;
  t.after(async () => f.close(proxy)); proxy = await f.open();
  const response = await f.get(proxy.inputUrls[0]); const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200); assert.equal(bytes.length, 20_000_003);
  assert.equal(response.headers.get('content-length'), '20000003'); assert.equal(response.headers.get('accept-ranges'), 'bytes'); assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(f.calls[0].range, 'bytes=0-0');
  assert.match(proxy.inputUrls[0], /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/0$/);
  assert.deepEqual(f.calls.filter(c => !c.probe).map(c => c.range), ['bytes=0-9999999', 'bytes=10000000-19999999', 'bytes=20000000-20000002']);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const expected = Buffer.allocUnsafe(bytes.length); for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
  assert.equal(hash(bytes), hash(expected));
  for (const i of [9_999_999, 10_000_000, 19_999_999, 20_000_000]) assert.equal(bytes[i], i % 251);
  assert.equal(f.maxActive, 1); assert.equal(f.calls.filter(c => !c.probe).length, 3);
});

test('range proxy honors byte seeks, HEAD and invalid range responses', async t => {
  const f = rangeFixture(); let proxy; t.after(async () => f.close(proxy)); proxy = await f.open();
  for (const [range, start, end, length] of [['bytes=123-10000125', 123, 10000125, 10000003], ['bytes=20000000-', 20000000, 20000002, 3], ['bytes=-3', 20000000, 20000002, 3], ['bytes=19999999-99999999', 19999999, 20000002, 4]]) {
    const before = f.calls.length, r = await f.get(proxy.inputUrls[0], range), body = new Uint8Array(await r.arrayBuffer());
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/20000003`); assert.equal(body.length, length);
    assert.equal(r.headers.get('content-length'), String(length)); for (let i = 0; i < body.length; i++) assert.equal(body[i], (start + i) % 251);
    assert.deepEqual(f.calls.slice(before).filter(c => !c.probe).map(c => c.range), start === 123 ? ['bytes=123-10000122', 'bytes=10000123-10000125'] : [`bytes=${start}-${end}`]);
  }
  const count = f.calls.length, head = await fetch(proxy.inputUrls[0], { method: 'HEAD', headers: { Range: 'bytes=1-3' } });
  assert.equal(head.status, 206); assert.equal(await head.text(), ''); assert.equal(f.calls.length, count);
  assert.equal(head.headers.get('content-range'), 'bytes 1-3/20000003'); assert.equal(head.headers.get('content-length'), '3');
  const plainHead = await fetch(proxy.inputUrls[0], { method: 'HEAD' }); assert.equal(plainHead.status, 200); assert.equal(plainHead.headers.get('content-length'), '20000003'); assert.equal(await plainHead.text(), '');
  assert.equal((await fetch(proxy.inputUrls[0], { method: 'POST' })).status, 405);
  assert.equal((await fetch(new URL('/unknown', proxy.inputUrls[0]))).status, 404);
  for (const range of ['bytes=20000003-', 'bytes=5-4', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=x-y']) {
    const r = await f.get(proxy.inputUrls[0], range); assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), 'bytes */20000003');
  }
  assert.equal(f.calls.length, count);
});

test('range proxy rejects invalid open probes and releases earlier probes', async t => {
  for (const mode of ['200', '416', 'wrong-start']) {
    const f = rangeFixture({ size: 3, responseMode: c => c.probe ? mode : 'ok' });
    t.after(async () => f.close()); await assert.rejects(f.open());
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.calls[0].cancelled, 1); assert.ok(f.timers.every(timer => timer.cleared));
  }
  const f = rangeFixture({ urls: ['https://v.googlevideo.com/v', 'https://a.googlevideo.com/a'], size: 3,
    responseMode: c => c.index === 1 ? '200' : 'ok' });
  t.after(async () => f.close()); await assert.rejects(f.open());
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls[1].cancelled, 1); assert.ok(f.timers.every(timer => timer.cleared));
});

test('range proxy validates each 206 response, reports one failure and bounds redirects', async t => {
  for (const mode of ['200', 'wrong-start', 'wrong-end', 'wrong-total', 'wrong-length', 'short', 'long', 'gzip', '416', 'throw']) {
    const f = rangeFixture({ size: 13, responseMode: c => c.probe ? 'ok' : mode }); let proxy; t.after(async () => f.close(proxy)); proxy = await f.open();
    let failures = 0; proxy.onFailure(error => { assert.ok(error instanceof Error); failures++; });
    await assert.rejects(async () => { const r = await f.get(proxy.inputUrls[0]); await r.arrayBuffer(); });
    // 읽기 도중 예외(throw)는 이어받기를 최대 3번 시도한 뒤 실패로 보고한다(그 외 검증 실패는 즉시 실패)
    await tick(); assert.equal(failures, 1, mode); assert.equal(f.calls.filter(c => !c.probe).length, mode === 'throw' ? 4 : 1, mode);
    let late = 0; proxy.onFailure(() => late++); assert.equal(late, 1); assert.ok(f.timers.every(timer => timer.cleared));
  }
  const f = rangeFixture({ size: 13 }); let proxy; t.after(async () => f.close(proxy));
  let redirects = 0;
  const original = f.fetchImpl;
  f.fetchImpl = async (url, init) => { if (redirects++ < 3) return { status: 302, headers: new Headers({ location: url }), body: null }; return original(url, init); };
  proxy = await f.open(); const r = await f.get(proxy.inputUrls[0]); assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 13);
  const bad = rangeFixture({ size: 13 }); let blocked = false;
  const injected = async (url, init) => { if (!url.startsWith('https://') || url.includes('@') || url.includes('evilgooglevideo.com')) { blocked = true; throw Error('blocked'); } return bad.fetchImpl(url, init); };
  await assert.rejects(createRangeInputProxy({ urls: ['https://evilgooglevideo.com/x'], fetchImpl: injected }));
  assert.equal(blocked, false); assert.equal(bad.calls.length, 0);
  for (const destination of ['https://evilgooglevideo.com/x', 'http://v.googlevideo.com/x', 'https://user@v.googlevideo.com/x', 'https://googlevideo.com.evil.test/x']) {
    let calls = 0;
    await assert.rejects(createRangeInputProxy({ urls: ['https://v.googlevideo.com/x'], fetchImpl: async () => { calls++; return { status: 302, headers: new Headers({ location: destination }), body: null }; } }));
    assert.equal(calls, 1);
  }
  let hops = 0;
  await assert.rejects(createRangeInputProxy({ urls: ['https://v.googlevideo.com/x'], fetchImpl: async () => { hops++; return { status: 302, headers: new Headers({ location: '/next' }), body: null }; } }));
  assert.equal(hops, 4);
  const timed = rangeFixture({ size: 13, responseMode: () => 'pending' });
  const opening = timed.open(); const rejected = assert.rejects(opening); await timed.waitCall(() => true); await tick();
  assert.equal(timed.timers[0].delay, 30000); timed.timers[0].fn(); await rejected;
  assert.equal(timed.calls[0].signal.aborted, true); assert.equal(timed.calls[0].cancelled, 1); assert.ok(timed.timers.every(timer => timer.cleared));
  const dataTimed = rangeFixture({ size: 13, responseMode: c => c.probe ? 'ok' : 'pending' });
  const dataProxy = await dataTimed.open(); t.after(() => dataProxy.close()); let dataFailures = 0; dataProxy.onFailure(() => dataFailures++);
  const download = dataTimed.get(dataProxy.inputUrls[0]).then(r => r.arrayBuffer()); const dataRejected = assert.rejects(download);
  await dataTimed.waitCall(c => !c.probe); await tick(); dataTimed.timers.at(-1).fn(); await dataRejected;
  assert.equal(dataFailures, 1); assert.equal(dataTimed.calls.at(-1).signal.aborted, true); assert.equal(dataTimed.calls.at(-1).cancelled, 1); assert.ok(dataTimed.timers.every(timer => timer.cleared));
});

test('range proxy drains before reading next chunk and limits two inputs', async t => {
  const f = rangeFixture({ size: 20_000_003, urls: ['https://v.googlevideo.com/v', 'https://a.googlevideo.com/a'] });
  let proxy; t.after(async () => f.close(proxy)); proxy = await f.open();
  const originalWrite = ServerResponse.prototype.write, originalEmit = ServerResponse.prototype.emit;
  const blocked = new Set(); let release = false, wake;
  const stalled = new Promise(resolve => { wake = resolve; });
  ServerResponse.prototype.write = function (...args) {
    assert.equal(this.writableHighWaterMark, 65536);
    const result = originalWrite.apply(this, args);
    if (!release && !result) { blocked.add(this); if (blocked.size === 2) wake(); }
    return result;
  };
  ServerResponse.prototype.emit = function (event, ...args) { if (event === 'drain' && !release && blocked.has(this)) return false; return originalEmit.call(this, event, ...args); };
  t.after(() => { ServerResponse.prototype.write = originalWrite; ServerResponse.prototype.emit = originalEmit; });
  const expectedHash = createHash('sha256');
  for (let pos = 0; pos < 20_000_003; pos += 65536) { const block = Buffer.alloc(Math.min(65536, 20_000_003 - pos)); for (let i = 0; i < block.length; i++) block[i] = (pos + i) % 251; expectedHash.update(block); }
  const expectedDigest = expectedHash.digest('hex');
  const readers = proxy.inputUrls.map(async url => { const r = await fetch(url); const reader = r.body.getReader(), hash = createHash('sha256'); let total = 0; for (;;) { const x = await reader.read(); if (x.done) { assert.equal(hash.digest('hex'), expectedDigest); return total; } total += x.value.length; hash.update(x.value); } });
  await stalled;
  // 소비자가 느려 drain 을 기다리는 동안에는 업스트림 타임아웃(30초) 타이머가 살아 있으면 안 된다(재생 중 스트림이 끊기던 실사고)
  assert.deepEqual(f.timers.filter(timer => timer.delay === 30000 && !timer.cleared), []);
  const pulls = f.calls.filter(c => !c.probe).map(c => c.pulls); await tick();
  assert.deepEqual(f.calls.filter(c => !c.probe).map(c => c.pulls), pulls); assert.equal(f.calls.filter(c => !c.probe).length, 2);
  release = true; for (const res of blocked) res.emit('drain');
  const lengths = await Promise.all(readers); assert.deepEqual(lengths, [20_000_003, 20_000_003]);
  assert.equal(f.maxActive, 2);
  for (let i = 0; i < 2; i++) assert.deepEqual(f.calls.filter(c => c.index === i && !c.probe).map(c => c.range), ['bytes=0-9999999', 'bytes=10000000-19999999', 'bytes=20000000-20000002']);
});

test('range proxy resumes from the delivered offset when the upstream connection resets mid chunk', async t => {
  // 실사고: 소비자가 느려 응답을 오래 열어 두면 YouTube 가 연결을 끊어(ECONNRESET) 재생 중 스트림이 끊겼다
  const f = rangeFixture({ size: 20_000_003, responseMode: c => c.probe ? 'ok' : c.range === 'bytes=0-9999999' ? 'reset-mid' : 'ok' });
  let proxy; t.after(async () => f.close(proxy)); proxy = await f.open();
  let failures = 0; proxy.onFailure(() => failures++);
  const response = await f.get(proxy.inputUrls[0]); const received = new Uint8Array(await response.arrayBuffer());
  assert.equal(received.length, 20_000_003);
  for (let i = 0; i < received.length; i += 9973) assert.equal(received[i], i % 251);
  assert.equal(received[received.length - 1], 20_000_002 % 251);
  assert.deepEqual(f.calls.filter(c => !c.probe).map(c => c.range), ['bytes=0-9999999', 'bytes=65536-10065535', 'bytes=10065536-20000002']);
  assert.equal(failures, 0);
});

test('range proxy abort, close and replacement generations release pending work', async t => {
  const f = rangeFixture({ size: 20_000_003, responseMode: c => c.probe ? 'ok' : 'pending' });
  const root = new AbortController(); let proxy; t.after(async () => f.close(proxy)); proxy = await f.open({ signal: root.signal });
  let failures = 0; proxy.onFailure(() => failures++); const pending = f.get(proxy.inputUrls[0]).catch(() => null);
  const request = await f.waitCall(c => !c.probe); await tick(); root.abort(); assert.equal(request.signal.aborted, true);
  proxy.close(); proxy.close(); assert.throws(() => request.controller?.enqueue(new Uint8Array([1]))); await pending.catch(() => {}); await tick();
  assert.equal(failures, 0); assert.equal(f.calls.filter(c => !c.probe).length, 1);
  assert.equal(request.cancelled, 1); assert.ok(f.timers.every(timer => timer.cleared));
  await assert.rejects(fetch(proxy.inputUrls[0]));
  const g = rangeFixture({ size: 20_000_003, urls: ['https://v.googlevideo.com/v', 'https://a.googlevideo.com/a'], responseMode: c => c.probe ? 'ok' : c.range === 'bytes=0-9999999' ? 'pending' : 'ok' });
  let p; t.after(async () => g.close(p)); p = await g.open(); const old = g.get(p.inputUrls[0]).catch(() => null); await g.waitCall(c => !c.probe && c.index === 0);
  const audio = g.get(p.inputUrls[1]).catch(() => null); const audioCall = await g.waitCall(c => !c.probe && c.index === 1); await tick();
  const newer = await g.get(p.inputUrls[0], 'bytes=10000000-10000002');
  assert.deepEqual([...new Uint8Array(await newer.arrayBuffer())], [10000000 % 251, 10000001 % 251, 10000002 % 251]);
  assert.equal(g.calls.find(c => c.range === 'bytes=0-9999999').signal.aborted, true); await old.catch(() => {});
  assert.equal(g.calls.find(c => c.range === 'bytes=0-9999999').cancelled, 1);
  assert.equal(audioCall.signal.aborted, false); p.close(); await audio;
  const h = rangeFixture({ size: 3, responseMode: c => c.probe ? 'pending' : 'ok' });
  const abort = new AbortController(); const waiting = h.open({ signal: abort.signal });
  const rejectedOpen = assert.rejects(waiting); await h.waitCall(() => true); abort.abort(); await rejectedOpen; assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true); assert.ok(h.timers.every(timer => timer.cleared));
  assert.equal(h.calls[0].cancelled, 1);
  const lateFixture = rangeFixture({ size: 13 }); let resolveLate, signalLate, announce;
  const announced = new Promise(resolve => { announce = resolve; }); const originalFetch = lateFixture.fetchImpl;
  lateFixture.fetchImpl = (url, init) => { if (init.headers.Range === 'bytes=0-0') return originalFetch(url, init); signalLate = init.signal; announce(); return new Promise(resolve => { resolveLate = resolve; }); };
  const lateRoot = new AbortController(), lateProxy = await lateFixture.open({ signal: lateRoot.signal }); t.after(() => lateProxy.close());
  let lateNotices = 0, lateCancels = 0; lateProxy.onFailure(() => lateNotices++);
  const lateDownload = lateFixture.get(lateProxy.inputUrls[0]).then(r => r.arrayBuffer()); const lateRejected = assert.rejects(lateDownload);
  await announced; lateRoot.abort(); assert.equal(signalLate.aborted, true);
  resolveLate({ status: 206, headers: new Headers({ 'content-range': 'bytes 0-12/13' }), body: new ReadableStream({ cancel() { lateCancels++; } }) });
  await lateRejected; await tick(); assert.equal(lateCancels, 1); assert.equal(lateNotices, 0); assert.ok(lateFixture.timers.every(timer => timer.cleared));
  const already = new AbortController(); already.abort(); const untouched = rangeFixture(); await assert.rejects(untouched.open({ signal: already.signal })); assert.equal(untouched.calls.length, 0);
  const drainFixture = rangeFixture(); const drainRoot = new AbortController(); const drainProxy = await drainFixture.open({ signal: drainRoot.signal }); t.after(() => drainProxy.close());
  const write = ServerResponse.prototype.write, emit = ServerResponse.prototype.emit;
  let blockedRes, wake; const blocked = new Promise(resolve => { wake = resolve; });
  ServerResponse.prototype.write = function (...args) { const result = write.apply(this, args); if (!result) { blockedRes = this; wake(); } return result; };
  ServerResponse.prototype.emit = function (event, ...args) { if (event === 'drain' && this === blockedRes) return false; return emit.call(this, event, ...args); };
  try {
    let notices = 0; drainProxy.onFailure(() => notices++);
    const draining = drainFixture.get(drainProxy.inputUrls[0]).then(r => r.arrayBuffer()); const failed = assert.rejects(draining);
    await blocked; const call = drainFixture.calls.find(c => !c.probe), pulls = call.pulls;
    drainRoot.abort(); assert.equal(call.signal.aborted, true); assert.equal(call.cancelled, 1); assert.ok(blockedRes.destroyed); assert.ok(drainFixture.timers.every(timer => timer.cleared));
    await failed; await tick(); assert.equal(call.pulls, pulls); assert.equal(notices, 0); assert.equal(drainFixture.calls.filter(c => !c.probe).length, 1);
  } finally { ServerResponse.prototype.write = write; ServerResponse.prototype.emit = emit; }
});
