const API_URL = 'https://www.youtube.com/iframe_api';
const API_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 250;

let apiPromise;

function loadIframeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    let settled = false;
    const previousReady = window.onYouTubeIframeAPIReady;
    const script = document.querySelector(`script[src="${API_URL}"]`) || document.createElement('script');
    const timeout = window.setTimeout(() => finish(new Error('YouTube iframe API timed out')), API_TIMEOUT_MS);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) {
        apiPromise = undefined;
        reject(error);
      } else {
        resolve(window.YT);
      }
    };

    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') previousReady();
      finish(window.YT && window.YT.Player ? undefined : new Error('YouTube iframe API initialized without YT.Player'));
    };

    if (!script.src) {
      script.src = API_URL;
      script.onerror = () => finish(new Error('Failed to load YouTube iframe API'));
      document.head.appendChild(script);
    } else {
      script.addEventListener('error', () => finish(new Error('Failed to load YouTube iframe API')), { once: true });
    }
  });
  return apiPromise;
}

export function createPlayer(elementId, { onTime, onError } = {}) {
  let player;
  let destroyed = false;
  let generation = 0;
  let pollTimer;
  let focusTimer;
  let iframe;
  let pendingSeek;
  const finishSeek = (move) => {
    const active = pendingSeek;
    if (!active) return;
    pendingSeek = undefined;
    window.clearTimeout(active.timeout);
    if (move && !destroyed && active.token === generation) {
      try { player.seekTo(active.target, true); } catch {}
    }
    active.resolve();
  };
  const reclaimFocus = () => {
    if (destroyed || !iframe) return;
    window.clearTimeout(focusTimer);
    // Let the iframe's pointer action complete before moving keyboard focus.
    focusTimer = window.setTimeout(() => {
      if (destroyed || document.activeElement !== iframe) return;
      iframe.blur();
      window.focus();
      document.getElementById('timeline-scroll')?.focus({ preventScroll: true });
    }, 0);
  };
  window.addEventListener('blur', reclaimFocus);
  document.addEventListener('focusin', reclaimFocus);
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimeout = window.setTimeout(() => {
    const error = new Error('YouTube player ready timed out');
    rejectReady(error);
    if (!destroyed && typeof onError === 'function') onError({ code: 'PLAYER_TIMEOUT', message: error.message });
  }, API_TIMEOUT_MS);

  const reportError = (event) => {
    if (destroyed) return;
    const code = event && event.data;
    const message = code === 'onAutoplayBlocked'
      ? 'YouTube autoplay was blocked'
      : `YouTube player error${code === undefined ? '' : ` (${code})`}`;
    if (typeof onError === 'function') onError({ code, message });
    if (currentLoad && code !== 'onAutoplayBlocked') currentLoad.reject(Object.assign(new Error(message), { code }));
  };

  const beginPolling = () => {
    if (pollTimer !== undefined || typeof onTime !== 'function') return;
    pollTimer = window.setInterval(() => {
      if (!destroyed && player && typeof player.getCurrentTime === 'function') onTime(player.getCurrentTime());
    }, POLL_INTERVAL_MS);
  };

  const apiReady = loadIframeApi().then((YT) => {
    if (destroyed) return;
    player = new YT.Player(elementId, {
      playerVars: { origin: location.origin, playsinline: 1, controls: 1, disablekb: 1 },
      host: 'https://www.youtube.com',
      events: {
        onReady: () => {
          window.clearTimeout(readyTimeout);
          iframe = player.getIframe();
          iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
          resolveReady();
          beginPolling();
        },
        onError: reportError,
        onAutoplayBlocked: reportError,
        onStateChange: (event) => {
          if (destroyed) return;
          if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING) finishSeek(true);
          const active = currentLoad;
          if (!active || active.token !== generation || event.target.getVideoData().video_id !== active.videoId) return;
          if (event.data === YT.PlayerState.CUED || event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.PAUSED) {
            active.states.add(event.data);
            active.resolve();
          }
        },
      },
    });
  }).catch((error) => {
    if (!destroyed) {
      rejectReady(error);
      window.clearTimeout(readyTimeout);
      if (typeof onError === 'function') onError({ code: 'API_LOAD_FAILED', message: error.message });
    }
    // load/seek callers observe the ready rejection; avoid an unhandled loader rejection.
  });

  let currentLoad;
  ready.catch(() => {});
  const waitForVideoStates = (videoId, token) => new Promise((resolve, reject) => {
    const states = new Set();
    const timeout = window.setTimeout(() => reject(new Error('YouTube video load timed out')), API_TIMEOUT_MS);
    currentLoad = { videoId, token, states, resolve: () => { window.clearTimeout(timeout); resolve(); }, reject: error => { window.clearTimeout(timeout); reject(error); } };
  });

  return {
    async load(videoId, timeSec = 0) {
      const token = ++generation;
      finishSeek(false);
      if (currentLoad) currentLoad.reject(new Error('SUPERSEDED'));
      try {
        await apiReady;
        await ready;
        if (token !== generation || destroyed) throw new Error('SUPERSEDED');
        const statesReady = waitForVideoStates(videoId, token);
        player.cueVideoById({ videoId, startSeconds: timeSec });
        await statesReady;
        if (token !== generation || destroyed) throw new Error('SUPERSEDED');
        player.pauseVideo();
        player.seekTo(timeSec, true);
      } catch (error) {
        if (error.message !== 'SUPERSEDED' && !destroyed && typeof onError === 'function') {
          onError({ code: error.code || 'PLAYER_LOAD_FAILED', message: error.message });
        }
        throw error;
      }
    },
    async seekAndPlay(sec) {
      await apiReady;
      await ready;
      if (destroyed) return;
      player.seekTo(sec, true);
      player.playVideo();
    },
    async seek(sec) {
      const token = generation;
      await apiReady;
      await ready;
      if (destroyed || token !== generation) return;
      if (pendingSeek) {
        pendingSeek.target = sec;
        return pendingSeek.promise;
      }
      const state = player.getPlayerState();
      if (typeof state === 'number' && Number.isFinite(state) && state !== -1 && state !== 5) {
        player.seekTo(sec, true);
        return;
      }
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pendingSeek = { token, target: sec, promise, resolve, timeout: window.setTimeout(() => finishSeek(true), 8000) };
      try {
        player.playVideo();
        const startedState = player.getPlayerState();
        if (startedState === 1 || startedState === 3) finishSeek(true);
      } catch {}
      return promise;
    },
    async pause() {
      await apiReady;
      await ready;
      if (!destroyed) player.pauseVideo();
    },
    async togglePlay() {
      await apiReady;
      await ready;
      if (destroyed) return;
      if (player.getPlayerState() === window.YT.PlayerState.PLAYING) player.pauseVideo();
      else player.playVideo();
    },
    getTime() { return player?.getCurrentTime() || 0; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(focusTimer);
      window.removeEventListener('blur', reclaimFocus);
      document.removeEventListener('focusin', reclaimFocus);
      window.clearTimeout(readyTimeout);
      generation++;
      finishSeek(false);
      if (currentLoad) currentLoad.reject(new Error('SUPERSEDED'));
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      pollTimer = undefined;
      if (player && typeof player.destroy === 'function') player.destroy();
    },
  };
}
