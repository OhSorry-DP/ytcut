import fs from 'node:fs/promises';
import path from 'node:path';

function createStore(filePath) {
  const target = path.resolve(filePath);
  let writer = Promise.resolve();
  let failure = null;
  let unsupportedSchema = false;

  async function load() {
    try {
      const source = await fs.readFile(target, 'utf8');
      let document;
      try {
        document = JSON.parse(source);
      } catch {
        await preserveCorrupt();
        return { document: null, warning: { code: 'CORRUPT', message: 'Store file contains invalid JSON.' } };
      }
      if (!validDocument(document)) {
        await preserveCorrupt();
        return { document: null, warning: { code: 'CORRUPT', message: 'Store file has an invalid document shape.' } };
      }
      if (document.schemaVersion > 1) {
        unsupportedSchema = true;
        return { document: null, warning: { code: 'UNSUPPORTED_SCHEMA', message: `Unsupported schema version ${document.schemaVersion}.` } };
      }
      if (document.schemaVersion !== 1) {
        await preserveCorrupt();
        return { document: null, warning: { code: 'CORRUPT', message: 'Store file has an unsupported schema version.' } };
      }
      return { document, warning: null };
    } catch (error) {
      if (error.code === 'ENOENT') return { document: null, warning: null };
      throw error;
    }
  }

  async function preserveCorrupt() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.rename(target, `${target}.corrupt-${timestamp}.json`);
  }

  function save(document) {
    if (unsupportedSchema) return Promise.reject(new Error('Saving is blocked after loading an unsupported schema.'));
    const snapshot = structuredClone(document);
    if (!validDocument(snapshot) || snapshot.schemaVersion !== 1) return Promise.reject(new TypeError('Invalid store document.'));
    const operation = writer.then(() => writeAtomically(snapshot));
    writer = operation.catch((error) => {
      failure ??= error;
    });
    return operation;
  }

  async function writeAtomically(document) {
    const directory = path.dirname(target);
    const basename = path.basename(target);
    const temporary = path.join(directory, `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx');
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      for (const delay of [0, 50, 100, 200]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          await fs.rename(temporary, target);
          return;
        } catch (error) {
          if (!['EACCES', 'EPERM'].includes(error.code) || delay === 200) throw error;
        }
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async function flush() {
    await writer;
    if (failure) {
      const error = failure;
      failure = null;
      throw error;
    }
  }

  return { load, save, flush };
}

function validDocument(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Number.isInteger(value.schemaVersion) && value.schemaVersion >= 1
    && Number.isInteger(value.revision) && value.revision >= 0
    && value.settings !== null && typeof value.settings === 'object' && !Array.isArray(value.settings)
    && Array.isArray(value.items);
}

export { createStore };
