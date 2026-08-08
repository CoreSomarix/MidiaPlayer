const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const fsp = fs.promises; // Use async file system promises
const util = require('util');
const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);

const dvdCore = require('./dvd-core');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Hardware acceleration stays ENABLED: video now renders to a <canvas> and needs
// the GPU compositor for 50-60fps. Weak-GPU machines are handled by the
// gpuSoftware detection below (--midia-gpu-software disables heavy animations).

function createWindow(gpuSoftware) {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 600,
    resizable: true,
    backgroundColor: '#074877',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: gpuSoftware ? ['--midia-gpu-software'] : [],
    }
  });

  win.loadFile('index.html');

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (dvdCore && typeof dvdCore.appendExternal === 'function') {
      dvdCore.appendExternal('[renderer] ' + String(message) + ' (' + String(sourceId) + ':' + line + ')');
    }
  });

  win.once('ready-to-show', () => {
    win.center();
    win.show();
  });
  
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  let software = false;
  try {
    const status = app.getGPUFeatureStatus();
    software = !status || (status.gpu_compositing !== 'enabled' && status.gpu_compositing !== 'native');
  } catch (e) {}
  const win = createWindow(software);
  dvdCore.start(win);
});

// --- DVD APPLET MEDIA KEYS ---
// Hardware media/volume keys (laptop front buttons, BT headphones) are only
// captured while the DVD applet is open, so system volume works normally elsewhere.

const DVD_MEDIA_KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'];

function registerDvdMediaKeys() {
  DVD_MEDIA_KEYS.forEach((key) => {
    if (!globalShortcut.isRegistered(key)) {
      globalShortcut.register(key, () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) win.webContents.send('dvd-media-key', key);
      });
    }
  });
}

function unregisterDvdMediaKeys() {
  DVD_MEDIA_KEYS.forEach((key) => {
    if (globalShortcut.isRegistered(key)) globalShortcut.unregister(key);
  });
}

ipcMain.on('dvd-media-keys', (event, enable) => {
  if (enable) registerDvdMediaKeys();
  else unregisterDvdMediaKeys();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- BACKEND LOGIC (ASYNC ATOMIC WRITES) ---

const LIBRARY_FILE = path.join(app.getPath('userData'), 'miizu-library.json');
const PHOTOS_LIBRARY_FILE = path.join(app.getPath('userData'), 'midia-photos-library.json');
const DOODLES_DIR = path.join(app.getPath('userData'), 'doodles');
let lastKnownLibrary = null;
let lastKnownPhotosLibrary = null;

async function atomicWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(data, null, 2));
  await fsp.rename(tempPath, filePath);
}

async function saveLibraryData(libraryData) {
  try {
    let existingFolderPath = null;
    try {
      if (fs.existsSync(LIBRARY_FILE)) {
        const content = fs.readFileSync(LIBRARY_FILE, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && parsed.folderPath) existingFolderPath = parsed.folderPath;
      }
    } catch (e) {}

    if (!libraryData.folderPath && existingFolderPath) {
      libraryData.folderPath = existingFolderPath;
    }

    if (!libraryData.folderPath) return;

    await atomicWriteJSON(LIBRARY_FILE, libraryData);
    lastKnownLibrary = libraryData;
  } catch (e) {
    console.error('Failed to save library:', e);
  }
}

// Final safety net
app.on('before-quit', async () => {
  if (lastKnownLibrary) {
    try { await atomicWriteJSON(LIBRARY_FILE, lastKnownLibrary); } catch (e) {}
  }
  if (lastKnownPhotosLibrary) {
    try { await atomicWriteJSON(PHOTOS_LIBRARY_FILE, lastKnownPhotosLibrary); } catch (e) {}
  }
});

// --- IPC HANDLERS ---

// Removed 'select-folder' handler since the app now automatically uses C:\Users\...\Music\MiiZu_Music.

// CHANGED: Switched to .handle() to allow the frontend to await the save, preventing exit-race conditions.
ipcMain.handle('save-library', async (event, libraryData) => {
  if (!libraryData.folderPath) {
    try {
      if (fs.existsSync(LIBRARY_FILE)) {
        const content = fs.readFileSync(LIBRARY_FILE, 'utf8');
        const existingData = JSON.parse(content);
        if (existingData && existingData.folderPath) {
          libraryData.folderPath = existingData.folderPath;
        }
      }
    } catch (e) {}
    if (!libraryData.folderPath) return; 
  }
  await saveLibraryData(libraryData);
});

ipcMain.handle('load-library', async () => {
  try {
    if (fs.existsSync(LIBRARY_FILE)) {
      const content = fs.readFileSync(LIBRARY_FILE, 'utf8');
      const data = JSON.parse(content);
      if (data && (data.folderPath || data.onboardingCompleted || data.isOnboardingComplete)) {
        return data;
      }
    }
  } catch (e) {
    console.error('Failed to load library.', e);
    try { fs.unlinkSync(LIBRARY_FILE); } catch (e2) {}
  }
  return null;
});

// Deep Scan + Metadata + Local Image Extraction
ipcMain.on('scan-folder', async (event, { folderPath, knownTracks = [], incremental = false }) => {
  const fileList = [];
  const knownMap = incremental ? new Map((knownTracks || []).map(t => [t.path, t])) : null;
  
  let musicMetadata;
  try {
    const module = await import('music-metadata');
    musicMetadata = module; 
  } catch (e) {
    console.error("Failed to load music-metadata:", e);
    musicMetadata = null;
  }
  
  async function scanDir(dir) {
    try {
      const items = await readdir(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          await scanDir(fullPath);
        } else if (stats.isFile() && /\.(mp3|flac|wav|m4a|ogg)$/i.test(item)) {
          const existing = incremental && knownMap.has(fullPath) ? knownMap.get(fullPath) : null;
          // Re-parse files whose stored metadata is stale/missing so a fixed
          // metadata library can repair previously "Unknown Artist" tracks.
          // metadataParsed is set after any successful parse (even if tags are
          // genuinely absent) so tag-less files aren't re-parsed every launch.
          const needsReparse = existing && !existing.metadataParsed;
          if (incremental && existing && !needsReparse) continue;

          let metadata = { title: null, artist: null, album: null, trackNo: null };
          let coverLocalPath = null;
          
          if (musicMetadata) {
            try {
              const parsed = await musicMetadata.parseFile(fullPath);
              const common = parsed.common;
              metadata.title = common.title || path.basename(item, path.extname(item));
              metadata.artist = common.artist || 'Unknown Artist';
              metadata.album = common.album || 'Unknown Album';
              metadata.trackNo = common.track ? common.track.no : null;
              
              if (common.picture && common.picture.length > 0) {
                const pic = common.picture[0];
                let ext = pic.format;
                if (ext.startsWith('image/')) ext = ext.substring(6);
                
                const coversDir = path.join(app.getPath('userData'), 'covers');
                if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

                const coverFileName = `cover_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
                coverLocalPath = path.join(coversDir, coverFileName);
                await fsp.writeFile(coverLocalPath, pic.data);
              }
            } catch (metaErr) {
              metadata.title = path.basename(item, path.extname(item));
              metadata.artist = 'Unknown Artist';
              metadata.album = 'Unknown Album';
            }
          } else {
            metadata.title = path.basename(item, path.extname(item));
            metadata.artist = 'Unknown Artist';
            metadata.album = 'Unknown Album';
          }

          fileList.push({ 
            path: fullPath, 
            name: metadata.title || path.basename(item, path.extname(item)),
            artist: metadata.artist || 'Unknown Artist',
            album: metadata.album || 'Unknown Album',
            trackNo: metadata.trackNo,
            cover: coverLocalPath, 
            fileName: item,
            size: stats.size,
            added: Date.now(),
            metadataParsed: true
          });

          if (fileList.length % 5 === 0) {
            await new Promise(resolve => setImmediate(resolve));
            event.sender.send('scan-progress', fileList.length);
          }
        }
      }
    } catch (err) {
      // Silent skip
    }
  }

  try {
    await scanDir(folderPath);
    event.sender.send('scan-complete', fileList);
  } catch (err) {
    console.error("Scan failed, folder might be missing:", err);
    event.sender.send('scan-complete', []); 
  }
});

// --- PHOTOS LIBRARY ---

async function savePhotosLibraryData(libraryData) {
  try {
    if (!libraryData.folderPath) return;
    await atomicWriteJSON(PHOTOS_LIBRARY_FILE, libraryData);
    lastKnownPhotosLibrary = libraryData;
  } catch (e) {
    console.error('Failed to save photos library:', e);
  }
}

ipcMain.handle('save-photos-library', async (event, libraryData) => {
  await savePhotosLibraryData(libraryData);
});

ipcMain.handle('load-photos-library', async () => {
  try {
    if (fs.existsSync(PHOTOS_LIBRARY_FILE)) {
      const content = fs.readFileSync(PHOTOS_LIBRARY_FILE, 'utf8');
      const data = JSON.parse(content);
      if (data && (data.folderPath || data.onboardingCompleted || data.isOnboardingComplete)) {
        return data;
      }
    }
  } catch (e) {
    console.error('Failed to load photos library.', e);
    try { fs.unlinkSync(PHOTOS_LIBRARY_FILE); } catch (e2) {}
  }
  return null;
});

ipcMain.on('scan-photos-folder', async (event, { folderPath, knownPaths = [], incremental = false }) => {
  const fileList = [];
  const knownSet = incremental ? new Set(knownPaths || []) : null;
  const imageExt = /\.(jpg|jpeg|png|gif|bmp|webp)$/i;

  async function scanDir(dir) {
    try {
      const items = await readdir(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stats = await stat(fullPath);
        if (stats.isDirectory()) {
          await scanDir(fullPath);
        } else if (stats.isFile() && imageExt.test(item)) {
          if (incremental && knownSet.has(fullPath)) continue;
          fileList.push({
            path: fullPath,
            fileName: item,
            size: stats.size,
            mtime: stats.mtimeMs,
            added: Date.now()
          });
          if (fileList.length % 10 === 0) {
            await new Promise(resolve => setImmediate(resolve));
            event.sender.send('photos-scan-progress', fileList.length);
          }
        }
      }
    } catch (err) {
      // Silent skip
    }
  }

  try {
    await scanDir(folderPath);
    event.sender.send('photos-scan-complete', fileList);
  } catch (err) {
    console.error('Photos scan failed:', err);
    event.sender.send('photos-scan-complete', []);
  }
});

ipcMain.handle('save-doodle', async (event, { dataUrl, originalPath }) => {
  try {
    if (!fs.existsSync(DOODLES_DIR)) fs.mkdirSync(DOODLES_DIR, { recursive: true });
    const baseName = path.basename(originalPath, path.extname(originalPath));
    const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const doodlePath = path.join(DOODLES_DIR, `${safeName}_doodle_${Date.now()}.png`);
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    await fsp.writeFile(doodlePath, Buffer.from(base64, 'base64'));
    return doodlePath;
  } catch (e) {
    console.error('Failed to save doodle:', e);
    return null;
  }
});

// --- SETTINGS LIBRARY ---

const SETTINGS_FILE = path.join(app.getPath('userData'), 'midia-settings.json');
const CURRENT_VERSION = app.getVersion() || '1.0.0';

ipcMain.handle('save-settings', async (event, settingsData) => {
  try {
    await atomicWriteJSON(SETTINGS_FILE, settingsData);
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
});

ipcMain.handle('load-settings', async () => {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object') return data;
    }
  } catch (e) {
    console.error('Failed to load settings.', e);
    try { fs.unlinkSync(SETTINGS_FILE); } catch (e2) {}
  }
  return null;
});

ipcMain.handle('select-background-file', async (event, type) => {
  const filters = type === 'video'
    ? [{ name: 'Video Files', extensions: ['mp4'] }]
    : [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }];
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters });
  return result.canceled ? null : result.filePaths[0];
});

const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/CoreSomarix/MidiaPlayer/main/assets/update-manifest.json';

async function getUpdateManifest() {
  let manifest = null;
  try {
    manifest = await fetchRemoteManifest(UPDATE_MANIFEST_URL);
  } catch (e) {
    console.error('Remote update check failed:', e);
  }
  if (!manifest) {
    try {
      const manifestPath = path.join(app.getAppPath(), 'assets', 'update-manifest.json');
      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      }
    } catch (e) {
      console.error('Local update check failed:', e);
    }
  }
  return manifest;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };

    const downloadOnce = (currentUrl, redirectsLeft) => {
      const file = fs.createWriteStream(dest);
      const req = https.get(currentUrl, { timeout: 120000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          file.close();
          try { fs.unlinkSync(dest); } catch (e) {}
          if (redirectsLeft <= 0) {
            finish({ ok: false, error: 'Too many redirects.' });
            return;
          }
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          downloadOnce(nextUrl, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          try { fs.unlinkSync(dest); } catch (e) {}
          finish({ ok: false, error: 'Download failed (HTTP ' + res.statusCode + ').' });
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress(Math.min(100, Math.round((received / total) * 100)));
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          finish({ ok: true, path: dest });
        });
        file.on('error', (e) => {
          console.error('Write error:', e);
          finish({ ok: false, error: e.message || 'Write failed.' });
        });
        res.on('error', (e) => {
          console.error('Download error:', e);
          file.close();
          finish({ ok: false, error: e.message || 'Download failed.' });
        });
      });
      req.on('timeout', () => {
        req.destroy();
        file.close();
        try { fs.unlinkSync(dest); } catch (e) {}
        finish({ ok: false, error: 'Download timed out.' });
      });
      req.on('error', (e) => {
        file.close();
        try { fs.unlinkSync(dest); } catch (e2) {}
        finish({ ok: false, error: e.message || 'Download failed.' });
      });
    };

    downloadOnce(url, 5);
  });
}

ipcMain.handle('check-for-update', async () => {
  const manifest = await getUpdateManifest();
  if (manifest && manifest.version && manifest.version !== CURRENT_VERSION) {
    return { hasUpdate: true, version: manifest.version, url: manifest.url || null };
  }
  return { hasUpdate: false, version: CURRENT_VERSION };
});

ipcMain.handle('download-update', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const manifest = await getUpdateManifest();
  if (!manifest || !manifest.version || manifest.version === CURRENT_VERSION) {
    return { ok: false, error: 'No update available.' };
  }
  if (!manifest.url) return { ok: false, error: 'No download URL found in the update manifest.' };
  try {
    const dest = path.join(app.getPath('temp'), `Midia-Setup-${manifest.version}.exe`);
    if (fs.existsSync(dest)) {
      try { fs.unlinkSync(dest); } catch (e) {}
    }
    return await downloadFile(manifest.url, dest, (pct) => {
      if (win && !win.isDestroyed()) win.webContents.send('update-download-progress', pct);
    });
  } catch (e) {
    console.error('Update download failed:', e);
    return { ok: false, error: e.message || 'Download failed.' };
  }
});

ipcMain.handle('install-update', (event, filePath) => {
  if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
    return { ok: false, error: 'Installer file not found.' };
  }
  try {
    spawn(filePath, ['--updated'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return { ok: true };
  } catch (e) {
    console.error('Failed to launch installer:', e);
    return { ok: false, error: e.message || 'Failed to launch installer.' };
  }
});

function fetchRemoteManifest(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-menu-music', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('set-fullscreen', (event, fullscreen) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.setFullScreen(!!fullscreen);
});

function getVlcLogTail(maxLines) {
  try {
    const vlcLog = path.join(require('os').tmpdir(), 'midia-vlc.log');
    if (!fs.existsSync(vlcLog)) return '(no VLC log file)';
    const content = fs.readFileSync(vlcLog, 'utf8');
    const lines = content.split('\n');
    const tail = lines.slice(Math.max(0, lines.length - (maxLines || 200)));
    return tail.join('\n');
  } catch (e) {
    return '(VLC log read failed: ' + e.message + ')';
  }
}

ipcMain.handle('log:export', async (event) => {
  try {
    let gpu = 'n/a';
    try { gpu = JSON.stringify(app.getGPUFeatureStatus()); } catch (e) {}
    const info = [
      '=== MIDIA DIAGNOSTIC LOG ===',
      'Time:      ' + new Date().toLocaleString(),
      'Version:   ' + (app.getVersion() || 'unknown'),
      'Electron:  ' + process.versions.electron,
      'Node:      ' + process.versions.node,
      'Platform:  ' + process.platform + ' ' + process.arch,
      'OS:        ' + process.platform + ' ' + require('os').release(),
      'Packaged:  ' + app.isPackaged,
      'GPU:       ' + gpu,
      'Data dir:  ' + app.getPath('userData'),
      ''
    ];
    const body = info.join('\n') + '--- LOG BUFFER ---\n' + dvdCore.getLogText() + '\n--- VLC LOG (tail) ---\n' + getVlcLogTail();
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Export Diagnostic Log',
      defaultPath: path.join(app.getPath('documents'), 'Midia-Log-' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + '.txt'),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, body, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'Export failed' };
  }
});

ipcMain.handle('set-launch-on-startup', (event, enable) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enable });
  } catch (e) {
    console.error('Failed to set launch on startup:', e);
  }
});

ipcMain.handle('reset-music-library', () => {
  try { if (fs.existsSync(LIBRARY_FILE)) fs.unlinkSync(LIBRARY_FILE); } catch (e) {}
});

ipcMain.handle('reset-photos-library', () => {
  try { if (fs.existsSync(PHOTOS_LIBRARY_FILE)) fs.unlinkSync(PHOTOS_LIBRARY_FILE); } catch (e) {}
});

ipcMain.handle('set-music-folder', async (event, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return false;
  try {
    let data = {};
    if (fs.existsSync(LIBRARY_FILE)) {
      try { data = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8')) || {}; } catch (e) { data = {}; }
    }
    data.folderPath = folderPath;
    await atomicWriteJSON(LIBRARY_FILE, data);
    lastKnownLibrary = data;
    return true;
  } catch (e) {
    console.error('Failed to set music folder:', e);
    return false;
  }
});

ipcMain.handle('set-photos-folder', async (event, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return false;
  try {
    let data = {};
    if (fs.existsSync(PHOTOS_LIBRARY_FILE)) {
      try { data = JSON.parse(fs.readFileSync(PHOTOS_LIBRARY_FILE, 'utf8')) || {}; } catch (e) { data = {}; }
    }
    data.folderPath = folderPath;
    await atomicWriteJSON(PHOTOS_LIBRARY_FILE, data);
    lastKnownPhotosLibrary = data;
    return true;
  } catch (e) {
    console.error('Failed to set photos folder:', e);
    return false;
  }
});
