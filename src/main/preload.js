'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Channels the renderer is allowed to subscribe to (main -> renderer events).
const EVENT_CHANNELS = new Set([
  'llama:status', 'llama:log',
  'pipeline:start', 'pipeline:code', 'pipeline:code-live', 'pipeline:code-stream-start', 'pipeline:code-stream-end',
  'pipeline:files', 'pipeline:done', 'pipeline:error', 'pipeline:log',
  'stage:start', 'stage:delta', 'stage:done', 'stage:error',
  'run:clear', 'run:started', 'run:data', 'run:exit', 'run:images',
  'terminal:data', 'terminal:exit',
  'memory:update',
  'env:update', 'env:install-start', 'env:install-data', 'env:install-exit',
  'pipeline:missingModule',
  'chat:delta', 'chat:done', 'chat:error',
  'datasets:update', 'datasets:progress',
  'github:progress',
  'window:state',
  'llama:install',
  'experiments:update',
  'snapshots:update',
  'sysmon:update',
  'repro:update',
]);

contextBridge.exposeInMainWorld('garm', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial) => ipcRenderer.invoke('config:set', partial),
  },
  llama: {
    info: () => ipcRenderer.invoke('llama:info'),
    restart: (partial) => ipcRenderer.invoke('llama:restart', partial),
    // Full local recovery: find/download the binary and model, then start the server.
    recover: () => ipcRenderer.invoke('llama:recover'),
  },
  pipeline: {
    run: (request) => ipcRenderer.invoke('pipeline:run', request),
    refine: (request, code, file) => ipcRenderer.invoke('pipeline:refine', { request, code, file }),
    inpaint: (request, code, selection, file) => ipcRenderer.invoke('pipeline:inpaint', { request, code, selection, file }),
    cancel: () => ipcRenderer.invoke('pipeline:cancel'),
  },
  chat: {
    // messages: [{ role, content, context? }] — the last user turn may carry an editor attachment.
    send: (messages) => ipcRenderer.invoke('chat:send', { messages }),
    cancel: () => ipcRenderer.invoke('chat:cancel'),
  },
  // First-run signup + "star us" prompt bookkeeping.
  profile: {
    get: () => ipcRenderer.invoke('profile:get'),
    signup: (name, email) => ipcRenderer.invoke('profile:signup', { name, email }),
    skip: () => ipcRenderer.invoke('profile:skip'),
  },
  star: {
    dismiss: () => ipcRenderer.invoke('star:dismiss'),
  },
  memory: {
    get: () => ipcRenderer.invoke('memory:get'),
    addFact: (fact) => ipcRenderer.invoke('memory:addFact', { fact }),
    removeFact: (index) => ipcRenderer.invoke('memory:removeFact', { index }),
    clear: () => ipcRenderer.invoke('memory:clear'),
  },
  env: {
    get: () => ipcRenderer.invoke('env:get'),
    refresh: () => ipcRenderer.invoke('env:refresh'),
    install: (spec) => ipcRenderer.invoke('env:install', { spec }),
    cancelInstall: () => ipcRenderer.invoke('env:install-cancel'),
    discover: () => ipcRenderer.invoke('env:discover'),
    createVenv: () => ipcRenderer.invoke('env:createVenv'),
  },
  code: {
    save: (code, file) => ipcRenderer.invoke('code:save', { code, file }),
    compile: (code, file) => ipcRenderer.invoke('code:compile', { code, file }),
    run: (code, file) => ipcRenderer.invoke('code:run', { code, file }),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (name) => ipcRenderer.invoke('projects:create', { name }),
    open: (path) => ipcRenderer.invoke('projects:open', { path }),
  },
  files: {
    tree: () => ipcRenderer.invoke('files:tree'),
    search: (query, options) => ipcRenderer.invoke('files:search', { query, options }),
    read: (path) => ipcRenderer.invoke('files:read', { path }),
    save: (path, content) => ipcRenderer.invoke('files:save', { path, content }),
    create: (path) => ipcRenderer.invoke('files:create', { path }),
    mkdir: (path) => ipcRenderer.invoke('files:mkdir', { path }),
    rename: (from, to) => ipcRenderer.invoke('files:rename', { from, to }),
    remove: (path) => ipcRenderer.invoke('files:delete', { path }),
    // Resolve a dropped File to its absolute path (Electron removed File.path; this is the
    // supported webUtils replacement). Runs in the preload, returns '' for non-disk files.
    pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  },
  // Document ingestion: add CSV / Excel / JSON to the project, with schema detection.
  datasets: {
    list: () => ipcRenderer.invoke('datasets:list'),
    add: (paths) => ipcRenderer.invoke('datasets:add', { paths }),   // already-on-disk paths (drag-drop)
    import: () => ipcRenderer.invoke('datasets:import'),             // open the native file picker
    remove: (id) => ipcRenderer.invoke('datasets:remove', { id }),
    reanalyze: (id) => ipcRenderer.invoke('datasets:reanalyze', { id }),
    insights: (id) => ipcRenderer.invoke('datasets:insights', { id }),
  },
  notebooks: {
    create: (path, title) => ipcRenderer.invoke('notebooks:create', { path, title }),
    load: (path) => ipcRenderer.invoke('notebooks:load', { path }),
    save: (path, notebook) => ipcRenderer.invoke('notebooks:save', { path, notebook }),
    run: (path, notebook) => ipcRenderer.invoke('notebooks:run', { path, notebook }),
  },
  reproducibility: {
    list: () => ipcRenderer.invoke('repro:list'),
    get: (id) => ipcRenderer.invoke('repro:get', { id }),
  },
  research: {
    analyze: (datasetId, target) => ipcRenderer.invoke('research:analyze', { datasetId, target }),
    reports: () => ipcRenderer.invoke('research:reports'),
    compareRuns: () => ipcRenderer.invoke('research:compareRuns'),
    generateTests: (report) => ipcRenderer.invoke('research:generateTests', { report }),
  },
  // Experiment tracker: metric-parsed run history (Runs tab).
  experiments: {
    list: () => ipcRenderer.invoke('experiments:list'),
    remove: (id) => ipcRenderer.invoke('experiments:remove', { id }),
    clear: () => ipcRenderer.invoke('experiments:clear'),
    exportCsv: () => ipcRenderer.invoke('experiments:exportCsv'),
  },
  // Dependency doctor: imports -> missing packages -> requirements.txt (Env tab).
  doctor: {
    scan: () => ipcRenderer.invoke('doctor:scan'),
    writeRequirements: (deps) => ipcRenderer.invoke('doctor:writeRequirements', { deps }),
  },
  // Project snapshots: checkpoint + restore (History tab).
  snapshots: {
    list: () => ipcRenderer.invoke('snapshots:list'),
    create: (label) => ipcRenderer.invoke('snapshots:create', { label }),
    restore: (id) => ipcRenderer.invoke('snapshots:restore', { id }),
    remove: (id) => ipcRenderer.invoke('snapshots:remove', { id }),
  },
  dashboard: {
    get: () => ipcRenderer.invoke('dashboard:get'),
  },
  // GitHub integration: repo status, one-click publish, and subsequent pushes.
  github: {
    status: () => ipcRenderer.invoke('github:status'),
    verifyToken: (token) => ipcRenderer.invoke('github:verifyToken', { token }),
    generateFiles: (opts) => ipcRenderer.invoke('github:generateFiles', opts),
    commit: (message) => ipcRenderer.invoke('github:commit', { message }),
    publish: (opts) => ipcRenderer.invoke('github:publish', opts),
    push: (message) => ipcRenderer.invoke('github:push', { message }),
  },
  run: {
    input: (text) => ipcRenderer.invoke('run:input', { text }),
    stop: () => ipcRenderer.invoke('run:stop'),
  },
  terminal: {
    exec: (command) => ipcRenderer.invoke('terminal:exec', { command }),
    input: (data) => ipcRenderer.invoke('terminal:input', { data }),
    interrupt: () => ipcRenderer.invoke('terminal:interrupt'),
    cwd: () => ipcRenderer.invoke('terminal:cwd'),
  },
  dialog: {
    pickModel: () => ipcRenderer.invoke('dialog:pickModel'),
    pickPython: () => ipcRenderer.invoke('dialog:pickPython'),
    pickLlamaServer: () => ipcRenderer.invoke('dialog:pickLlamaServer'),
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', { path: p }),
    showWorkspace: () => ipcRenderer.invoke('shell:showWorkspace'),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:read'),
    writeText: (text) => ipcRenderer.invoke('clipboard:write', { text }),
  },
  // Custom title-bar controls for the frameless window (Windows/Linux).
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    platform: () => ipcRenderer.invoke('window:platform'),
  },
  // Generic, allowlisted event subscription. Returns an unsubscribe function.
  on: (channel, handler) => {
    if (!EVENT_CHANNELS.has(channel)) {
      throw new Error(`Channel not allowed: ${channel}`);
    }
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
