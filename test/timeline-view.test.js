import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTimelineView } from '../renderer/timeline-view.js';

class Node {
  constructor(id, doc) {
    this.id = id;
    this.ownerDocument = doc;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.clientWidth = 1000;
    this.scrollLeft = 0;
    this.value = '';
    this.captures = new Set();
  }
  append(...nodes) {
    for (const node of nodes) { node.parent = this; this.children.push(node); }
  }
  replaceChildren(...nodes) {
    this.children.forEach(node => { node.parent = null; });
    this.children = [];
    this.append(...nodes);
  }
  querySelector(selector) {
    for (const node of this.children) {
      if ('#' + node.id === selector) return node;
      const found = node.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  contains(target) {
    return target === this || this.children.some(node => node.contains(target));
  }
  getBoundingClientRect() { return { left: 20, width: this.clientWidth }; }
  addEventListener(type, fn, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, options });
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.fn !== fn));
  }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  emit(type, props = {}) {
    const event = {
      target: this, button: 0, pointerId: 1, clientX: 120, deltaY: 0,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.defaultPrevented = true; }, ...props,
    };
    for (let node = this; node; node = node.parent) {
      for (const { fn } of node.listeners.get(type) || []) fn(event);
      if (event.stopped) break;
    }
    return event;
  }
}

function fixture() {
  let observer;
  const doc = {
    defaultView: { ResizeObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe(node) { this.node = node; }
      disconnect() { this.disconnected = true; }
    } },
    createElement: () => new Node('', doc),
  };
  const nodes = {};
  for (const id of ['timeline', 'timeline-scroll', 'timeline-content', 'timeline-ticks',
    'selection', 'start-handle', 'end-handle', 'playhead', 'start-input', 'end-input', 'zoom-input']) {
    nodes[id] = new Node(id, doc);
  }
  nodes.timeline.append(nodes['timeline-scroll'], nodes['start-input'], nodes['end-input'], nodes['zoom-input']);
  nodes['timeline-scroll'].append(nodes['timeline-content']);
  nodes['timeline-content'].append(nodes['timeline-ticks'], nodes.selection, nodes.playhead);
  nodes.selection.append(nodes['start-handle'], nodes['end-handle']);
  const changes = [], seeks = [];
  const view = createTimelineView(nodes.timeline, {
    onChange: state => changes.push(state), onSeek: sec => seeks.push(sec),
  });
  const initial = { startSec: 200, endSec: 800, zoom: 2, scrollSec: 100, playheadSec: 300 };
  view.set({ durationSec: 1000 }, initial);
  return { nodes, view, initial, changes, seeks, observer };
}

test('uses existing HTML IDs, renders selection/ticks/playhead and maps empty-axis click to 150', () => {
  const { nodes, view, seeks, changes } = fixture();
  const html = fs.readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  for (const id of Object.keys(nodes)) assert.ok(html.includes('id="' + id + '"'));
  assert.equal(nodes['timeline-content'].style.width, '2000px');
  assert.equal(nodes.selection.style.left, '400px');
  assert.equal(nodes.selection.style.width, '1200px');
  assert.equal(nodes.playhead.style.left, '600px');
  assert.ok(nodes['timeline-ticks'].children.length > 1);
  const checkSpacing = () => {
    const positions = nodes['timeline-ticks'].children.map(tick => Number.parseFloat(tick.style.left));
    for (let i = 1; i < positions.length; i++) assert.ok(positions[i] - positions[i - 1] >= 100 - 1e-8);
    return positions;
  };
  const initialSpacing = checkSpacing();
  for (const viewport of [320, 800, 1400]) {
    nodes['timeline-scroll'].clientWidth = viewport;
    for (const duration of [0.1, 1, 59, 60, 1000, 86400, 3600000]) {
      for (const zoom of [1, 4, 64]) {
        view.set({ durationSec: duration }, { startSec: 0, endSec: duration, zoom, scrollSec: duration / 4 });
        checkSpacing();
        assert.ok(nodes['timeline-ticks'].children.length <= Math.ceil(viewport / 100) + 1);
      }
    }
  }
  nodes['timeline-scroll'].clientWidth = 1000;
  view.set({ durationSec: 1000 }, { startSec: 200, endSec: 800, zoom: 4, scrollSec: 100, playheadSec: 300 });
  const zoomed = nodes['timeline-ticks'].children.map(tick => tick.textContent);
  assert.ok(zoomed.includes('00:02:30')); // 30-second spacing when zoomed, versus 60 seconds initially.
  assert.equal(initialSpacing[1] - initialSpacing[0], 120);
  view.set({ durationSec: 1000 }, { startSec: 200, endSec: 800, zoom: 2, scrollSec: 100, playheadSec: 300 });
  assert.equal(nodes['timeline-scroll'].scrollLeft, 200);
  nodes['timeline-content'].emit('click', { clientX: 120 });
  assert.deepEqual(seeks, [150]);
  assert.equal(changes.length, 0);
  assert.equal(view.getState().playheadSec, 300);
  // 선택 구간 안쪽을 클릭해도 seek 한다(핸들만 click 전파를 막는다).
  nodes.selection.emit('click', { clientX: 120 });
  assert.deepEqual(seeks, [150, 150]);
});

test('handle capture, threshold, drag clamping and cancellation never trigger seeking', () => {
  const { nodes, view, changes, seeks } = fixture();
  const start = nodes['start-handle'], end = nodes['end-handle'];
  start.emit('pointerdown', { clientX: 420 });
  assert.equal(start.hasPointerCapture(1), true);
  start.emit('pointermove', { clientX: 422 });
  assert.equal(changes.length, 0);
  start.emit('pointermove', { clientX: 620 });
  assert.equal(view.getState().startSec, 300);
  start.emit('pointermove', { clientX: 4000 });
  assert.equal(view.getState().startSec, 799.95);
  start.emit('pointerup');
  assert.equal(start.hasPointerCapture(1), false);
  start.emit('click');
  end.emit('pointerdown', { clientX: 1620 });
  end.emit('pointermove', { clientX: 420 });
  assert.equal(view.getState().endSec, 800);
  end.emit('pointercancel');
  assert.equal(end.hasPointerCapture(1), false);
  end.emit('click');
  assert.deepEqual(seeks, []);
});

test('Ctrl wheel preserves cursor anchor and zoom input preserves the center anchor', () => {
  const { nodes, view, changes } = fixture();
  const scroll = nodes['timeline-scroll'];
  scroll.emit('wheel', { clientX: 220, deltaY: -100 });
  assert.equal(view.getState().zoom, 2);
  const event = scroll.emit('wheel', { clientX: 220, deltaY: -Math.log(2) / 0.002, ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(scroll.listeners.get('wheel')[0].options.passive, false);
  assert.equal(view.getState().zoom, 4);
  assert.equal(view.getState().scrollSec, 150);
  nodes['zoom-input'].value = '8';
  nodes['zoom-input'].emit('input');
  assert.equal(view.getState().zoom, 8);
  assert.equal(view.getState().scrollSec, 212.5);
  assert.equal(changes.length, 2);
  nodes['zoom-input'].value = '100';
  nodes['zoom-input'].emit('input');
  assert.equal(view.getState().zoom, 64);
});

test('scroll publishes seconds, ignores programmatic echoes and resize restores seconds', () => {
  const { nodes, view, changes, observer } = fixture();
  const scroll = nodes['timeline-scroll'];
  scroll.emit('scroll');
  assert.equal(changes.length, 0);
  scroll.scrollLeft = 400;
  scroll.emit('scroll');
  assert.equal(view.getState().scrollSec, 200);
  assert.equal(changes.length, 1);
  scroll.clientWidth = 500;
  observer.callback();
  assert.equal(nodes['timeline-content'].style.width, '1000px');
  assert.equal(scroll.scrollLeft, 200);
  assert.equal(view.getState().scrollSec, 200);
  scroll.emit('scroll');
  assert.equal(changes.length, 1);
  view.set({ durationSec: 1000 }, { ...view.getState(), scrollSec: 300 });
  assert.equal(scroll.scrollLeft, 300);
  scroll.emit('scroll');
  assert.equal(changes.length, 1);
});

test('set/get/callback states are independent copies and normalize every canonical field', () => {
  const { nodes, view, initial, changes } = fixture();
  initial.startSec = 0;
  assert.equal(view.getState().startSec, 200);
  const retrieved = view.getState();
  retrieved.endSec = 0;
  assert.equal(view.getState().endSec, 800);
  nodes['start-input'].value = '250';
  nodes['start-input'].emit('change');
  changes[0].startSec = 0;
  assert.equal(view.getState().startSec, 250);
  view.set({ durationSec: 1000 }, { startSec: -1, endSec: 2000, zoom: 100, scrollSec: 2000, playheadSec: 2000 });
  assert.deepEqual(view.getState(), { startSec: 0, endSec: 1000, zoom: 64, scrollSec: 984.375, playheadSec: 1000 });
});

test('valid boundary inputs publish; invalid inputs preserve state; destroy removes listeners and observer', () => {
  const { nodes, view, changes, seeks, observer } = fixture();
  nodes['end-input'].value = '00:12:30.000';
  nodes['end-input'].emit('change');
  assert.equal(view.getState().endSec, 750);
  assert.equal(changes.length, 1);
  const before = view.getState();
  for (const text of ['bad', '900', '-1']) {
    nodes['start-input'].value = text;
    nodes['start-input'].emit('change');
    assert.deepEqual(view.getState(), before);
  }
  nodes['end-input'].value = '100';
  nodes['end-input'].emit('change');
  assert.deepEqual(view.getState(), before);
  assert.equal(changes.length, 1);
  nodes['start-handle'].emit('pointerdown');
  view.destroy();
  view.destroy();
  assert.equal(nodes['start-handle'].hasPointerCapture(1), false);
  assert.equal(observer.disconnected, true);
  for (const node of Object.values(nodes)) {
    assert.equal([...node.listeners.values()].flat().length, 0);
  }
  nodes['timeline-content'].emit('click');
  nodes['zoom-input'].emit('input');
  observer.callback();
  view.set({ durationSec: 20 }, {});
  assert.deepEqual(view.getState(), before);
  assert.deepEqual(seeks, []);
  assert.equal(changes.length, 1);
  assert.equal(nodes.timeline.children.length, 4);
});
