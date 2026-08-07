'use strict';

// dvd-core.js - main-process support for the DVD applet.
//
// Architecture:
//   - Video playback itself now lives in the RENDERER (dvd-engine.js, loaded by
//     index.html). Rendering frames in the main process and shipping them over
//     IPC was measured at ~11fps, so libvlc + koffi run inside the renderer and
//     paint onto a full-window <canvas> that the applet UI floats above.
//   - This module keeps everything that needs the main process:
//       - DVD / Blu-ray disc detection (VIDEO_TS / BDMV) across all drives.
//       - MCI eject (winmm mciSendStringW "set CDAudio door open").
//       - MRL building for a drive or path spec (dvd://, bluray://, file path).
//       - The dev "load test media" file dialog.
//       - The ring-buffer log exported by Settings > Export Log.
//   - libvlc events no longer flow through IPC; the renderer engine pushes state
//     directly to the applet's UI.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// --- ring-buffer logging (captured by the Settings > Export Log button) ---
const logBuffer = [];
function dlog(...args) {
  let line;
  try {
    line = args.map((a) => {
      if (typeof a === 'string') return a;
      if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint') return String(a);
      if (a === null || a === undefined) return String(a);
      if (a instanceof Error) return a.message;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
  } catch (e) { line = String(args); }
  const ts = new Date().toISOString();
  logBuffer.push(ts + ' ' + line);
  if (logBuffer.length > 3000) logBuffer.splice(0, logBuffer.length - 3000);
  console.log(line);
}
function getLogText() { return logBuffer.join('\n'); }
function appendExternal(line) {
  try {
    const ts = new Date().toISOString();
    logBuffer.push(ts + ' [ext] ' + String(line));
    if (logBuffer.length > 3000) logBuffer.splice(0, logBuffer.length - 3000);
  } catch (e) { /* ignore */ }
}

let koffi = null;
let kernel32 = null;
let winmm = null;

let devMode = false;
let lastDiscPath = null;
let lastDiscInfo = null;
let scanTimer = null;
let scanEnabled = true;
let browserWin = null;

function findVlcDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor', 'vlc'));
  candidates.push(path.join(app.getAppPath(), 'vendor', 'vlc'));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'libvlc.dll'))) return c;
  }
  return null;
}

function sendAll(channel, payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch (e) { /* ignore */ }
}

async function getDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      const ok = await withTimeout(fs.promises.access(root), 500);
      if (ok !== null) drives.push(root);
    } catch (e) { /* skip */ }
  }
  return drives;
}

function readStr16(buf) {
  let end = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) { end = i; break; }
  }
  return buf.subarray(0, end).toString('utf16le');
}

function getVolumeLabel(root) {
  try {
    const nameBuf = Buffer.alloc(512);
    const fsBuf = Buffer.alloc(512);
    kernel32.GetVolumeInformationW(root, nameBuf, nameBuf.length, null, null, null, fsBuf, fsBuf.length);
    const label = readStr16(nameBuf).trim();
    return label || null;
  } catch (e) {
    return null;
  }
}

function cleanLabel(label) {
  return String(label || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

async function detectDiscAt(root) {
  try {
    const entries = await withTimeout(fs.promises.readdir(root), 1500);
    if (!entries) return null;
    for (const name of entries) {
      const upper = name.toUpperCase();
      if (upper === 'VIDEO_TS') {
        const label = getVolumeLabel(root);
        dlog('[dvd-core] disc found', root, 'kind=dvd label=' + JSON.stringify(label));
        return { kind: 'dvd', title: cleanLabel(label) || 'DVD' };
      }
      if (upper === 'BDMV') {
        const label = getVolumeLabel(root);
        dlog('[dvd-core] disc found', root, 'kind=bluray label=' + JSON.stringify(label));
        return { kind: 'bluray', title: cleanLabel(label) || 'Blu-ray' };
      }
    }
  } catch (e) { /* empty drive */ }
  return null;
}

function withTimeout(p, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); });
  return Promise.race([p, timeout]).catch(() => null).finally(() => clearTimeout(timer));
}

async function scanDiscs() {
  let found = null;
  const driveList = await getDrives();
  for (let i = 0; i < driveList.length; i++) {
    const root = driveList[i];
    const disc = await detectDiscAt(root);
    if (disc) { found = { ...disc, path: root }; break; }
  }
  const nextPath = found ? found.path : null;
  if (nextPath !== lastDiscPath) {
    lastDiscPath = nextPath;
    lastDiscInfo = found;
    if (found) {
      sendAll('dvd:disc', { status: 'ready', kind: found.kind, path: found.path, title: found.title });
    } else {
      sendAll('dvd:disc', { status: 'none' });
    }
  }
  return found;
}

function startScanTimer() {
  if (scanTimer) return;
  scanTimer = setInterval(() => scanDiscs(), 4000);
}

function stopScanTimer() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

function setScanEnabled(enabled) {
  scanEnabled = !!enabled;
  if (!scanEnabled) stopScanTimer();
  else startScanTimer();
}

function eject() {
  let ok = false;
  let message = '';
  try {
    const rc = winmm.mciSendStringW('set CDAudio door open', null, 0, null);
    ok = rc === 0;
    if (!ok) message = 'MCI error ' + rc;
  } catch (e) {
    message = e.message;
  }
  if (ok) scanDiscs();
  return { ok, message };
}

async function buildSpec(spec) {
  const p = String(spec.path || '');
  if (!p) return { ok: false, message: 'No path given' };
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const disc = await detectDiscAt(p);
      if (!disc) return { ok: false, message: 'No VIDEO_TS or BDMV folder found' };
      const clean = p.replace(/\\/g, '/').replace(/\/+$/, '');
      const prefix = disc.kind === 'bluray' ? 'bluray:///' : 'dvd:///';
      return { ok: true, mrl: prefix + clean + '/', isDvd: disc.kind === 'dvd', isBluray: disc.kind === 'bluray', title: disc.title };
    }
    const ext = path.extname(p).toLowerCase();
    if (ext === '.iso') {
      return { ok: true, mrl: 'dvd:///' + p.replace(/\\/g, '/'), isDvd: true, isBluray: false, title: cleanLabel(path.basename(p, ext)) };
    }
    if (/\.(mkv|mp4|avi|mov|wmv|m4v|mpg|mpeg|ts|m2ts|flv|webm|ogv)$/i.test(ext)) {
      // libvlc_media_new_path needs a native Windows path (backslashes)
      return { ok: true, mrl: p.replace(/\//g, '\\'), isDvd: false, isBluray: false, isFile: true, title: path.basename(p, ext) };
    }
    return { ok: false, message: 'Unsupported file type' };
  } catch (e) {
    return { ok: false, message: e.message || 'Path not found' };
  }
}

async function loadSpec(spec) {
  let built;
  if (spec && spec.kind === 'drive') {
    const disc = await detectDiscAt(spec.path);
    if (!disc) return { ok: false, message: 'No disc in ' + spec.path };
    const clean = spec.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const prefix = disc.kind === 'bluray' ? 'bluray:///' : 'dvd:///';
    built = { ok: true, mrl: prefix + clean + '/', isDvd: disc.kind === 'dvd', isBluray: disc.kind === 'bluray', title: disc.title };
  } else {
    built = await buildSpec(spec);
  }
  if (built.ok) {
    dlog('[dvd-core] load spec', JSON.stringify(spec || null), '->', built.mrl);
  }
  return built;
}

function init() {
  devMode = !app.isPackaged;
  try {
    koffi = require('koffi');
    kernel32 = koffi.load('kernel32.dll');
    winmm = koffi.load('winmm.dll');

    const decl = (name, ret, params) => { kernel32[name] = kernel32.func('__stdcall', name, ret, params); };
    decl('GetVolumeInformationW', 'int32', ['str16', 'void *', 'uint32', 'void *', 'void *', 'void *', 'void *', 'uint32']);

    const wdecl = (name, ret, params) => { winmm[name] = winmm.func('__stdcall', name, ret, params); };
    wdecl('mciSendStringW', 'uint32', ['str16', 'str16', 'uint32', 'void *']);

    dlog('[dvd-core] ready (libvlc renderer engine expected)');
  } catch (e) {
    dlog('[dvd-core] init failed:', e);
  }
  scanDiscs();
  startScanTimer();
}

function registerIpc(win) {
  ipcMain.on('dvd:applet-open', (e, open) => {
    if (open) scanDiscs();
  });

  ipcMain.on('dvd:scanning', (e, enabled) => setScanEnabled(enabled));

  ipcMain.handle('dvd:load', (e, spec) => loadSpec(spec || {}));
  ipcMain.handle('dvd:load-test', async (e) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Load test video / DVD folder',
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: 'Video & DVD', extensions: ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'iso', 'flv', 'webm', 'ogv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('dvd:scan', async () => scanDiscs());
  ipcMain.handle('dvd:capabilities', async () => ({ real: !!findVlcDir(), dev: devMode }));
  ipcMain.handle('dvd:get-disc', () => {
    if (!lastDiscPath || !lastDiscInfo) return { status: 'none' };
    return { status: 'ready', kind: lastDiscInfo.kind, path: lastDiscInfo.path, title: lastDiscInfo.title };
  });
  ipcMain.handle('dvd:eject', async () => eject());
}

function start(win) {
  browserWin = win;
  registerIpc(win);
  init();
}

module.exports = { start, getLogText, appendExternal };
