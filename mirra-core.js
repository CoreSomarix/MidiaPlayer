'use strict';

// mirra-core.js - main-process support for the Mirra (phone mirroring) applet.
//
// Architecture:
//   - Device detection via `adb devices` polling while the applet is open.
//   - Live H.264 streaming uses the scrcpy STANDALONE SERVER protocol
//     (see https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md#standalone-server).
//     The built-in `--record=-` recorder is unusable for live streaming: it
//     buffers the whole recording and only flushes at exit.
//
//     Flow:
//       1. adb push scrcpy-server /data/local/tmp/scrcpy-server-manual.jar
//       2. adb forward tcp:PORT localabstract:scrcpy
//       3. adb shell ... app_process / com.genymobile.scrcpy.Server 4.1 \
//            tunnel_forward=true audio=false control=false cleanup=true \
//            send_device_meta=false send_dummy_byte=false max_size=1280
//       4. TCP connect to 127.0.0.1:PORT and parse the video protocol:
//          - u32 codec id ("h264")
//          - 12-byte session packets (MSB set): width/height
//          - 12-byte-header media packets: config/keyframe flags + PTS + size,
//            followed by the raw H.264 (Annex B) payload
//   - Frames are forwarded to the renderer, where WebCodecs decodes them onto
//     a <canvas>.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFile, execFileSync } = require('child_process');

// --- ring-buffer logging ---
const logBuffer = [];
function mlog(...args) {
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

// --- state ---
let browserWin = null;
let scanTimer = null;
let scanEnabled = false;
let lastKnownDevices = [];

// User-configurable scrcpy settings (loaded from renderer via IPC)
let scrcpyPath = null; // null = use 'scrcpy' from PATH
let customArgs = '';

// Live mirroring state
let mirrorSocket = null;
let serverProcess = null; // adb shell process running the server on the device
let mirrorPort = 0;
let socketBuf = Buffer.alloc(0);
let parsedCodec = false;
let streamStarted = false;
let lastWidth = 0;
let lastHeight = 0;
let currentSerial = null;
let connectDeadline = 0;
let useAvcc = false;

// --- helpers ---

function sendAll(channel, payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch (e) { /* ignore */ }
}

function withTimeout(p, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); });
  return Promise.race([p, timeout]).catch(() => null).finally(() => clearTimeout(timer));
}

// Resolve scrcpy executable path (used to locate scrcpy-server)
function getScrcpyCommand() {
  if (scrcpyPath && typeof scrcpyPath === 'string' && scrcpyPath.trim()) {
    return scrcpyPath.trim();
  }
  return 'scrcpy';
}

// Resolve adb executable path (try common locations)
function getAdbCommand() {
  if (scrcpyPath && typeof scrcpyPath === 'string' && scrcpyPath.trim()) {
    const dir = path.dirname(scrcpyPath.trim());
    const adbInDir = path.join(dir, 'adb.exe');
    if (fs.existsSync(adbInDir)) return adbInDir;
    const adbBare = path.join(dir, 'adb');
    if (fs.existsSync(adbBare)) return adbBare;
  }
  return 'adb';
}

function getScrcpyServerPath() {
  const candidates = [];
  if (scrcpyPath && typeof scrcpyPath === 'string' && scrcpyPath.trim()) {
    candidates.push(path.join(path.dirname(scrcpyPath.trim()), 'scrcpy-server'));
  }
  const adb = getAdbCommand();
  if (typeof adb === 'string' && adb !== 'adb') {
    candidates.push(path.join(path.dirname(adb), 'scrcpy-server'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function runAdb(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(getAdbCommand(), args, { timeout: timeoutMs || 20000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function pickPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', () => resolve(27184));
  });
}

// --- device detection ---

function parseAdbDevices(stdout) {
  const lines = stdout.trim().split('\n');
  const devices = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'device') {
      devices.push({ serial: parts[0], status: 'device' });
    }
  }
  return devices;
}

async function getDeviceName(serial) {
  const r = await runAdb(['-s', serial, 'shell', 'getprop', 'ro.product.model'], 5000);
  return (r.stdout || '').trim() || 'Android Device';
}

async function pollDevices() {
  if (!scanEnabled) return;

  const adb = getAdbCommand();
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(adb, ['devices'], { timeout: 4000 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout || '');
      });
    });

    const devices = parseAdbDevices(stdout);
    const currentSerials = devices.map(d => d.serial).sort().join(',');
    const lastSerials = lastKnownDevices.map(d => d.serial).sort().join(',');

    if (currentSerials !== lastSerials) {
      const newDevices = devices.filter(d => !lastKnownDevices.find(ld => ld.serial === d.serial));
      const removedDevices = lastKnownDevices.filter(ld => !devices.find(d => d.serial === ld.serial));

      for (const dev of newDevices) {
        const name = await getDeviceName(dev.serial);
        dev.name = name;
        mlog('[mirra-core] device connected:', dev.serial, name);
        sendAll('mirra:device-detected', { serial: dev.serial, name });
      }

      for (const dev of removedDevices) {
        mlog('[mirra-core] device disconnected:', dev.serial);
        if (mirrorSocket || serverProcess) {
          mlog('[mirra-core] killing mirror due to device disconnect');
          cleanupMirror();
          sendAll('mirra:stream-end', { reason: 'device-disconnected' });
        }
        sendAll('mirra:device-disconnected', { serial: dev.serial });
      }

      lastKnownDevices = devices;
    }
  } catch (e) {
    if (lastKnownDevices.length > 0) {
      for (const dev of lastKnownDevices) {
        mlog('[mirra-core] device disconnected (poll error):', dev.serial);
        if (mirrorSocket || serverProcess) {
          cleanupMirror();
          sendAll('mirra:stream-end', { reason: 'device-disconnected' });
        }
        sendAll('mirra:device-disconnected', { serial: dev.serial });
      }
      lastKnownDevices = [];
    }
  }
}

function startScanTimer() {
  if (scanTimer) return;
  scanEnabled = true;
  pollDevices();
  scanTimer = setInterval(() => pollDevices(), 4000);
}

function stopScanTimer() {
  scanEnabled = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

// --- standalone server video protocol ---

function findStartCode(buf, from) {
  const len = buf.length;
  for (let i = from; i <= len - 3; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
    if (i + 3 < len && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) return i;
  }
  return -1;
}

function splitNals(buf) {
  const nals = [];
  let pos = 0;
  while (pos < buf.length) {
    const sc = findStartCode(buf, pos);
    if (sc === -1) break;
    const scLen = (buf[sc + 2] === 0 && sc + 3 < buf.length && buf[sc + 3] === 1) ? 4 : 3;
    const nalStart = sc + scLen;
    const next = findStartCode(buf, nalStart);
    const nalEnd = next === -1 ? buf.length : next;
    const nal = buf.subarray(nalStart, nalEnd);
    if (nal.length > 0) nals.push(nal);
    pos = next === -1 ? buf.length : next;
  }
  return nals;
}

function uint16BE(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}

// Build an AVCDecoderConfigurationRecord from an Annex B SPS+PPS config packet.
function buildAvcDescription(payload) {
  if (!payload || payload.length < 4) return null;
  const nals = splitNals(payload);
  let sps = null;
  let pps = null;
  for (const nal of nals) {
    if (nal.length < 4) continue;
    const t = nal[0] & 0x1F;
    if (t === 7 && !sps) sps = nal;
    else if (t === 8 && !pps) pps = nal;
  }
  if (!sps || !pps) return null;
  return Buffer.concat([
    Buffer.from([0x01, sps[1], sps[2], sps[3], 0xFF, 0xE1]),
    uint16BE(sps.length), sps,
    Buffer.from([0x01]),
    uint16BE(pps.length), pps
  ]);
}

// Re-frame an Annex B payload into AVCC (4-byte length-prefixed NALs).
function toAvcc(buf) {
  const nals = splitNals(buf);
  if (!nals.length) return buf;
  const parts = [];
  for (const nal of nals) {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(nal.length, 0);
    parts.push(hdr, nal);
  }
  return Buffer.concat(parts);
}

function deriveCodecFromConfig(buf) {
  if (!buf || buf.length < 4) return null;
  // AVCC record (length-prefixed config): byte0 = version 1
  if (buf[0] === 0x01) {
    return { codec: 'avc1.' + [buf[1], buf[2], buf[3]].map(b => b.toString(16).padStart(2, '0')).join('') };
  }
  // Annex B: parse SPS NAL
  const nals = splitNals(buf);
  for (const nal of nals) {
    if (nal.length < 4) continue;
    if ((nal[0] & 0x1F) === 7) {
      return { codec: 'avc1.' + [nal[1], nal[2], nal[3]].map(b => b.toString(16).padStart(2, '0')).join('') };
    }
  }
  return null;
}

function parseVideoStream(buf) {
  let p = 0;
  if (!parsedCodec) {
    if (buf.length < 4) return buf;
    parsedCodec = true;
    p = 4;
  }
  while (true) {
    if (buf.length - p < 1) break;
    const first = buf[p];
    if (first & 0x80) {
      // session packet (12 bytes): flags + width + height
      if (buf.length - p < 12) break;
      const width = buf.readUInt32BE(p + 4);
      const height = buf.readUInt32BE(p + 8);
      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width;
        lastHeight = height;
        sendAll('mirra:stream-config', { codec: 'h264', width, height });
      }
      p += 12;
    } else {
      // media packet: 12-byte header then payload
      if (buf.length - p < 12) break;
      const flags = buf[p];
      const isConfig = (flags & 0x40) !== 0;
      const isKey = (flags & 0x20) !== 0;
      const size = buf.readUInt32BE(p + 8);
      if (buf.length - p < 12 + size) break;
      const payload = buf.subarray(p + 12, p + 12 + size);
      if (isConfig) {
        const meta = deriveCodecFromConfig(payload);
        const description = buildAvcDescription(payload);
        useAvcc = !!description;
        sendAll('mirra:stream-config', {
          codec: meta ? meta.codec : 'avc1.42E01E',
          width: lastWidth || null,
          height: lastHeight || null,
          description: description ? description : null,
          avcc: useAvcc
        });
      } else {
        const out = useAvcc ? toAvcc(payload) : payload;
        sendAll('mirra:video-chunk', { data: out, keyframe: isKey });
      }
      p += 12 + size;
    }
  }
  return buf.subarray(p);
}

function setupMirrorSocket(sock) {
  mirrorSocket = sock;
  let gotData = false;
  sock.on('data', (chunk) => {
    gotData = true;
    socketBuf = Buffer.concat([socketBuf, chunk]);
    if (!streamStarted) {
      streamStarted = true;
      mlog('[mirra-core] mirror stream started');
      sendAll('mirra:stream-start', {});
    }
    try {
      socketBuf = parseVideoStream(socketBuf);
    } catch (e) {
      mlog('[mirra-core] stream parse error:', e.message);
    }
  });
  sock.on('close', () => {
    if (!gotData && serverProcess && Date.now() <= connectDeadline) {
      // The TCP connect to the adb forward succeeded but the device-side server
      // was not bound yet, so adb closes the forwarded socket immediately.
      // This is a startup race: retry instead of treating it as a stream end.
      mlog('[mirra-core] mirror socket closed before data, retrying connection');
      if (mirrorSocket) { try { mirrorSocket.destroy(); } catch (e) {} mirrorSocket = null; }
      scheduleConnect();
      return;
    }
    mlog('[mirra-core] mirror socket closed');
    cleanupMirror();
    sendAll('mirra:stream-end', { reason: 'socket-closed' });
  });
  sock.on('error', (e) => {
    mlog('[mirra-core] mirror socket error:', e.message);
  });
}

function scheduleConnect() {
  if (!serverProcess) return;
  if (Date.now() > connectDeadline) {
    mlog('[mirra-core] could not connect to mirror stream');
    cleanupMirror();
    sendAll('mirra:stream-end', { code: -1, error: 'could not connect to device stream' });
    return;
  }
  setTimeout(() => {
    if (!serverProcess || serverProcess.exitCode !== null) return;
    const sock = net.connect(mirrorPort, '127.0.0.1');
    let connected = false;
    sock.once('connect', () => {
      connected = true;
      mlog('[mirra-core] connected to mirror stream');
      setupMirrorSocket(sock);
    });
    sock.once('error', (e) => {
      if (connected) return; // post-connect errors handled by setupMirrorSocket
      sock.destroy();
      mlog('[mirra-core] connect attempt failed:', e.message);
      scheduleConnect();
    });
  }, 300);
}

function cleanupMirror() {
  if (mirrorSocket) { try { mirrorSocket.destroy(); } catch (e) {} mirrorSocket = null; }
  if (serverProcess) { try { serverProcess.kill(); } catch (e) {} serverProcess = null; }
  if (mirrorPort) {
    const serial = currentSerial;
    if (serial) {
      try { execFile(getAdbCommand(), ['-s', serial, 'forward', '--remove', 'tcp:' + mirrorPort], { windowsHide: true, timeout: 5000 }, () => {}); } catch (e) {}
    }
    mirrorPort = 0;
  }
  currentSerial = null;
  socketBuf = Buffer.alloc(0);
  parsedCodec = false;
  streamStarted = false;
  useAvcc = false;
  lastWidth = 0;
  lastHeight = 0;
}

// --- mirror lifecycle ---

function buildServerArgs(maxSize) {
  const parts = [
    'tunnel_forward=true',
    'audio=false',
    'control=false',
    'cleanup=true',
    'send_device_meta=false',
    'send_dummy_byte=false',
    'max_size=' + maxSize
  ];
  // Honor optional tuning args from customArgs so user settings actually
  // reach the device (previously only --max-size was parsed; the rest were
  // silently ignored, which read as "settings do nothing").
  // Returns the full regex match array; use [1], [2]... for capture groups.
  const opt = (re) => { const m = customArgs.match(re); return m || null; };
  const maxFps = opt(/--max-fps[=\s]+(\d+)/);
  if (maxFps) parts.push('max_fps=' + maxFps[1]);
  // scrcpy's raw server protocol wants video_bit_rate as an integer in
  // bits/sec — the K/M/G suffixes are a CLI-client convenience only, and a
  // literal "512K" kills the server with NumberFormatException.
  const bitrate = opt(/--video-bit-rate[=\s]+(\d+(?:\.\d+)?)\s*([KMG])?/i);
  if (bitrate) {
    const mult = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[(bitrate[2] || '').toLowerCase()] || 1;
    parts.push('video_bit_rate=' + Math.round(parseFloat(bitrate[1]) * mult));
  }
  const encoder = opt(/--video-encoder[=\s]+("?)([A-Za-z0-9._-]+)\1/);
  if (encoder && encoder[2] && encoder[2] !== 'auto') parts.push('video_encoder=' + encoder[2]);
  const codecOpts = opt(/--video-codec-options[=\s]+(\S+)/);
  if (codecOpts) parts.push('video_codec_options=' + codecOpts[1]);
  return parts.join(' ');
}

async function startMirroring() {
  if (mirrorSocket || serverProcess) {
    mlog('[mirra-core] mirror already running, stopping first');
    cleanupMirror();
    sendAll('mirra:stream-end', { reason: 'restart' });
  }

  const adb = getAdbCommand();
  const serverFile = getScrcpyServerPath();
  if (!serverFile) {
    mlog('[mirra-core] scrcpy-server not found');
    sendAll('mirra:stream-end', { code: -1, error: 'scrcpy-server not found' });
    return;
  }

  const serial = lastKnownDevices.length ? lastKnownDevices[0].serial : null;
  if (!serial) {
    mlog('[mirra-core] no device connected');
    sendAll('mirra:stream-end', { code: -1, error: 'no device' });
    return;
  }
  currentSerial = serial;

  mlog('[mirra-core] mirror start on', serial);

  // 1. Push the server jar
  const push = await runAdb(['-s', serial, 'push', serverFile, '/data/local/tmp/scrcpy-server-manual.jar']);
  if (push.err) {
    mlog('[mirra-core] push failed:', push.stderr);
    cleanupMirror();
    sendAll('mirra:stream-end', { code: -1, error: 'adb push failed: ' + push.stderr });
    return;
  }

  // 2. Set up the adb forward
  mirrorPort = await pickPort();
  const fwd = await runAdb(['-s', serial, 'forward', 'tcp:' + mirrorPort, 'localabstract:scrcpy']);
  if (fwd.err) {
    mlog('[mirra-core] forward failed:', fwd.stderr);
    cleanupMirror();
    sendAll('mirra:stream-end', { code: -1, error: 'adb forward failed: ' + fwd.stderr });
    return;
  }

  // 3. Start the server on the device
  let maxSize = 1280;
  const ms = customArgs.match(/--max-size[=\s]+(\d+)/);
  if (ms) maxSize = parseInt(ms[1], 10) || 1280;
  const shellCmd = 'CLASSPATH=/data/local/tmp/scrcpy-server-manual.jar app_process / com.genymobile.scrcpy.Server 4.1 ' + buildServerArgs(maxSize);
  mlog('[mirra-core] server cmd:', shellCmd);

  serverProcess = spawn(adb, ['-s', serial, 'shell', shellCmd], { windowsHide: true });
  serverProcess.stdout.on('data', (c) => { const s = c.toString().trim(); if (s) mlog('[mirra-core] server:', s); });
  serverProcess.stderr.on('data', (c) => { const s = c.toString().trim(); if (s) mlog('[mirra-core] server-err:', s); });
  serverProcess.on('error', (err) => { mlog('[mirra-core] server spawn error:', err.message); });
    serverProcess.on('exit', (code) => {
      mlog('[mirra-core] server process exited', code);
      if (!streamStarted) {
        // Server died before producing a single frame (bad args, encoder
        // rejection, device error): abort the connect loop right away
        // instead of hammering a forward that will never answer.
        cleanupMirror();
        sendAll('mirra:stream-end', { code: code == null ? -1 : code, error: 'scrcpy server failed to start (exit ' + code + ')' });
        return;
      }
      if (mirrorSocket) {
        cleanupMirror();
        sendAll('mirra:stream-end', { code });
      }
    });

  // 4. Connect to the forwarded port (retry until the device-side server binds)
  connectDeadline = Date.now() + 15000;
  scheduleConnect();
}

function stopMirroring() {
  mlog('[mirra-core] stopping mirror');
  cleanupMirror();
}

// --- IPC handlers ---

function registerIpc(win) {
  ipcMain.handle('mirra:capabilities', () => {
    const adb = getAdbCommand();
    const serverFile = getScrcpyServerPath();
    let adbAvailable = false;
    try {
      if (typeof adb === 'string' && adb !== 'adb' && fs.existsSync(adb)) {
        adbAvailable = true;
      } else {
        execFileSync(adb, ['version'], { timeout: 3000, windowsHide: true, stdio: 'ignore' });
        adbAvailable = true;
      }
    } catch (e) { adbAvailable = false; }
    mlog('[mirra-core] capabilities: adb=' + adbAvailable + ' server=' + !!serverFile + ' adbPath=' + adb + ' serverPath=' + (serverFile || 'none'));
    return { scrcpyAvailable: !!serverFile, adbAvailable, scrcpyPath: serverFile || 'In system PATH', adbPath: adb };
  });

  ipcMain.on('mirra:applet-open', (e, open) => {
    if (open) startScanTimer();
    else stopScanTimer();
  });

  ipcMain.handle('mirra:start', async () => {
    mlog('[mirra-core] mirra:start requested');
    startMirroring();
    return { ok: true };
  });

  ipcMain.handle('mirra:stop', () => {
    mlog('[mirra-core] mirra:stop requested');
    stopMirroring();
    return { ok: true };
  });

  ipcMain.handle('mirra:devices', async () => {
    await pollDevices();
    return lastKnownDevices;
  });

  ipcMain.handle('mirra:set-config', (e, config) => {
    if (config && config.scrcpyPath !== undefined) scrcpyPath = config.scrcpyPath;
    if (config && config.customArgs !== undefined) customArgs = config.customArgs;
    // Persist immediately: the settings file must mirror live state, or the
    // next boot resurrects stale args (bit us before — preset vanished).
    try {
      const settingsFile = path.join(app.getPath('userData'), 'midia-settings.json');
      let data = {};
      if (fs.existsSync(settingsFile)) {
        try { data = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e2) { data = {}; }
      }
      if (!data.mirra) data.mirra = {};
      if (config && config.scrcpyPath !== undefined) data.mirra.scrcpyPath = scrcpyPath;
      if (config && config.customArgs !== undefined) data.mirra.customArgs = customArgs;
      fs.writeFileSync(settingsFile, JSON.stringify(data, null, 4), 'utf8');
    } catch (e3) {
      mlog('[mirra-core] failed to persist config:', e3.message);
    }
    mlog('[mirra-core] config updated: scrcpyPath=' + (scrcpyPath || 'PATH') + ' customArgs=' + (customArgs || 'none'));
    return { ok: true };
  });

  ipcMain.handle('select-scrcpy-path', async (e) => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select scrcpy executable',
      properties: ['openFile'],
      filters: [
        { name: 'Executable', extensions: ['exe', ''] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

// --- lifecycle ---

function loadSettings() {
  try {
    const settingsFile = path.join(app.getPath('userData'), 'midia-settings.json');
    if (fs.existsSync(settingsFile)) {
      const content = fs.readFileSync(settingsFile, 'utf8');
      const data = JSON.parse(content.replace(/^\uFEFF/, ''));
      if (data && data.mirra) {
        if (data.mirra.scrcpyPath) scrcpyPath = data.mirra.scrcpyPath;
        if (data.mirra.customArgs) customArgs = data.mirra.customArgs;
        mlog('[mirra-core] loaded settings: scrcpyPath=' + (scrcpyPath || 'PATH') + ' customArgs=' + (customArgs || 'none'));
      }
    }
  } catch (e) {
    mlog('[mirra-core] failed to load settings:', e.message);
  }
}

function start(win) {
  browserWin = win;
  registerIpc(win);
  loadSettings();
  mlog('[mirra-core] initialized');
}

function stop() {
  stopMirroring();
  stopScanTimer();
  mlog('[mirra-core] stopped');
}

process.on('before-quit', () => {
  stop();
});

module.exports = { start, stop, getLogText, appendExternal };
