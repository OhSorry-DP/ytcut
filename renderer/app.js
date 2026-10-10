import { formatTime } from '../lib/time.js';
import { normalizeTimeline } from '../lib/timeline.js';
import { createPlayer } from './player.js';
import { createLocalPlayer } from './local-player.js';


export function createApp({ player, timelineView, ytcut, document: doc, youtubeFactory = createPlayer, localFactory = createLocalPlayer }) {
  const settingsIds = { ytDlpPath: 'yt-dlp-path', ffmpegPath: 'ffmpeg-path', outputDir: 'output-dir', cutMode: 'cut-mode', format: 'settings-format', autoUpdateYtDlp: 'auto-update-ytdlp', previewResolution: 'preview-resolution', alwaysUseLocalPlayer: 'always-use-local-player' };
  const unwrap = result => { if (!result.ok) throw result.error; return result.value; };
  const el = id => doc.getElementById(id);
  const copy = value => value == null ? value : structuredClone(value);
  let settings = { format: 'mp4', cutMode: 'accurate', autoUpdateYtDlp: true, previewResolution: 480, alwaysUseLocalPlayer: true };
  let state = { video: null, timeline: { startSec: 0, endSec: 0 }, cutMode: 'accurate', format: 'mp4', fileName: '' };
  let generation = 0;
  let revision = -1;
  let ready = false;
  let previewReady = false;
  let previewing = false;
  let disposed = false;
  let activeItemId = null;
  let loading = false;
  let buffering = false;
  let loadingItemId = null;
  let queueItems = [];
  let queueRows = [];
  const queueNames = new Map();
  let refreshFilesTimer;
  const listeners = [];
  let loadState;
  const fallbackMessage = 'YouTube 임베드 오류로 대체 플레이어를 사용합니다.';
  const loadingLabel = text => {
    const overlay = el('loading-overlay');
    const label = overlay?.querySelector?.('span:last-child');
    if (label) label.textContent = text;
  };
  function playerMessage(error, info = false) {
    const node = el('player-error');
    if (!node) return;
    node.textContent = error ? String(error.message || error) : '';
    node.className = info ? 'player-info' : '';
    node.setAttribute('role', info ? 'status' : 'alert');
  }
  function replaceMount() {
    const wrap = doc.querySelector?.('.player-wrap');
    if (wrap) {
      const mount = doc.createElement('div');
      mount.id = 'player';
      wrap.replaceChildren(mount);
    }
  }
  const ownsLoad = load => !disposed && load === loadState && load.id === generation;
  const ownsPlayer = (load, owner) => ownsLoad(load) && owner === load.owner && owner.active && owner.player === player;
  function failPreview(load, error) {
    if (!ownsLoad(load)) return;
    if (load.owner) load.owner.active = false;
    previewReady = false;
    previewing = false;
    buffering = false;
    if (el('fallback-badge')) el('fallback-badge').hidden = true;
    playerMessage(error);
    message(error);
    renderEditor();
    finishLoading(load.id);
  }
  function handlePlayerFailure(load, owner, error) {
    if (!ownsPlayer(load, owner)) return Promise.resolve();
    if (owner.kind === 'local') {
      return startPreview(load, 'youtube', true);
    }
    if ([101, 150, 153].includes(Number(error.code)) && !load.localAttempted && !load.youtubeFallbackAttempted) {
      return startPreview(load, 'local', true);
    }
    failPreview(load, error);
    return Promise.resolve();
  }
  function startPreview(load, kind, switched = false) {
    if (!ownsLoad(load)) return Promise.resolve();
    const taskKey = kind === 'local' ? 'localTask' : switched ? 'youtubeFallbackTask' : 'youtubeTask';
    if (load[taskKey]) return load[taskKey];
    if (kind === 'local') load.localAttempted = true;
    else if (switched) load.youtubeFallbackAttempted = true;
    const previousOwner = load.owner;
    if (previousOwner) previousOwner.active = false;
    const reusable = kind === 'youtube' && !switched && player && !previousOwner;
    if (!reusable) { const old = player; player = undefined; old?.destroy(); replaceMount(); }
    const owner = { kind, active: true, player: reusable ? player : undefined };
    load.owner = owner;
    previewReady = false;
    previewing = false;
    buffering = false;
    loading = true;
    loadingLabel(kind === 'local' ? '대체 플레이어 준비 중…' : 'YouTube 플레이어 불러오는 중…');
    message(null);
    playerMessage(switched ? (kind === 'local' ? fallbackMessage : '대체 플레이어를 준비하지 못해 YouTube 플레이어로 전환합니다.') : null, switched);
    if (el('fallback-badge')) el('fallback-badge').hidden = kind !== 'local';
    renderEditor();
    renderLoading();
    // 전환 작업을 먼저 등록하여 onError와 load 거부를 같은 작업으로 합친다.
    load[taskKey] = Promise.resolve().then(async () => {
      if (!ownsLoad(load) || !owner.active) return;
      try {
        if (!reusable) {
          const options = {
            onTime: sec => { if (ownsPlayer(load, owner)) onTime(sec); },
            onError: error => { if (ownsPlayer(load, owner)) void handlePlayerFailure(load, owner, error); },
            onBuffering: value => { if (ownsPlayer(load, owner)) { buffering = value; renderLoading(); } },
            prepare: async videoId => {
              if (!ownsPlayer(load, owner)) throw new Error('취소된 미리보기 요청입니다.');
              return unwrap(await ytcut.preparePreview(videoId, load.cap));
            },
          };
          owner.player = (kind === 'local' ? localFactory : youtubeFactory)('player', options);
          player = owner.player;
        }
        await owner.player.load(kind === 'local' ? copy(state.video) : state.video.videoId, state.timeline.playheadSec || 0);
        if (!ownsPlayer(load, owner)) return;
        previewReady = true;
        renderEditor();
        finishLoading(load.id);
      } catch (error) {
        if (ownsPlayer(load, owner)) await handlePlayerFailure(load, owner, error);
      }
    });
    return load[taskKey];
  }
  function onPlayerError(error) {
    if (loadState?.owner) void handlePlayerFailure(loadState, loadState.owner, error);
  }
  const message = error => {
    const text = error ? String(error.message || error) : '';
    if (el('app-error')) el('app-error').textContent = text;
    if (el('settings-dialog')?.open && el('settings-error')) el('settings-error').textContent = text;
  };
  const listen = (id, event, fn) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener(event, fn);
    listeners.push(() => node.removeEventListener(event, fn));
  };
  const ytdlpEnabled = ['ytdlpState', 'checkYtdlp', 'onYtdlpChanged'].every(name => typeof ytcut[name] === 'function');
  let ytdlp = null, ytdlpPushes = 0, ytdlpBusy = false, ytdlpFlashTimer;
  let unsubscribeYtdlp;
  function renderYtdlp() {
    if (disposed || !ytdlpEnabled || !ytdlp) return;
    const { status, currentVersion, latestVersion, percent, manual, error } = ytdlp;
    el('ytdlp-current-version').textContent = currentVersion ? `현재 버전 ${currentVersion}` : '현재 버전 확인 중';
    const check = el('ytdlp-check-button');
    check.disabled = ytdlpBusy || status === 'checking';
    check.textContent = check.disabled ? '확인 중…' : '지금 확인';
    const texts = {
      checking: '확인 중…',
      downloading: `새 버전 ${latestVersion} 다운로드 중… ${Number.isFinite(percent) ? percent : 0}%`,
      'downloaded-pending': `${latestVersion} 준비됨 — 진행 중인 다운로드가 끝나면 적용됩니다`,
      updated: `${currentVersion} 으로 업데이트되었습니다`,
      'up-to-date': '최신 버전입니다',
      available: `새 버전 ${latestVersion} 이 있습니다(자동 업데이트가 꺼져 있습니다)`,
      disabled: '사용자 지정 경로를 쓰므로 자동 업데이트하지 않습니다',
      error: manual ? String(error?.message || 'yt-dlp 업데이트 확인에 실패했습니다') : '',
    };
    el('ytdlp-status').textContent = texts[status] || '';
    el('ytdlp-status').className = status === 'error' && manual ? 'update-error' : '';
    if (currentVersion && el('tools')) {
      el('tools').textContent = el('tools').textContent.replace(/^yt-dlp .*?(?= · ffmpeg )/, `yt-dlp ${currentVersion}`);
    }
  }
  function acceptYtdlp(value) {
    ytdlp = value;
    renderYtdlp();
    if (value.status === 'updated') {
      clearTimeout(ytdlpFlashTimer);
      el('ytdlp-flash').hidden = false;
      ytdlpFlashTimer = setTimeout(() => { el('ytdlp-flash').hidden = true; }, 6000);
    }
  }
  let ytdlpInitialized = Promise.resolve();
  if (ytdlpEnabled) {
    el('ytdlp-check-button')?.parentElement?.removeAttribute('hidden');
    unsubscribeYtdlp = ytcut.onYtdlpChanged(value => {
      if (disposed) return;
      ytdlpPushes++;
      acceptYtdlp(value);
    });
    const pushes = ytdlpPushes;
    ytdlpInitialized = Promise.resolve().then(() => ytcut.ytdlpState()).then(unwrap).then(value => {
      if (!disposed && pushes === ytdlpPushes) acceptYtdlp(value);
    }).catch(() => {});
    listen('ytdlp-check-button', 'click', async () => {
      if (disposed || ytdlpBusy || ytdlp?.status === 'checking') return;
      ytdlpBusy = true;
      const pushes = ytdlpPushes;
      ytdlp = { ...ytdlp, status: 'checking', manual: true };
      renderYtdlp();
      try {
        const value = unwrap(await ytcut.checkYtdlp());
        if (!disposed && pushes === ytdlpPushes && value?.status) acceptYtdlp(value);
      } catch (error) {
        if (!disposed && pushes === ytdlpPushes) acceptYtdlp({ ...ytdlp, status: 'error', manual: true, error });
      } finally { ytdlpBusy = false; renderYtdlp(); }
    });
  }
  const updateEnabled = ['updateState', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'onUpdateChanged']
    .every(name => typeof ytcut[name] === 'function');
  let update = null;
  let updatePushes = 0;
  let updateBusy = false;
  const dismissedVersions = new Set();
  let dismissedError = false;
  let unsubscribeUpdate;
  const updateFailure = '업데이트 확인에 실패했습니다';
  function renderUpdate() {
    if (disposed || !updateEnabled || !update) return;
    const { status, latestVersion, currentVersion, manual, canAutoUpdate } = update;
    const banner = el('update-banner');
    const action = el('update-banner-action');
    const dismiss = el('update-banner-dismiss');
    const progress = el('update-progress');
    const check = el('update-check-button');
    const result = el('update-check-result');
    el('update-current-version').textContent = currentVersion ? `현재 버전 v${currentVersion}` : '현재 버전 확인 중';
    check.disabled = updateBusy || status === 'checking';
    check.textContent = check.disabled ? '확인 중…' : '업데이트 확인';
    result.textContent = status === 'not-available' && manual ? '최신 버전입니다'
      : status === 'error' && manual ? updateFailure : '';
    result.className = status === 'error' ? 'update-error' : 'update-success';
    banner.hidden = !(['available', 'downloading', 'downloaded'].includes(status)
      || (status === 'error' && manual && !dismissedError));
    if (['available', 'downloaded'].includes(status) && dismissedVersions.has(latestVersion)) banner.hidden = true;
    banner.className = status === 'error' ? 'update-error' : status === 'downloaded' ? 'update-success' : '';
    action.hidden = !['available', 'downloaded'].includes(status);
    action.disabled = updateBusy;
    action.textContent = status === 'downloaded' ? '재시작하여 설치'
      : canAutoUpdate ? '다운로드' : '릴리즈 페이지 열기';
    dismiss.hidden = !['available', 'downloaded', 'error'].includes(status);
    dismiss.textContent = status === 'error' ? '닫기' : '나중에';
    progress.hidden = status !== 'downloading';
    const percent = Number.isFinite(update.percent) ? Math.max(0, Math.min(100, update.percent)) : 0;
    progress.value = percent;
    progress.textContent = `${percent}%`;
    el('update-banner-text').textContent = status === 'available' ? `새 버전 v${latestVersion} 이 있습니다`
      : status === 'downloaded' ? `v${latestVersion} 다운로드 완료`
      : status === 'downloading' ? `업데이트 다운로드 중… ${percent}%`
      : status === 'error' ? updateFailure : '';
  }
  async function updateRequest(method) {
    if (disposed || updateBusy) return;
    updateBusy = true;
    const pushes = updatePushes;
    if (method === 'checkUpdate') {
      dismissedError = false;
      update = { ...update, status: 'checking', manual: true };
    }
    renderUpdate();
    try {
      const value = unwrap(await ytcut[method]());
      if (!disposed && pushes === updatePushes && value?.status) {
        update = value;
      }
    } catch {
      if (!disposed && pushes === updatePushes) {
        update = { ...update, status: 'error', manual: true };
        dismissedError = false;
      }
    } finally {
      updateBusy = false;
      renderUpdate();
    }
  }
  let updateInitialized = Promise.resolve();
  if (updateEnabled) {
    const check = el('update-check-button');
    check?.parentElement?.removeAttribute('hidden');
    unsubscribeUpdate = ytcut.onUpdateChanged(value => {
      if (disposed) return;
      updatePushes++;
      update = value;
      if (value.status !== 'error') dismissedError = false;
      renderUpdate();
    });
    const pushes = updatePushes;
    updateInitialized = Promise.resolve().then(() => ytcut.updateState()).then(unwrap).then(value => {
      if (!disposed && pushes === updatePushes) { update = value; renderUpdate(); }
    }).catch(() => {});
    listen('update-check-button', 'click', () => updateRequest('checkUpdate'));
    listen('update-banner-action', 'click', () => updateRequest(update?.status === 'downloaded' ? 'installUpdate' : 'downloadUpdate'));
    listen('update-banner-dismiss', 'click', () => {
      if (update?.status === 'error') dismissedError = true;
      else dismissedVersions.add(update?.latestVersion);
      renderUpdate();
    });
  }
  const attempt = fn => async event => {
    try { await fn(event); } catch (error) { message(error); }
  };
  function renderLoading() {
    if (!loading && buffering) loadingLabel('탐색 중…');
    if (el('loading-overlay')) el('loading-overlay').hidden = !(loading || buffering);
    if (el('load-button')) el('load-button').disabled = loading;
    for (const row of queueRows) renderRowLoading(row);
  }
  function renderRowLoading({ row, status, item, statusName, statusText }) {
    const isLoading = loading && item.id === loadingItemId && item.fileDeleted !== true;
    row.className = 'queue-item status-' + statusName + (item.id === activeItemId ? ' active' : '') + (isLoading ? ' is-loading' : '');
    status.replaceChildren();
    status.textContent = isLoading ? '' : statusText;
    if (!isLoading) return;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const spinner = doc.createElement('span');
    spinner.className = 'loading-spinner queue-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span');
    label.className = 'sr-only';
    label.textContent = '불러오는 중';
    status.append(spinner);
    status.append(label);
  }
  function finishLoading(requestId) {
    if (disposed || requestId !== generation) return;
    loading = false;
    loadingItemId = null;
    renderLoading();
  }
  function renderEditor() {
    if (el('editor-format')) el('editor-format').value = state.format;
    if (el('editor-cut-mode')) el('editor-cut-mode').value = state.cutMode;
    if (el('file-name-input')) {
      el('file-name-input').value = state.fileName || '';
      el('file-name-input').disabled = !ready;
    }
    if (el('download-button')) el('download-button').disabled = !ready;
    for (const id of ['mark-start-button', 'mark-end-button', 'preview-button']) {
      if (el(id)) el(id).disabled = !ready || !previewReady;
    }
    for (const id of ['start-input', 'end-input', 'zoom-input', 'editor-format', 'editor-cut-mode', 'start-handle', 'end-handle']) el(id).disabled = !ready;
    if (el('editor')) el('editor').className = ready ? 'editor' : 'editor is-disabled';
    el('timeline-scroll').tabIndex = ready ? 0 : -1;
    el('timeline-scroll').style.pointerEvents = ready ? '' : 'none';
    if (ready && state.video) timelineView.set(copy(state.video), copy(state.timeline));
  }
  async function edit(video, restored) {
    message(null);
    playerMessage(null);
    if (!restored) activeItemId = null;
    const requestId = ++generation;
    buffering = false;
    if (loadState) {
      if (loadState.owner) loadState.owner.active = false;
      const old = player; player = undefined; old?.destroy();
    }
    loadState = undefined;
    if (el('fallback-badge')) el('fallback-badge').hidden = true;
    loadingLabel('영상 불러오는 중…');
    loading = true;
    loadingItemId = restored ? activeItemId : null;
    renderLoading();
    ready = false;
    previewReady = false;
    previewing = false;
    state = restored ? { ...copy(restored), fileName: restored.fileName ?? restored.snapshot?.fileName ?? '' } : {
      video: copy(video), timeline: { startSec: 0, endSec: 0, zoom: 1, scrollSec: 0, playheadSec: 0 },
      cutMode: settings.cutMode, format: settings.format, fileName: '',
    };
    renderEditor();
    try {
      await bootstrapped;
      if (disposed || requestId !== generation) return;
      const load = { id: requestId, cap: settings.previewResolution, always: settings.alwaysUseLocalPlayer, localAttempted: false, youtubeFallbackAttempted: false };
      loadState = load;
      if (!restored) { state.cutMode = settings.cutMode; state.format = settings.format; }
      const metadataRequest = crypto.randomUUID();
      const result = await ytcut.metadata({ url: video.url, requestId: metadataRequest });
      if (!result.ok) throw result.error;
      if (result.value.requestId !== metadataRequest) { finishLoading(requestId); return; }
      const metadata = result.value.video;
      if (disposed || requestId !== generation) return;
      state.video = copy(metadata);
      el('video-title').textContent = metadata.title;
      if (!restored) state.timeline.endSec = Number(metadata.durationSec) || 0;
      ready = true;
      renderEditor();
      // 메타데이터 성공 후에는 미리보기 실패와 무관하게 숫자 편집을 허용한다.
      void startPreview(load, load.always ? 'local' : 'youtube');
    } catch (error) {
      if (requestId === generation && !disposed) { message(error); renderEditor(); }
      finishLoading(requestId);
    }
  }
  const canRename = item => typeof ytcut.rename === 'function' && item.renameAllowed !== false
    && item.fileDeleted !== true && (['waiting', 'failed', 'cancelled'].includes(item.status)
      || (item.status === 'completed' && !!item.outputPath));
  const queueTitle = item => {
    const original = String(item.snapshot.video?.title || item.snapshot.video?.url || '동영상');
    const name = item.fileName ?? item.snapshot.fileName ?? '';
    return item.status === 'completed' ? item.outputFileName || original
      : name === '' ? original : name + '.' + item.snapshot.format;
  };
  function cancelName(id) {
    const edit = queueNames.get(id);
    if (!edit) return;
    edit.editingNode = null;
    edit.error = '';
    renderQueue(queueItems);
  }
  function beginName(id) {
    const item = queueItems.find(item => item.id === id);
    if (disposed || !item || !canRename(item)) return;
    const previous = queueNames.get(id);
    if (previous?.pending || previous?.editingNode) return;
    const edit = { draft: item.fileName ?? item.snapshot.fileName ?? '', pending: false, error: '', editingNode: doc.createElement('input'), composing: false };
    queueNames.set(id, edit);
    const input = edit.editingNode;
    input.type = 'text';
    input.className = 'queue-name-input';
    input.setAttribute('aria-label', '파일명 변경');
    input.value = edit.draft;
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('input', () => { edit.draft = input.value; });
    input.addEventListener('compositionstart', () => { edit.composing = true; });
    input.addEventListener('compositionend', () => { edit.composing = false; edit.draft = input.value; });
    input.addEventListener('blur', () => { if (edit.editingNode === input) cancelName(id); });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || edit.composing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); cancelName(id); }
      if (event.key === 'Enter') {
        event.preventDefault();
        void submitName(id, edit);
      }
    });
    renderQueue(queueItems);
    input.focus();
  }
  async function submitName(id, edit) {
    const current = queueItems.find(item => item.id === id);
    if (disposed || edit.pending || !edit.editingNode || !current || !canRename(current)) return;
    edit.draft = edit.editingNode.value;
    edit.pending = true;
    edit.error = '';
    const requestedRevision = revision;
    try {
      const response = unwrap(await ytcut.rename(id, edit.draft));
      // 공통 IPC 래퍼 안에 jobs.rename의 성공 응답이 들어오는 경우도 처리한다.
      const value = typeof response?.ok === 'boolean' ? unwrap(response) : response;
      if (disposed || queueNames.get(id) !== edit) return;
      edit.editingNode = null;
      // 새 push가 도착했다면 해당 revision의 항목을 우선한다.
      if (revision === requestedRevision && value?.id === id) {
        queueItems = queueItems.map(item => item.id === id ? { ...item, ...value } : item);
      }
    } catch (error) {
      if (disposed || queueNames.get(id) !== edit) return;
      edit.error = [error.code, error.message || String(error)].filter(Boolean).join(': ');
    } finally {
      edit.pending = false;
      if (!disposed) renderQueue(queueItems);
    }
  }
  function renderQueue(queue) {
    queueItems = queue;
    const root = el('queue-list');
    if (!root) return;
    if (el('queue-count')) el('queue-count').textContent = String(queue.length);
    if (el('queue-empty')) el('queue-empty').hidden = queue.length > 0;
    const previousRows = new Map(queueRows.map(value => [value.item.id, value]));
    const preserveEditor = [...queueNames.values()].some(edit => edit.editingNode);
    if (!preserveEditor) root.replaceChildren();
    for (const old of queueRows) {
      if (!queue.some(item => item.id === old.item.id)) {
        queueNames.delete(old.item.id);
        if (preserveEditor) root.removeChild(old.row);
      }
    }
    queueRows = [];
    const statuses = { waiting: '대기', running: '진행', completed: '완료', failed: '실패', cancelled: '취소' };
    const createdTime = item => {
      const value = typeof item.createdAt === 'number' ? item.createdAt : Date.parse(item.createdAt);
      return Number.isFinite(value) ? value : 0;
    };
    const sorted = [...queue].sort((a, b) => createdTime(b) - createdTime(a));
    const icons = {
      rename: 'M4 16l-1 5 5-1L20 8l-4-4z M14 6l4 4',
      openOutput: 'M3 7h6l2 2h10v11H3z M3 7V4h7l2 3',
      openFile: 'M6 3h8l4 4v14H6z M14 3v5h4 M10 12l5 3-5 3z',
      deleteFile: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
      remove: 'M6 6l12 12 M18 6L6 18',
      cancel: 'M6 6h12v12H6z',
      retry: 'M4 11a8 8 0 1 1 2 7 M4 4v7h7',
    };
    const labels = { rename: '파일명 변경', openOutput: '폴더 열기', openFile: '파일 열기', deleteFile: '파일 삭제', remove: '목록에서 제거', cancel: '취소', retry: '재시도' };
    for (const item of sorted) {
      const previous = previousRows.get(item.id);
      const row = previous?.row || doc.createElement('li');
      const statusName = Object.hasOwn(statuses, item.status) ? item.status : 'waiting';
      row.tabIndex = 0;
      const title = previous?.title || doc.createElement('span');
      title.className = 'queue-title';
      const nameEdit = queueNames.get(item.id);
      if (nameEdit?.editingNode && !canRename(item)) {
        nameEdit.editingNode = null;
        nameEdit.error = item.fileDeleted === true ? '삭제된 파일' : '현재 작업은 파일명을 변경할 수 없습니다.';
      }
      if (nameEdit?.editingNode) {
        if (title.children[0] !== nameEdit.editingNode) { title.replaceChildren(); title.append(nameEdit.editingNode); }
        nameEdit.editingNode.readOnly = nameEdit.pending;
      } else { title.replaceChildren(); title.textContent = queueTitle(item); }
      row.title = `${queueTitle(item)}\n${String(item.snapshot.format).toUpperCase()}${item.error ? '\n' + (item.error.code || '') + ': ' + (item.error.message || item.error) : ''}`;
      const nameError = previous?.nameError || doc.createElement('span');
      nameError.className = 'queue-name-error';
      nameError.setAttribute('role', 'alert');
      nameError.textContent = nameEdit?.error || '';
      nameError.hidden = !nameEdit?.error;
      const meta = previous?.meta || doc.createElement('div');
      meta.replaceChildren();
      meta.className = 'queue-meta';
      const range = doc.createElement('span');
      range.className = 'queue-range';
      range.textContent = formatTime(item.snapshot.timeline.startSec) + ' – ' + formatTime(item.snapshot.timeline.endSec);
      meta.append(range);
      const status = doc.createElement('span');
      status.className = 'status-badge';
      const percentage = Math.max(0, Math.min(100, Number(item.progress) || 0));
      const eta = typeof item.etaSec === 'number' && Number.isFinite(item.etaSec)
        ? Math.max(0, Math.ceil(item.etaSec)) : null;
      const remaining = eta === null ? '' : ' · ' + (eta >= 60
        ? Math.floor(eta / 60) + '분 ' + eta % 60 + '초' : eta + '초') + ' 남음';
      status.textContent = item.fileDeleted === true ? '삭제된 파일'
        : statusName === 'running' ? (item.phase === 'processing' ? '후처리 중'
          : '진행 ' + Math.round(percentage) + '%' + remaining) : statuses[statusName];
      const renderedRow = { row, title, nameError, meta, status, item, statusName, statusText: status.textContent };
      queueRows.push(renderedRow);
      renderRowLoading(renderedRow);
      meta.append(status);
      meta.append(nameError);
      const progressRow = previous?.progressRow || doc.createElement('div');
      renderedRow.progressRow = progressRow;
      progressRow.replaceChildren();
      progressRow.className = 'queue-progress';
      const progress = doc.createElement('progress');
      progress.className = 'progress';
      progress.max = 100;
      progress.value = percentage;
      progress.setAttribute('aria-label', '다운로드 진행률');
      progress.textContent = progress.value + '%';
      progressRow.append(progress);
      const actions = previous?.actions || doc.createElement('div');
      renderedRow.actions = actions;
      actions.replaceChildren();
      actions.className = 'queue-actions';
      const available = item.fileDeleted === true ? ['openOutput', 'remove'] : statusName === 'completed'
        ? ['openOutput', 'openFile', 'deleteFile', 'remove']
        : ['failed', 'cancelled'].includes(statusName) ? ['retry', 'openOutput', 'remove'] : ['cancel'];
      if (typeof ytcut.rename === 'function' && item.fileDeleted !== true
        && (['waiting', 'failed', 'cancelled'].includes(statusName) || (statusName === 'completed' && item.outputPath))) available.unshift('rename');
      for (const action of available) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'queue-action' + (['deleteFile', 'remove'].includes(action) ? ' destructive' : '');
        button.setAttribute('data-action', action);
        button.setAttribute('data-tip', labels[action]);
        button.setAttribute('aria-label', labels[action]);
        button.setAttribute('title', '');
        if (action === 'rename') button.disabled = !canRename(item) || !!nameEdit?.pending;
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', icons[action]);
        svg.append(path);
        button.append(svg);
        button.addEventListener('click', attempt(async event => {
          event.stopPropagation();
          const current = queueItems.find(value => value.id === item.id);
          if (!current || disposed) return;
          if (action === 'rename') { beginName(item.id); return; }
          if (current.fileDeleted === true && ['openFile', 'deleteFile'].includes(action)) return;
          unwrap(await ytcut[action](item.id));
        }));
        actions.append(button);
      }
      const restore = () => {
        const current = queueItems.find(value => value.id === item.id);
        if (!current || disposed) return;
        activeItemId = item.id;
        void edit(current.snapshot.video, { ...current.snapshot, fileName: current.fileName ?? current.snapshot.fileName ?? '' });
      };
      if (!previous) {
        for (const node of [title, meta, progressRow, actions]) row.append(node);
        row.addEventListener('click', restore);
        row.addEventListener('keydown', event => {
          if (event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); restore(); }
        });
      }
      const index = queueRows.length - 1;
      if (root.children?.[index] !== row) {
        if (root.insertBefore) root.insertBefore(row, root.children?.[index] || null);
        else root.append(row);
      }
    }
  }
  function apply(payload) {
    if (disposed) return;
    if (payload.settings) {
      settings = { ...settings, ...copy(payload.settings), format: payload.settings.format || 'mp4', previewResolution: payload.settings.previewResolution === undefined ? settings.previewResolution : payload.settings.previewResolution, alwaysUseLocalPlayer: payload.settings.alwaysUseLocalPlayer === undefined ? settings.alwaysUseLocalPlayer : payload.settings.alwaysUseLocalPlayer };
      if (!el('settings-dialog')?.open) fillSettings();
      // Initial settings seed the editor only before the first edit.
      if (generation === 0) {
        state.format = settings.format;
        state.cutMode = settings.cutMode;
        renderEditor();
      }
    }
    if (Number.isFinite(payload.revision) && payload.revision > revision) {
      revision = payload.revision;
      renderQueue(payload.items);
    }
    if (payload.tools && el('tools')) {
      // ffmpeg 는 배너 전체가 version 으로 오므로 첫 줄의 버전 토큰만 보여준다.
      const shortVersion = text => String(text || '').split('\n')[0].replace(/^ffmpeg version\s+/, '').split(' ')[0];
      const label = (name, tool) => `${name} ${tool?.ok ? shortVersion(tool.version) : '사용 불가'}`;
      el('tools').textContent = `${label('yt-dlp', payload.tools.ytDlp)} · ${label('ffmpeg', payload.tools.ffmpeg)}`;
      renderYtdlp();
    }
    if (payload.error) message(payload.error);
  }
  // Subscribe before invoking bootstrap so a late bootstrap cannot undo a push.
  const unsubscribe = ytcut.onQueueChanged(apply);
  const onChange = timeline => { if (ready) state.timeline = copy(timeline); };
  const onTime = seconds => {
    if (!ready || !previewReady) return;
    if (previewing && seconds >= state.timeline.endSec) {
      previewing = false;
      seconds = state.timeline.endSec;
      Promise.resolve(player.pause()).catch(message);
      Promise.resolve(player.seek(seconds)).catch(message);
    }
    // yt-dlp 의 durationSec 은 정수로 내림될 수 있어 끝까지 재생하면 플레이어 시간이 더 크다. 검증 범위로 자른다.
    state.timeline.playheadSec = Math.min(Math.max(seconds, 0), state.video.durationSec);
    timelineView.set(copy(state.video), copy(state.timeline));
  };
  const onSeek = seconds => {
    if (!ready || !previewReady) return;
    previewing = false;
    state.timeline.playheadSec = Math.min(Math.max(seconds, 0), state.video.durationSec);
    player.seekAndPlay(seconds).catch(message);
  };
  const currentTime = () => Math.min(state.video.durationSec, Math.max(0, Number(player.getTime()) || 0));
  const preview = () => {
    if (!ready || !previewReady) return;
    previewing = true;
    state.timeline.playheadSec = state.timeline.startSec;
    timelineView.set(copy(state.video), copy(state.timeline));
    Promise.resolve(player.seekAndPlay(state.timeline.startSec)).catch(error => {
      previewing = false;
      message(error);
    });
  };
  const mark = field => {
    if (!ready || !previewReady) return;
    const sec = currentTime();
    if (field === 'startSec' ? sec >= state.timeline.endSec : sec <= state.timeline.startSec) {
      message(field === 'startSec' ? '시작은 끝보다 앞이어야 합니다' : '끝은 시작보다 뒤여야 합니다');
      return;
    }
    state.timeline = normalizeTimeline({ ...state.timeline, [field]: sec }, state.video.durationSec);
    message(null);
    timelineView.set(copy(state.video), copy(state.timeline));
  };
  const textTarget = target => {
    if (target?.isContentEditable || target?.closest?.('[contenteditable]:not([contenteditable="false"])')) return true;
    const tag = target?.tagName?.toLowerCase();
    return tag === 'textarea' || tag === 'select' || (tag === 'input' &&
      !['range', 'button', 'submit', 'reset', 'checkbox', 'radio', 'color', 'file', 'image', 'hidden'].includes(target.type?.toLowerCase()));
  };
  const download = attempt(async () => {
    if (!ready) return;
    const snapshot = copy(state);
    snapshot.fileName = state.fileName || '';
    unwrap(await ytcut.add({ snapshot }));
  });
  let spaceHeld = false;
  const keyboard = event => {
    if (el('settings-dialog')?.open) { spaceHeld = false; return; }
    const space = event.code === 'Space' || event.key === ' ';
    // A handled Space release must stay suppressed even if focus/load changes.
    if (event.type === 'keyup' && space && spaceHeld) {
      event.preventDefault(); event.stopPropagation(); spaceHeld = false; return;
    }
    if (!ready || textTarget(event.target) || event.altKey || event.metaKey || event.isComposing) return;
    const key = event.key?.toLowerCase();
    // 임베드가 막힌 영상(미리보기 불가)에서도 Space 는 가로채야 포커스된 버튼(예: 다운로드)이 눌려 중복 실행되지 않는다.
    // '[' 는 다운로드 버튼과 같다(미리보기 가능 여부와 무관, 버튼처럼 ready 만 필요).
    if (!space && key !== '[' && (!previewReady || !['arrowleft', 'arrowright', 'i', 'o', 'p'].includes(key))) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'keyup') return;
    if (space) {
      spaceHeld = true;
      previewing = false;
      if (!event.repeat && previewReady) Promise.resolve(player.togglePlay()).catch(message);
    } else if (key === '[') {
      if (!event.repeat) void download();
    } else if (key === 'p') {
      if (!event.repeat) preview();
    } else if (key === 'i' || key === 'o') {
      mark(key === 'i' ? 'startSec' : 'endSec');
    } else {
      previewing = false;
      const duration = state.video.durationSec;
      const sec = Math.max(0, Math.min(duration, currentTime() + (key === 'arrowleft' ? -1 : 1) * (event.ctrlKey ? 1 : event.shiftKey ? 60 : 10)));
      const span = duration / (state.timeline.zoom || 1);
      let scrollSec = state.timeline.scrollSec || 0;
      if (sec < scrollSec || sec > scrollSec + span) scrollSec = sec - span / 2;
      state.timeline = normalizeTimeline({ ...state.timeline, playheadSec: sec, scrollSec }, duration);
      timelineView.set(copy(state.video), copy(state.timeline));
      Promise.resolve(player.seek(sec)).catch(message);
    }
  };
  if (doc.addEventListener) {
    for (const type of ['keydown', 'keyup']) {
      doc.addEventListener(type, keyboard, true);
      listeners.push(() => doc.removeEventListener(type, keyboard, true));
    }
  }
  listen('mark-start-button', 'click', () => mark('startSec'));
  listen('mark-end-button', 'click', () => mark('endSec'));
  listen('preview-button', 'click', preview);
  listen('load-button', 'click', () => { void edit({ url: el('url-input').value }); });
  listen('editor-format', 'change', event => { state.format = event.target.value; });
  listen('editor-cut-mode', 'change', event => { state.cutMode = event.target.value; });
  listen('file-name-input', 'input', event => { state.fileName = event.target.value; });
  if (typeof ytcut.refreshFiles === 'function') {
    listen('queue-list', 'pointerenter', event => {
      if (disposed || (event.target && event.target !== el('queue-list'))) return;
      clearTimeout(refreshFilesTimer);
      refreshFilesTimer = setTimeout(() => {
        refreshFilesTimer = undefined;
        if (disposed) return;
        Promise.resolve().then(() => { if (!disposed) return ytcut.refreshFiles(); })
          .then(result => { if (!disposed && result) unwrap(result); })
          .catch(error => { if (!disposed) message(error); });
      }, 1000);
    });
  }
  listen('download-button', 'click', download);
  listen('settings-form', 'submit', attempt(async event => {
    event.preventDefault();
    if (el('settings-error')) el('settings-error').textContent = '';
    const pending = {};
    for (const key of Object.keys(settingsIds)) {
      pending[key] = ['autoUpdateYtDlp', 'alwaysUseLocalPlayer'].includes(key) ? (el(settingsIds[key])?.checked ?? settings[key] !== false)
        : key === 'previewResolution' ? Number(el(settingsIds[key])?.value || settings[key]) : el(settingsIds[key])?.value || settings[key];
    }
    settings = copy(unwrap(await ytcut.saveSettings(copy(pending))));
    closeSettings();
  }));
  function fillSettings() {
    for (const [key, id] of Object.entries(settingsIds)) {
      const node = el(id);
      if (node && ['autoUpdateYtDlp', 'alwaysUseLocalPlayer'].includes(key)) node.checked = settings[key] !== false;
      else if (node) node.value = String(settings[key] ?? '');
    }
  }
  const categories = ['general', 'tools', 'update'];
  function selectCategory(index, focus = false) {
    categories.forEach((category, i) => {
      const tab = el(`settings-tab-${category}`);
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      el(`settings-panel-${category}`).hidden = i !== index;
      if (focus && i === index) tab.focus();
    });
  }
  function closeSettings() {
    if (el('settings-dialog')?.open) el('settings-dialog').close();
  }
  listen('settings-button', 'click', () => {
    fillSettings();
    selectCategory(0);
    el('settings-error').textContent = '';
    if (!el('settings-dialog').open) el('settings-dialog').showModal();
  });
  listen('settings-close-button', 'click', closeSettings);
  listen('settings-dismiss-button', 'click', closeSettings);
  listen('settings-dialog', 'close', () => el('settings-button').focus());
  listen('settings-dialog', 'click', event => {
    if (event.target !== el('settings-dialog')) return;
    const rect = event.target.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeSettings();
  });
  categories.forEach((category, index) => {
    listen(`settings-tab-${category}`, 'click', () => selectCategory(index));
    listen(`settings-tab-${category}`, 'keydown', event => {
      const next = { ArrowUp: (index + 2) % 3, ArrowDown: (index + 1) % 3, Home: 0, End: 2 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      selectCategory(next, true);
    });
  });
  listen('choose-output-button', 'click', attempt(async () => {
    const { outputDir } = unwrap(await ytcut.chooseOutput());
    if (outputDir) el('output-dir').value = outputDir;
  }));
  renderEditor();
  renderLoading();
  const bootstrapped = Promise.resolve().then(() => ytcut.bootstrap()).then(unwrap).then(apply).catch(message);
  return {
    bootstrapped, updateInitialized, ytdlpInitialized, edit, onChange, onSeek, onTime, onPlayerError,
    getState: () => copy(state),
    dispose() {
      disposed = true;
      generation++;
      loading = false;
      buffering = false;
      loadingItemId = null;
      renderLoading();
      unsubscribe?.();
      unsubscribeUpdate?.();
      unsubscribeYtdlp?.();
      clearTimeout(ytdlpFlashTimer);
      clearTimeout(refreshFilesTimer);
      queueNames.clear();
      for (const remove of listeners) remove();
      if (loadState?.owner) loadState.owner.active = false;
      player?.destroy(); timelineView.destroy();
    },
  };
}

export async function startApp() {
  const { createTimelineView } = await import('./timeline-view.js');
  let app;
  const timelineView = createTimelineView(document.getElementById('timeline'), {
    onChange: state => app?.onChange(state), onSeek: sec => app?.onSeek(sec),
  });
  app = createApp({ timelineView, ytcut: window.ytcut, document });
  return app;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => startApp().catch(error => {
    const node = document.getElementById('app-error');
    if (node) node.textContent = String(error.message || error);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else void start();
}
