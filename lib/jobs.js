import { validateSnapshot, transition, recoverItems, normalizeFileName, defaultFileStem } from './queue-state.js';
import path from 'node:path';
import { stat, lstat, realpath, readdir, rename } from 'node:fs/promises';
const actionError = (code, message) => Object.assign(new Error(message), { code });
export function outputFolder(item, paths = path) {
  const base = item?.execution?.outputDir;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item?.id || '') ||
      typeof base !== 'string' || !paths.isAbsolute(base) || /[\0\r\n]/.test(base)) {
    throw actionError('INVALID_OUTPUT_PATH', 'Invalid job output folder');
  }
  const root = paths.resolve(base), target = paths.join(root, item.id);
  if (paths.dirname(target) !== root || paths.relative(root, target) !== item.id) {
    throw actionError('INVALID_OUTPUT_PATH', 'Output folder must be a direct child');
  }
  return target;
}
const copy = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function createJobs({ store, runner, clock = globalThis, uuid = () => globalThis.crypto.randomUUID(), onChange = () => {}, fileActions = {} }) {
  let items = [], active = null, halted = false, closing = false;
  let queue = Promise.resolve(), progressTimer = null, saveTimer = null;
  let document;
  let scanInProgress = false;
  const pending = new Map();
  const now = () => new Date(typeof clock.now === 'function' ? clock.now() : Date.now()).toISOString();
  const list = () => items.map(item => ({ ...copy(item), renameAllowed: !closing && !halted && item.status !== 'running' && active?.id !== item.id && (item.status === 'completed' ? !item.fileDeleted && !!item.outputPath : ['waiting', 'failed', 'cancelled'].includes(item.status)) }));
  const publish = error => {
    try { onChange({ revision: document?.revision ?? 0, items: list() }, error); } catch { /* Observers cannot break persistence. */ }
  };
  const enqueue = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  async function persist() {
    try { await store.save({ ...document, revision: ++document.revision, items: copy(items) }); }
    catch (error) { halted = true; publish(error); throw error; }
  }
  const matches = (id, attempt, token) => active && active.id === id && active.attempt === attempt && active.token === token;
  function mergeProgress() {
    if (pending.size) document.revision++;
    for (const [id, value] of pending) {
      const item = items.find(item => item.id === id);
      if (item && active && active.id === id && item.status === 'running') {
        if (typeof value.progress === 'number' && Number.isFinite(value.progress)) item.progress = Math.max(0, Math.min(100, value.progress));
        if (value.phase !== undefined) item.phase = value.phase;
        if (Object.hasOwn(value, 'etaSec')) item.etaSec = typeof value.etaSec === 'number' && Number.isFinite(value.etaSec) && value.etaSec >= 0 ? value.etaSec : null;
        item.updatedAt = now();
      }
    }
    pending.clear();
  }
  function clearTimers() {
    if (progressTimer !== null) clock.clearTimeout(progressTimer);
    if (saveTimer !== null) clock.clearTimeout(saveTimer);
    progressTimer = saveTimer = null;
  }
  function progress(id, attempt, token, value) {
    if (!matches(id, attempt, token) || closing || halted) return;
    pending.set(id, { ...pending.get(id), ...copy(value) });
    if (progressTimer === null) progressTimer = clock.setTimeout(() => {
      progressTimer = null;
      enqueue(() => { if (!halted && !closing) { mergeProgress(); publish(); } });
    }, 250);
    if (saveTimer === null) saveTimer = clock.setTimeout(() => {
      saveTimer = null;
      enqueue(async () => { if (!halted && !closing) { mergeProgress(); await persist(); } }).catch(() => {});
    }, 1000);
  }
  function terminal(id, attempt, token, status, value) {
    const result = enqueue(async () => {
      if (!matches(id, attempt, token) || closing || halted) return;
      mergeProgress();
      const item = items.find(item => item.id === id);
      if (item.status !== 'cancelled') {
        Object.assign(item, transition(item, { type: status === 'completed' ? 'complete' : status === 'cancelled' ? 'cancel' : 'fail', attempt, outputPath: value?.outputPath, error: { code: value?.code || 'RUNNER_FAILED', message: value?.message || String(value) } }, now()));
        item.phase = status === 'completed' ? 'done' : item.phase;
        if (status === 'completed' && item.outputPath) item.outputFileName = value?.outputFileName || path.basename(item.outputPath);
        item.finishedAt = now();
      }
      item.updatedAt = now();
      await persist();
      active = null;
      publish();
      await pump();
    });
    result.catch(() => {});
    return result;
  }
  async function pump() {
    if (active || halted || closing) return;
    const item = items.find(item => item.status === 'waiting');
    if (!item) return;
    Object.assign(item, transition(item, { type: 'start', attempt: item.attempt }, now()));
    item.phase = 'extracting';
    const token = uuid();
    active = { id: item.id, attempt: item.attempt, token, handle: null };
    await persist();
    publish();
    const { id, attempt } = item;
    try {
      const input = copy(item);
      freeze(input.snapshot);
      const handle = runner.start(input, value => progress(id, attempt, token, value));
      active.handle = handle;
      handle.done.then(value => terminal(id, attempt, token, 'completed', value), error => terminal(id, attempt, token, error.code === 'CANCELLED' ? 'cancelled' : 'failed', error)).catch(() => {});
    } catch (error) { terminal(id, attempt, token, 'failed', error).catch(() => {}); }
  }
  let ready;
  function init(defaultSettings = {}) { return ready ??= enqueue(async () => {
    try {
      const loaded = await store.load();
      if (loaded.warning?.code === 'UNSUPPORTED_SCHEMA') throw new Error(loaded.warning.message);
      document = copy(loaded.document || { schemaVersion: 1, revision: 0, settings: defaultSettings, items: [] });
      if (!document.settings.outputDir) document.settings.outputDir = defaultSettings.outputDir;
      if (!Object.hasOwn(document.settings, 'format')) document.settings.format = 'mkv';
      if (!['mkv', 'mp4'].includes(document.settings.format)) throw new RangeError('Invalid saved settings.format');
      items = document.items;
      for (const item of items) { if (!Object.hasOwn(item.snapshot, 'format')) item.snapshot.format = 'mkv'; validateSnapshot(item.snapshot); }
      items = recoverItems(items, now());
      if (loaded.warning) publish(loaded.warning);
    }
    catch (error) { halted = true; publish(error); throw error; }
    for (const item of items) {
      item.etaSec = item.status === 'completed' || !Number.isFinite(item.etaSec) || item.etaSec < 0 ? null : item.etaSec;
      freeze(item.snapshot);
    }
    await persist();
    publish();
    await scanCompleted(false);
    await pump();
  }); }
  function requireOpen() {
    if (closing || halted) throw new Error(closing ? 'Jobs are shut down' : 'Job persistence is halted');
  }
  function findItem(id) {
    const item = items.find(item => item.id === id);
    if (!item) throw actionError('INVALID_QUEUE_ID', 'Unknown job');
    return item;
  }
  async function saveCandidate(candidateItems) {
    const candidateDocument = { ...document, revision: document.revision + 1, items: candidateItems };
    await store.save(copy(candidateDocument));
    items = candidateItems;
    document = candidateDocument;
    publish();
  }
  async function applyScan(results) {
    if (closing || halted) return;
    const candidate = copy(items);
    let changed = false;
    for (const result of results) {
      const item = candidate.find(row => row.id === result.id);
      if (!item || item.status !== result.status || item.outputPath !== result.outputPath) continue;
      if (result.missing && item.outputPath) {
        item.missingOutputPath = item.outputPath;
        item.outputPath = null;
        item.fileDeleted = true;
      } else if (result.regular && item.fileDeleted && !item.outputPath && item.missingOutputPath) {
        item.outputPath = result.path;
        item.fileDeleted = false;
        item.outputFileName = path.basename(result.path);
        delete item.missingOutputPath;
      } else continue;
      item.updatedAt = now();
      changed = true;
    }
    if (!changed) return;
    try { await saveCandidate(candidate); }
    catch (error) { halted = true; publish(error); throw error; }
  }
  async function scanCompleted(queued = true) {
    if (scanInProgress || closing || halted) return;
    scanInProgress = true;
    try {
      const captures = items.filter(item => item.status === 'completed' && (item.outputPath || (item.fileDeleted && item.missingOutputPath)))
        .map(item => ({ id: item.id, status: item.status, outputPath: item.outputPath, path: item.outputPath || item.missingOutputPath }));
      const results = [];
      for (let i = 0; i < captures.length; i += 8) {
        results.push(...await Promise.all(captures.slice(i, i + 8).map(async capture => {
          try {
            const info = await (fileActions.lstat || lstat)(capture.path);
            return { ...capture, regular: info.isFile?.() && !info.isSymbolicLink() };
          } catch (error) { return { ...capture, missing: error.code === 'ENOENT' }; }
        })));
      }
      if (queued) await enqueue(() => applyScan(results));
      else await applyScan(results);
    } finally { scanInProgress = false; }
  }
  async function checkOpen(item) {
    if (item?.status !== 'completed' || item.fileDeleted || !item.outputPath) return false;
    try { return (await (fileActions.stat || stat)(item.outputPath)).isFile(); }
    catch (error) {
      if (error.code === 'ENOENT') await applyScan([{ id: item.id, status: item.status, outputPath: item.outputPath, missing: true }]);
      return false;
    }
  }
  return {
    init, list,
    refreshCompletedFiles: () => scanCompleted(),
    resolveOpenOutput(id) {
      return enqueue(async () => {
        requireOpen();
        const item = findItem(id);
        if (await checkOpen(item)) return { kind: 'file', path: item.outputPath };
        return { kind: 'folder', path: item.execution.outputDir };
      });
    },
    get revision() { return document.revision; },
    getSettings: () => copy(document.settings),
    saveSettings(settings) { return enqueue(async () => { requireOpen(); document.settings = copy(settings); await persist(); publish(); return copy(document.settings); }); },
    openFile(id) {
      return enqueue(async () => {
        requireOpen();
        const item = items.find(item => item.id === id);
        if (!await checkOpen(item)) {
          throw actionError('NO_OUTPUT_FILE', 'No completed output file exists');
        }
        const error = await fileActions.openPath(item.outputPath);
        if (error) throw actionError('OPEN_OUTPUT_FAILED', error);
        return { opened: true };
      });
    },
    deleteFile(id) {
      return enqueue(async () => {
        requireOpen();
        const item = findItem(id);
        if (!['completed', 'failed', 'cancelled'].includes(item.status) || active?.id === id) {
          throw actionError('NOT_DELETABLE', 'Job must finish before deleting files');
        }
        const flatCompleted = item.status === 'completed' && item.execution?.outputLayout === 'flat-v1';
        const target = flatCompleted ? (item.outputPath || item.missingOutputPath) : outputFolder(item);
        let validatedOutputPath = null;
        if (!await fileActions.confirmDelete(copy(item))) return { deleted: false };
        if (flatCompleted && target != null) {
          const root = path.resolve(item.execution.outputDir);
          const lexicalTarget = path.resolve(target);
          const ext = path.extname(target).toLowerCase();
          if (!path.isAbsolute(target) || path.dirname(lexicalTarget) !== root || ext !== `.${item.snapshot.format}`) {
            throw actionError('INVALID_OUTPUT_PATH', 'Output must be a direct child file in the output folder');
          }
          const realRoot = await (fileActions.realpath || realpath)(root);
          let exists = true;
          try {
            const info = await (fileActions.lstat || lstat)(target);
            if (!info.isFile() || info.isSymbolicLink()) {
              throw actionError('INVALID_OUTPUT_PATH', 'Output must be a direct child file in the output folder');
            }
            const realTarget = await (fileActions.realpath || realpath)(target);
            if (path.dirname(realTarget) !== realRoot) throw actionError('INVALID_OUTPUT_PATH', 'Output must be a direct child file in the output folder');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            exists = false;
          }
          validatedOutputPath = target;
          if (exists) {
            try { await fileActions.trashItem(target); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        } else if (!flatCompleted) {
          try {
            const info = await (fileActions.lstat || lstat)(target);
            if (!info.isDirectory() || info.isSymbolicLink()) throw actionError('INVALID_OUTPUT_PATH', 'Output must be a job directory');
            await fileActions.trashItem(target);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        if (validatedOutputPath && !item.missingOutputPath) item.missingOutputPath = validatedOutputPath;
        item.outputPath = null;
        item.fileDeleted = true;
        item.updatedAt = now();
        await persist();
        publish();
        return { deleted: true };
      });
    },
    remove(id) {
      return enqueue(async () => {
        requireOpen();
        const item = findItem(id);
        if (item.status === 'running' || active?.id === id) throw actionError('NOT_REMOVABLE', 'Cancel and wait for execution to stop first');
        if (item.status === 'waiting') Object.assign(item, transition(item, { type: 'cancel', attempt: item.attempt }, now()));
        items.splice(items.indexOf(item), 1);
        pending.delete(id);
        await persist();
        publish();
        await pump();
        return { removed: true };
      });
    },
    add(snapshot, settings = {}) {
      if (!snapshot || !['mkv', 'mp4'].includes(snapshot.format)) return Promise.reject(new TypeError('snapshot.format must be mkv or mp4'));
      let captured;
      try {
        captured = copy(snapshot);
        captured.fileName = normalizeFileName(captured.fileName);
        validateSnapshot(captured);
      } catch (error) { return Promise.reject(error); }
      freeze(captured);
      const execution = copy({ outputDir: settings.outputDir, ytDlpPath: settings.ytDlpPath, ffmpegPath: settings.ffmpegPath });
      execution.outputLayout = 'flat-v1';
      return enqueue(async () => {
        requireOpen();
        const item = { id: uuid(), attempt: 1, status: 'waiting', phase: 'queued', progress: 0, etaSec: null, outputPath: null, error: null, startedAt: null, finishedAt: null, fileName: captured.fileName, snapshot: captured, execution, createdAt: now(), updatedAt: now() };
        items.push(item);
        await persist();
        publish();
        await pump();
        return copy(item);
      });
    },
    rename(id, fileName) {
      return enqueue(async () => {
        requireOpen();
        const item = findItem(id);
        if (active?.id === id || item.status === 'running') {
          throw actionError('NOT_RENAMABLE', 'Job cannot be renamed');
        }
        if (item.status === 'completed' && (item.fileDeleted || !item.outputPath)) throw actionError('NO_OUTPUT_FILE', 'No completed output file exists');
        if (!['waiting', 'failed', 'cancelled', 'completed'].includes(item.status)) throw actionError('NOT_RENAMABLE', 'Job cannot be renamed');
        const canonical = normalizeFileName(fileName) || defaultFileStem(item.snapshot.video?.title);
        let oldPath, newPath;
        if (item.status === 'completed') {
          oldPath = item.outputPath;
          const parent = path.dirname(path.resolve(oldPath));
          const root = item.execution?.outputLayout === 'flat-v1' ? path.resolve(item.execution.outputDir) : path.resolve(outputFolder(item), `attempt-${item.attempt}`);
          const extension = path.extname(oldPath);
          if (!path.isAbsolute(oldPath) || parent !== root || extension.toLowerCase() !== `.${item.snapshot.format}`) throw actionError('INVALID_OUTPUT_PATH', 'Output must remain in its output directory');
          newPath = path.join(parent, canonical + extension);
          if (newPath.length > 240) throw actionError('OUTPUT_PATH_TOO_LONG', 'Output path exceeds 240 UTF-16 units');
          try {
            const info = await (fileActions.lstat || lstat)(oldPath);
            if (!info.isFile() || info.isSymbolicLink()) throw actionError('INVALID_OUTPUT_PATH', 'Output must be a regular file');
            const realParent = await (fileActions.realpath || realpath)(parent);
            const realFile = await (fileActions.realpath || realpath)(oldPath);
            if (path.dirname(realFile) !== realParent) throw actionError('INVALID_OUTPUT_PATH', 'Output must remain in its output directory');
            let excluded = false;
            const names = await (fileActions.readdir || readdir)(parent);
            if (names.some(name => {
              if (!excluded && name === path.basename(oldPath)) { excluded = true; return false; }
              return name.toLowerCase() === path.basename(newPath).toLowerCase();
            })) throw actionError('OUTPUT_NAME_CONFLICT', 'Output name already exists');
            if (path.basename(oldPath) === path.basename(newPath)) return { ok: true, value: copy(item) };
            await (fileActions.rename || rename)(oldPath, newPath);
          } catch (error) {
            if (['INVALID_OUTPUT_PATH', 'OUTPUT_NAME_CONFLICT'].includes(error.code)) throw error;
            throw actionError('OUTPUT_RENAME_FAILED', `${error.code || 'ERROR'}: ${error.message}`);
          }
        }
        const previousName = item.fileName, previousUpdatedAt = item.updatedAt, previousRevision = document.revision;
        const candidate = copy(item);
        candidate.fileName = canonical;
        if (newPath) { candidate.outputPath = newPath; candidate.outputFileName = path.basename(newPath); }
        candidate.updatedAt = now();
        const candidateDocument = { ...document, revision: previousRevision + 1, items: items.map(row => row.id === id ? candidate : copy(row)) };
        try { await store.save(copy(candidateDocument)); }
        catch (error) {
          halted = true;
          item.fileName = previousName;
          item.updatedAt = previousUpdatedAt;
          document.revision = previousRevision;
          let failure = error;
          if (newPath) {
            try {
              await (fileActions.rename || rename)(newPath, oldPath);
              failure = actionError('PERSIST_FAILED', `${error.code || 'ERROR'}: ${error.message}`);
            } catch (rollback) {
              failure = actionError('RENAME_ROLLBACK_FAILED', `Save failed (${error.code || 'ERROR'}: ${error.message}); rollback failed (${rollback.code || 'ERROR'}: ${rollback.message}); old=${oldPath}; new=${newPath}; actual file may remain at the new path`);
            }
          }
          publish(failure);
          throw failure;
        }
        Object.assign(item, candidate);
        document.revision = candidateDocument.revision;
        document.items = items;
        publish();
        return { ok: true, value: copy(item) };
      });
    },
    cancel(id) {
      return enqueue(async () => {
        requireOpen();
        const item = items.find(item => item.id === id);
        if (!item) throw new Error('Unknown job');
        if (!['waiting', 'running'].includes(item.status)) return copy(item);
        Object.assign(item, transition(item, { type: 'cancel', attempt: item.attempt }, now()));
        item.finishedAt = now();
        await persist();
        publish();
        if (active?.id === id) active.handle?.cancel?.();
        await pump();
        return copy(item);
      });
    },
    retry(id) {
      return enqueue(async () => {
        requireOpen();
        const item = items.find(item => item.id === id);
        if (!item || !['failed', 'cancelled'].includes(item.status) || active?.id === id) throw new Error('Job is not ready for retry');
        Object.assign(item, transition(item, { type: 'retry', attempt: item.attempt }, now()));
        item.phase = 'queued'; item.finishedAt = null;
        await persist();
        publish();
        await pump();
        return copy(item);
      });
    },
    shutdown() {
      closing = true;
      clearTimers();
      return enqueue(async () => {
        mergeProgress();
        if (active) {
          const item = items.find(item => item.id === active.id);
          if (item.status === 'running') {
            Object.assign(item, transition(item, { type: 'fail', attempt: item.attempt, error: { code: 'INTERRUPTED', message: 'Execution interrupted by shutdown' } }, now()));
            item.finishedAt = now();
          }
          active.handle?.cancel();
          await active.handle?.done.catch(() => {});
          active = null;
        }
        try { await persist(); }
        finally {
          if (store.flush) {
            try { await store.flush(); }
            catch (error) { halted = true; publish(error); throw error; }
          }
        }
        publish();
      });
    }
  };
}
