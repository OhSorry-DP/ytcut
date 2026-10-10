import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../renderer/player.js';

async function setup(t, initialState = 5) {
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  let state = initialState;
  let events;
  let instance;
  const previous = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  globalThis.window = {
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {}, removeEventListener() {},
    YT: {
      PlayerState: { UNSTARTED: -1, CUED: 5, PLAYING: 1, PAUSED: 2, BUFFERING: 3 },
      Player: class {
        constructor(id, options) { events = options.events; instance = this; }
        getIframe() { return { setAttribute() {} }; }
        getPlayerState() { return state; }
        getVideoData() { return { video_id: 'next' }; }
        playVideo() { calls.push(['play']); }
        seekTo(...args) { calls.push(['seek', ...args]); }
        pauseVideo() { calls.push(['pause']); }
        cueVideoById() { state = 5; events.onStateChange({ data: 5, target: instance }); }
        destroy() { calls.push(['destroy']); }
      },
    },
  };
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.location = { origin: 'http://localhost' };
  const player = createPlayer('player');
  t.after(() => {
    player.destroy();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  await Promise.resolve();
  events.onReady();
  return {
    player, calls, timers,
    async flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); },
    state(value) { state = value; events.onStateChange({ data: value, target: instance }); },
    timeout() {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 8000);
      assert.ok(entry);
      timers.delete(entry[0]);
      entry[1].fn();
    },
  };
}

test('CUED seek starts playback before moving', async t => {
  const mock = await setup(t);
  const seeking = mock.player.seek(40);
  await mock.flush();
  assert.deepEqual(mock.calls, [['play']]);
  mock.state(1);
  await seeking;
  assert.deepEqual(mock.calls, [['play'], ['seek', 40, true]]);
  assert.equal(mock.timers.size, 0);
});

test('PAUSED seek moves immediately without starting playback', async t => {
  const mock = await setup(t, 2);
  await mock.player.seek(40);
  assert.deepEqual(mock.calls, [['seek', 40, true]]);
});

test('pending seeks share one wait and move to the latest target', async t => {
  const mock = await setup(t);
  const first = mock.player.seek(40);
  await mock.flush();
  const second = mock.player.seek(70);
  await mock.flush();
  assert.equal(mock.timers.size, 1);
  mock.state(3);
  await Promise.all([first, second]);
  assert.deepEqual(mock.calls, [['play'], ['seek', 70, true]]);
  assert.equal(mock.timers.size, 0);
});

test('eight second timeout still moves and resolves', async t => {
  const mock = await setup(t);
  const seeking = mock.player.seek(40);
  await mock.flush();
  mock.timeout();
  await seeking;
  assert.deepEqual(mock.calls, [['play'], ['seek', 40, true]]);
  assert.equal(mock.timers.size, 0);
});

test('destroy and a new load cancel pending moves and clear timers', async t => {
  const mock = await setup(t);
  const first = mock.player.seek(40);
  await mock.flush();
  await mock.player.load('next', 10);
  await first;
  assert.deepEqual(mock.calls, [['play'], ['pause'], ['seek', 10, true]]);
  const second = mock.player.seek(70);
  await mock.flush();
  mock.player.destroy();
  mock.state(1);
  await second;
  assert.deepEqual(mock.calls, [['play'], ['pause'], ['seek', 10, true], ['play'], ['destroy']]);
  assert.equal(mock.timers.size, 0);
});

test('non-numeric state starts playback before moving', async t => {
  const mock = await setup(t, undefined);
  mock.state(undefined);
  const seeking = mock.player.seek(40);
  await mock.flush();
  assert.deepEqual(mock.calls, [['play']]);
  mock.state(1);
  await seeking;
  assert.deepEqual(mock.calls, [['play'], ['seek', 40, true]]);
});
