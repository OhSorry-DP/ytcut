const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame !== false) {
  const removeQueueChangedListener = (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('queue:changed', listener);
    let subscribed = true;

    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener('queue:changed', listener);
    };
  };

  const onToolsChanged = (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tools:changed', listener);
    let subscribed = true;

    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener('tools:changed', listener);
    };
  };

  contextBridge.exposeInMainWorld('ytcut', Object.freeze({
    bootstrap: () => ipcRenderer.invoke('app:bootstrap', {}),
    metadata: (payload) => ipcRenderer.invoke('video:metadata', payload),
    preparePreview: (videoId, previewResolution) => ipcRenderer.invoke('preview:prepare', { videoId, previewResolution }),
    add: (payload) => ipcRenderer.invoke('queue:add', payload),
    rename: (id, fileName) => ipcRenderer.invoke('queue:rename', { id, fileName }),
    refreshFiles: () => ipcRenderer.invoke('queue:refresh-files', {}),
    cancel: (id) => ipcRenderer.invoke('queue:cancel', { id }),
    retry: (id) => ipcRenderer.invoke('queue:retry', { id }),
    openOutput: (id) => ipcRenderer.invoke('queue:open-output', { id }),
    openFile: (id) => ipcRenderer.invoke('queue:open-file', { id }),
    deleteFile: (id) => ipcRenderer.invoke('queue:delete-file', { id }),
    remove: (id) => ipcRenderer.invoke('queue:remove', { id }),
    chooseOutput: () => ipcRenderer.invoke('settings:choose-output', {}),
    saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
    onQueueChanged: removeQueueChangedListener,
    ytdlpState: () => ipcRenderer.invoke('ytdlp:state', {}),
    checkYtdlp: () => ipcRenderer.invoke('ytdlp:check', {}),
    toolsState: () => ipcRenderer.invoke('tools:state', {}),
    checkTool: (toolId) => ipcRenderer.invoke('tools:check', { toolId }),
    downloadTool: ({ toolId, candidateId, acknowledgedBytes }) => ipcRenderer.invoke('tools:download', { toolId, candidateId, acknowledgedBytes }),
    onToolsChanged,
    onYtdlpChanged: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('ytdlp:changed', listener);
      return () => ipcRenderer.removeListener('ytdlp:changed', listener);
    },
    updateState: () => ipcRenderer.invoke('update:state', {}),
    checkUpdate: () => ipcRenderer.invoke('update:check', {}),
    downloadUpdate: () => ipcRenderer.invoke('update:download', {}),
    installUpdate: () => ipcRenderer.invoke('update:install', {}),
    onUpdateChanged: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('update:changed', listener);
      return () => ipcRenderer.removeListener('update:changed', listener);
    },
  }));
}
