import { normalizeTimeline, xToTime, timeToX, zoomAt } from '../lib/timeline.js';
import { parseTime, formatTime } from '../lib/time.js';

export function createTimelineView(root, { onChange = () => {}, onSeek = () => {} } = {}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const find = id => {
    const node = root.querySelector('#' + id);
    if (!node) throw new TypeError('Missing timeline element: ' + id);
    return node;
  };
  const scroll = find('timeline-scroll'), content = find('timeline-content');
  const ticks = find('timeline-ticks'), selection = find('selection'), playhead = find('playhead');
  const start = find('start-handle'), end = find('end-handle');
  const startInput = find('start-input'), endInput = find('end-input'), zoomInput = find('zoom-input');
  let state = null, duration = 0, pointer = null, destroyed = false, expectedScroll = null;
  const listeners = [];
  const width = () => Math.max(1, scroll.clientWidth || scroll.getBoundingClientRect().width);
  const copy = value => value === null ? null : structuredClone(value);
  const listen = (node, type, fn, options) => {
    node.addEventListener(type, fn, options);
    listeners.push(() => node.removeEventListener(type, fn, options));
  };
  const pixel = sec => timeToX(sec, width(), { ...state, scrollSec: 0 }, duration);
  function render() {
    if (!state || destroyed) return;
    content.style.width = width() * state.zoom + 'px';
    selection.style.left = pixel(state.startSec) + 'px';
    selection.style.width = pixel(state.endSec - state.startSec) + 'px';
    playhead.style.left = pixel(state.playheadSec) + 'px';
    startInput.value = formatTime(state.startSec);
    endInput.value = formatTime(state.endSec);
    zoomInput.value = String(state.zoom);
    ticks.replaceChildren();
    // Choose readable time intervals with at least 100px between labels.
    const minimum = duration / (width() * state.zoom) * 100;
    const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    let step = intervals.find(seconds => seconds >= minimum);
    if (!step) {
      const scale = 10 ** Math.floor(Math.log10(minimum / 3600));
      step = [1, 2, 5, 10].map(factor => factor * scale * 3600).find(seconds => seconds >= minimum);
    }
    const last = Math.min(duration, state.scrollSec + duration / state.zoom);
    for (let sec = Math.ceil(state.scrollSec / step) * step; sec <= last; sec += step) {
      const tick = doc.createElement('span');
      tick.className = 'timeline-tick';
      tick.style.left = pixel(sec) + 'px';
      tick.textContent = formatTime(sec).replace(/\.000$/, '');
      ticks.append(tick);
    }
    const nextScroll = pixel(state.scrollSec);
    if (Math.abs(scroll.scrollLeft - nextScroll) > 0.01) {
      expectedScroll = nextScroll;
      scroll.scrollLeft = nextScroll;
    }
  }
  function publish(next) {
    state = normalizeTimeline(next, duration);
    render();
    onChange(copy(state));
  }
  listen(scroll, 'scroll', () => {
    if (!state) return;
    if (expectedScroll !== null && Math.abs(scroll.scrollLeft - expectedScroll) < 0.01) {
      expectedScroll = null;
      return;
    }
    expectedScroll = null;
    publish({ ...state, scrollSec: scroll.scrollLeft * duration / (width() * state.zoom) });
  }, { passive: true });
  listen(scroll, 'click', event => {
    if (!state) return;
    onSeek(xToTime(event.clientX - scroll.getBoundingClientRect().left, width(), state, duration));
  });
  listen(scroll, 'wheel', event => {
    if (!state || !event.ctrlKey) return;
    event.preventDefault();
    publish(zoomAt(state, state.zoom * Math.exp(-event.deltaY * 0.002),
      event.clientX - scroll.getBoundingClientRect().left, width(), duration));
  }, { passive: false });
  listen(zoomInput, 'input', () => {
    if (state) publish(zoomAt(state, Number(zoomInput.value), width() / 2, width(), duration));
  });
  for (const [handle, field, input] of [[start, 'startSec', startInput], [end, 'endSec', endInput]]) {
    listen(input, 'change', () => {
      if (!state) return;
      try {
        const sec = parseTime(input.value), gap = Math.min(0.05, duration);
        if (sec < 0 || sec > duration ||
            (field === 'startSec' ? sec > state.endSec - gap : sec < state.startSec + gap)) {
          throw new RangeError('Invalid selection boundary');
        }
        publish({ ...state, [field]: sec });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        render();
      }
    });
    listen(handle, 'click', event => event.stopPropagation());
    listen(handle, 'pointerdown', event => {
      if (!state || event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      pointer = { id: event.pointerId, x: event.clientX, value: state[field], handle, field };
      handle.setPointerCapture(event.pointerId);
    });
    listen(handle, 'pointermove', event => {
      if (!pointer || pointer.handle !== handle || pointer.id !== event.pointerId) return;
      event.stopPropagation();
      const delta = event.clientX - pointer.x;
      if (Math.abs(delta) < 3 && !pointer.moved) return;
      pointer.moved = true;
      const gap = Math.min(0.05, duration);
      const sec = pointer.value + delta * duration / (width() * state.zoom);
      publish({ ...state, [field]: field === 'startSec'
        ? Math.max(0, Math.min(state.endSec - gap, sec))
        : Math.min(duration, Math.max(state.startSec + gap, sec)) });
    });
    const release = event => {
      if (!pointer || pointer.handle !== handle || pointer.id !== event.pointerId) return;
      event.stopPropagation();
      if (handle.hasPointerCapture(pointer.id)) handle.releasePointerCapture(pointer.id);
      pointer = null;
    };
    listen(handle, 'pointerup', release);
    listen(handle, 'pointercancel', release);
    listen(handle, 'lostpointercapture', () => { if (pointer?.handle === handle) pointer = null; });
  }
  const observer = win?.ResizeObserver ? new win.ResizeObserver(render) : null;
  observer?.observe(scroll);
  if (!observer && win) listen(win, 'resize', render);
  return {
    set(video, nextState = {}) {
      if (destroyed) return;
      duration = video.durationSec;
      state = normalizeTimeline(copy(nextState), duration);
      render();
    },
    getState: () => copy(state),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (pointer?.handle.hasPointerCapture(pointer.id)) pointer.handle.releasePointerCapture(pointer.id);
      pointer = null;
      listeners.forEach(remove => remove());
      observer?.disconnect();
    },
  };
}
