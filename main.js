const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');
const fsp = fs.promises; // Use async file system promises
const util = require('util');
const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);

const dvdCore = require('./dvd-core');
const mirraCore = require('./mirra-core');

process.on('uncaughtException', (err) => {
  try { dvdCore.appendExternal('[main] uncaughtException: ' + (err && err.stack ? err.stack : String(err))); } catch (e) {}
  try { mirraCore.appendExternal('[main] uncaughtException: ' + (err && err.stack ? err.stack : String(err))); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
  try { dvdCore.appendExternal('[main] unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason))); } catch (e) {}
  try { mirraCore.appendExternal('[main] unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason))); } catch (e) {}
});

app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Hardware acceleration stays ENABLED: video now renders to a <canvas> and needs
// the GPU compositor for 50-60fps. Weak-GPU machines are handled by the
// gpuSoftware detection below (--midia-gpu-software disables heavy animations).

function createWindow(gpuSoftware, fxLite, launchPrefs) {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 600,
    resizable: true,
    backgroundColor: '#0a1b30',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: [
        ...(gpuSoftware ? ['--midia-gpu-software'] : []),
        ...(fxLite ? ['--midia-fx-lite'] : []),
        '--midia-ui-scale=' + (launchPrefs && launchPrefs.uiScale === 'large' ? 'large' : 'small'),
      ],
    }
  });

  win.loadFile('index.html');

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (dvdCore && typeof dvdCore.appendExternal === 'function') {
      const lv = ['verbose', 'info', 'warning', 'error'][level] || ('L' + level);
      dvdCore.appendExternal('[renderer:' + lv + '] ' + String(message) + ' (' + String(sourceId) + ':' + line + ')');
    }
    if (mirraCore && typeof mirraCore.appendExternal === 'function') {
      const lv = ['verbose', 'info', 'warning', 'error'][level] || ('L' + level);
      mirraCore.appendExternal('[renderer:' + lv + '] ' + String(message) + ' (' + String(sourceId) + ':' + line + ')');
    }
    if (String(message).indexOf('[mirra]') === 0) {
      const lv = ['verbose', 'info', 'warning', 'error'][level] || ('L' + level);
      console.log('[renderer:' + lv + '] ' + String(message) + ' (' + String(sourceId) + ':' + line + ')');
    }
  });
  win.webContents.on('render-process-gone', (event, details) => {
    if (dvdCore && typeof dvdCore.appendExternal === 'function') {
      dvdCore.appendExternal('[renderer] render-process-gone reason=' + String(details.reason) + ' exitCode=' + String(details.exitCode));
    }
    if (mirraCore && typeof mirraCore.appendExternal === 'function') {
      mirraCore.appendExternal('[renderer] render-process-gone reason=' + String(details.reason) + ' exitCode=' + String(details.exitCode));
    }
  });
  win.webContents.on('preload-error', (event, preloadPath, error) => {
    if (dvdCore && typeof dvdCore.appendExternal === 'function') {
      dvdCore.appendExternal('[renderer] preload-error: ' + String(preloadPath) + ' -> ' + String(error && error.message ? error.message : error));
    }
    if (mirraCore && typeof mirraCore.appendExternal === 'function') {
      mirraCore.appendExternal('[renderer] preload-error: ' + String(preloadPath) + ' -> ' + String(error && error.message ? error.message : error));
    }
  });

  // Windowed mode is locked to maximized: any restore-down attempt (title bar
  // button, double-click, Win+Down, taskbar) snaps straight back. Fullscreen
  // is the only other allowed state (Settings > System > Window Starts).
  win.__midiaClosing = false;
  win.on('close', () => { win.__midiaClosing = true; });
  win.on('unmaximize', () => {
    if (win.__midiaClosing || win.isFullScreen()) return;
    setTimeout(() => {
      try {
        if (!win.isDestroyed() && !win.__midiaClosing && !win.isFullScreen() && !win.isMaximized()) win.maximize();
      } catch (e) { /* window gone */ }
    }, 15);
  });
  win.on('leave-full-screen', () => {
    if (!win.__midiaClosing && !win.isMaximized()) win.maximize();
  });

  if (launchPrefs && launchPrefs.fullscreen) win.setFullScreen(true);
  else if (!win.isMaximized()) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
  });
  
  return win;
}

// getGPUFeatureStatus() queried instantly at whenReady often reports a
// premature "disabled": the GPU process hasn't finished initializing yet.
// Wait for GPU info updates to land (or time out) before trusting them.
function detectGpuSoftware() {
  return new Promise((resolve) => {
    let done = false;
    let stableTimer = null;
    const readStatus = () => {
      try {
        const s = app.getGPUFeatureStatus();
        return !s || (s.gpu_compositing !== 'enabled' && s.gpu_compositing !== 'native');
      } catch (e) { return true; }
    };
    const finish = () => {
      if (done) return;
      done = true;
      const software = readStatus();
      console.log('[gpu] compositing=' + (() => { try { return (app.getGPUFeatureStatus() || {}).gpu_compositing || 'unknown'; } catch (e) { return 'unknown'; } })() + ' -> ' + (software ? 'software fallback' : 'native'));
      resolve(software);
    };
    app.on('gpu-info-update', () => {
      if (done) return;
      clearTimeout(stableTimer);
      stableTimer = setTimeout(finish, 350);
    });
    setTimeout(finish, 1200);
  });
}

// One-time-per-boot cleanup: older library scans stored full-resolution
// embedded art (up to 6000x6000). Each candidate is shrunk by a throwaway
// helper process — decoding a 36-megapixel bitmap can trip a Skia allocation
// assert (FATAL, uncatchable), and this way it can never take Midia down.
async function shrinkOversizedCovers() {
  try {
    // DEV-ONLY: the helper spawn relies on `electron.exe <script>` semantics.
    // In packaged builds process.execPath is Midia.exe, which would launch a
    // full second app instance per candidate instead of running the helper.
    if (app.isPackaged) return;
    const coversDir = path.join(app.getPath('userData'), 'covers');
    if (!fs.existsSync(coversDir)) return;
    const candidates = fs.readdirSync(coversDir)
      // nativeImage decodes JPEG/PNG only; webp/gif/bmp would fail every boot
      .filter(f => /\.(jpe?g|png)$/i.test(f))
      .filter(f => { try { return fs.statSync(path.join(coversDir, f)).size >= 120 * 1024; } catch (e) { return false; } })
      .sort((a, b) => {
        try { return fs.statSync(path.join(coversDir, a)).size - fs.statSync(path.join(coversDir, b)).size; }
        catch (e) { return 0; }
      });
    if (!candidates.length) return;
    let shrunk = 0, skipped = 0;
    const t0 = Date.now();
    for (const f of candidates) {
      if (Date.now() - t0 > 120000) break; // time-boxed; continues next boot
      const p = path.join(coversDir, f);
      const tmp = p + '.tmp';
      const ok = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, '_shrink_cover.js'), p, tmp], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let errTail = '';
        child.stderr.on('data', d => { errTail = (errTail + String(d)).slice(-400); });
        let settled = false;
        const done = (code) => {
          if (settled) return;
          settled = true;
          if (code !== 0 && code !== 5) console.log('[music] shrink fail(' + code + ') ' + f + (errTail ? ' :: ' + errTail.trim().replace(/\n/g, ' | ') : ''));
          resolve(code === 0);
        };
        child.on('exit', (code) => done(code));
        child.on('error', (e) => { errTail = String(e); done(-1); });
        // Decoding 36-megapixel embedded art can take tens of seconds on a
        // low-end CPU — allow it, the overall pass is time-boxed anyway.
        setTimeout(() => { try { child.kill(); } catch (e) {} done(-2); }, 45000);
      });
      if (ok && fs.existsSync(tmp)) {
        try { fs.renameSync(tmp, p); shrunk++; } catch (e) { skipped++; }
      } else {
        skipped++;
      }
      if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (e) {} }
      await new Promise(r => setImmediate(r));
    }
    if (shrunk || skipped) console.log('[music] cover shrink pass: ' + shrunk + ' resized, ' + skipped + ' skipped');
  } catch (e) {}
}

// Single instance: a media center should never pile up parallel instances
// (second launch just focuses the existing window).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const software = await detectGpuSoftware();

  // Launch prefs come straight from the persisted settings file so the very
  // first paint already has the right window state and UI scale.
  let launchPrefs = { fullscreen: false, uiScale: 'small' };
  try {
    const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const mode = d && d.system && d.system.launchMode;
    launchPrefs.fullscreen = mode
      ? mode === 'fullscreen'
      : !!(d && d.clock && d.clock.launchFullscreen); // legacy toggle migration
    if (d && d.system && d.system.uiScale) launchPrefs.uiScale = d.system.uiScale;
  } catch (e) { /* defaults */ }

  // Low-end hardware heuristic: with native compositing on a weak iGPU,
  // backdrop blur dominates frame cost (measured ~19fps -> ~45fps on a
  // Braswell Chromebook when dropped). Lite keeps animations, kills blur.
  let fxLite = false;
  if (!software) {
    try {
      const cores = os.cpus().length;
      const memGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
      fxLite = cores <= 4 && memGb <= 4;
    } catch (e) {}
    if (fxLite) console.log('[gpu] low-end hardware detected -> fx-lite (blur off)');
  }

  const win = createWindow(software, fxLite, launchPrefs);
  dvdCore.start(win);
  mirraCore.start(win);
  initYoutubeBackend().catch((e) => {
    console.error('[youtube] backend init failed:', e);
  });
  shrinkOversizedCovers();
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
        dvdCore.appendExternal('[music] load-library -> folder=' + String(data.folderPath) + ' tracks=' + (Array.isArray(data.tracks) ? data.tracks.length : 0));
        return data;
      }
    }
  } catch (e) {
    console.error('Failed to load library.', e);
    dvdCore.appendExternal('[music] load-library FAILED: ' + (e && e.message ? e.message : e));
    try { fs.unlinkSync(LIBRARY_FILE); } catch (e2) {}
  }
  return null;
});

// Deep Scan + Metadata + Local Image Extraction
ipcMain.on('scan-folder', async (event, { folderPath, knownTracks = [], incremental = false }) => {
  dvdCore.appendExternal('[music] scan-folder start incremental=' + String(!!incremental) + ' path=' + String(folderPath));
  const fileList = [];
  const knownMap = incremental ? new Map((knownTracks || []).map(t => [t.path, t])) : null;
  
  let musicMetadata;
  try {
    const module = await import('music-metadata');
    musicMetadata = module; 
    dvdCore.appendExternal('[music] music-metadata loaded');
  } catch (e) {
    console.error("Failed to load music-metadata:", e);
    dvdCore.appendExternal('[music] music-metadata FAILED to load: ' + (e && e.message ? e.message : e));
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

                // Cap extracted art at 800px on its long side. Full-res embedded
                // scans (up to 6000x6000) decode to ~140MB each and dominate
                // album-grid scroll raster cost on low-end machines.
                try {
                  const { nativeImage } = require('electron');
                  const img = nativeImage.createFromBuffer(Buffer.from(pic.data));
                  if (!img.isEmpty()) {
                    const sz = img.getSize();
                    // >30MP: resizing risks a fatal Skia allocation failure on
                    // low-RAM machines — keep the original bytes untouched.
                    if (sz.width * sz.height <= 30e6) {
                      const big = Math.max(sz.width, sz.height);
                      if (big > 800) {
                        const k = 800 / big;
                        const small = img.resize({ width: Math.max(1, Math.round(sz.width * k)), height: Math.max(1, Math.round(sz.height * k)) });
                        const out = /^png$/i.test(ext) ? small.toPNG() : small.toJPEG(82);
                        await fsp.writeFile(coverLocalPath, out);
                      } else {
                        await fsp.writeFile(coverLocalPath, Buffer.from(pic.data));
                      }
                    } else {
                      await fsp.writeFile(coverLocalPath, Buffer.from(pic.data));
                    }
                  } else {
                    await fsp.writeFile(coverLocalPath, Buffer.from(pic.data));
                  }
                } catch (covErr) {
                  await fsp.writeFile(coverLocalPath, Buffer.from(pic.data));
                }
              }
            } catch (metaErr) {
              metadata.title = path.basename(item, path.extname(item));
              metadata.artist = 'Unknown Artist';
              metadata.album = 'Unknown Album';
              if (incremental) {
                dvdCore.appendExternal('[music] metadata parse FAILED for ' + fullPath + ': ' + (metaErr && metaErr.message ? metaErr.message : metaErr));
              }
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
    dvdCore.appendExternal('[music] scan-folder complete -> ' + fileList.length + ' tracks');
  } catch (err) {
    console.error("Scan failed, folder might be missing:", err);
    dvdCore.appendExternal('[music] scan-folder FAILED: ' + (err && err.message ? err.message : err));
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
  dvdCore.appendExternal('[photos] scan-folder start incremental=' + String(!!incremental) + ' path=' + String(folderPath));
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
    dvdCore.appendExternal('[photos] scan-folder complete -> ' + fileList.length + ' photos');
  } catch (err) {
    console.error('Photos scan failed:', err);
    dvdCore.appendExternal('[photos] scan-folder FAILED: ' + (err && err.message ? err.message : err));
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
      const data = JSON.parse(content.replace(/^\uFEFF/, ''));
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

// Renderer -> main log bridge. Applets tag their own lifecycle/error lines so
// the exported diagnostic log can be read per-applet.
ipcMain.on('log:append', (event, line) => {
  try { dvdCore.appendExternal('[applet] ' + String(line).slice(0, 2000)); } catch (e) { /* ignore */ }
  try { mirraCore.appendExternal('[applet] ' + String(line).slice(0, 2000)); } catch (e) { /* ignore */ }
});

ipcMain.handle('log:export', async (event) => {  try {
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
    const body = info.join('\n') + '--- LOG BUFFER ---\n' + dvdCore.getLogText() + '\n--- MIRRA LOG ---\n' + mirraCore.getLogText() + '\n--- VLC LOG (tail) ---\n' + getVlcLogTail();
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

// --- YOUTUBE TV BACKEND ---
// Runs a persistent, TV-mode YouTube session with:
//  * a "smart TV" user agent so youtube.com/tv serves its TV UI,
//  * Ghostery ad-blocking (network + cosmetic) scoped to that session only,
//  * SponsorBlock segment data so the applet can auto-skip in-video sponsors.

const YOUTUBE_PARTITION = 'persist:youtube-tv';
// Modern Samsung TV (Tizen 6.5, Chromium 108) identity: youtube.com/tv serves
// its current leanback build to this client class. The legacy 2011 GoogleTV UA
// still worked but got the frozen old shell (static splash, dated UI).
const YOUTUBE_TV_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 108.0.5359.215/6.5 TV Safari/537.36';
const YOUTUBE_ADBLOCK_CACHE = path.join(app.getPath('userData'), 'youtube-adblock-engine.bin');
const SPONSORBLOCK_API = 'https://sponsor.ajay.app/api/skipSegments';
const SPONSORBLOCK_CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];

let youtubeBlocker = null;
let youtubeAdblockReady = false;
let youtubeCosmeticHandlersRegistered = false;
let youtubeSession = null;

// YouTube TV streams via server-side ABR (`sabr=1`): the server picks quality
// per-segment from the client's measured download throughput, ignoring the
// client's format list. Client-side URL rewriting can't cap it (signed URLs).
// Instead we throttle the whole YouTube session's download throughput with
// Electron's network emulation; the server ABR then adapts to the throttle.
// Values are bytes/sec download throttles, set below the next tier's bitrate so
// ABR is forced down to the target resolution. Approximate; tune if needed.
const YOUTUBE_THROTTLE_BY_QUALITY = {
  '720p60': 400000,     // ~3.2 Mbps: below typical 1080p, allows 720p
  '1080p60': 700000,    // ~5.6 Mbps: below typical 1440p, allows 1080p
  '1440p60': 1400000    // ~11.2 Mbps: below typical 4K, allows 1440p
};
let youtubeThrottleBps = null; // null = no throttle

function httpsGetBuffer(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'Accept-Encoding': 'gzip, deflate' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        try {
          resolve(httpsGetBuffer(new URL(res.headers.location, url).toString(), timeoutMs));
        } catch (e) {
          resolve({ status: 0, buffer: null });
        }
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        if ((encoding === 'gzip' || encoding === 'deflate') && buffer.length > 0) {
          try {
            buffer = encoding === 'gzip' ? zlib.gunzipSync(buffer) : zlib.inflateSync(buffer);
          } catch (e) { /* keep as-is */ }
        }
        resolve({ status, buffer });
      });
      res.on('error', () => resolve({ status: 0, buffer: null }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, buffer: null }); });
    req.on('error', () => resolve({ status: 0, buffer: null }));
  });
}

// Minimal `fetch`-shim matching what @ghostery/adblocker expects.
function adblockFetch(url) {
  return httpsGetBuffer(url).then(({ status, buffer }) => {
    if (status !== 200 || !buffer) throw new Error('adblock fetch failed: ' + url + ' (HTTP ' + status + ')');
    const text = buffer.toString('utf8');
    return {
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
  });
}

async function initYoutubeBackend() {
  const ytSession = session.fromPartition(YOUTUBE_PARTITION);
  youtubeSession = ytSession;
  ytSession.setUserAgent(YOUTUBE_TV_UA);
  dvdCore.appendExternal('[youtube] session ready (partition ' + YOUTUBE_PARTITION + ')');

  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const readCache = async (p) => new Uint8Array(await fsp.readFile(p));
    const writeCache = async (p, data) => {
      try { await fsp.mkdir(path.dirname(p), { recursive: true }); } catch (e) {}
      await fsp.writeFile(p, Buffer.from(data));
    };
    const cached = fs.existsSync(YOUTUBE_ADBLOCK_CACHE);

    youtubeBlocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(adblockFetch, {
      path: YOUTUBE_ADBLOCK_CACHE,
      read: readCache,
      write: writeCache
    });

    // Network blocking. Electron 22 predates session.registerPreloadScript, so
    // the webRequest hooks are wired manually instead of enableBlockingInSession().
    ytSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      // Playback-critical stream endpoints are misclassified as trackers by
      // generic filter lists (TVHTML5 clients fetch these on every play).
      if (/^https:\/\/[a-z0-9-]+\.googlevideo\.com\/(initplayback|videoplayback)\??/.test(details.url)) {
        callback({ cancel: false });
        return;
      }
      youtubeBlocker.onBeforeRequest(details, callback);
    });
    ytSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      youtubeBlocker.onHeadersReceived(details, callback);
    });

    // Cosmetic blocking: the <webview> preload (from @ghostery/adblocker-electron-preload)
    // requests rules through these channels. Register once; they are session-agnostic.
    if (!youtubeCosmeticHandlersRegistered) {
      ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => youtubeBlocker.onInjectCosmeticFilters(e, url, msg));
      ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', (e) => youtubeBlocker.onIsMutationObserverEnabled(e));
      youtubeCosmeticHandlersRegistered = true;
    }

    youtubeAdblockReady = true;
    console.log('[youtube] ad-block engine ready (' + (cached ? 'cached engine' : 'fresh engine download') + ')');
    dvdCore.appendExternal('[youtube] ad-block ready (' + (cached ? 'cached engine' : 'fresh engine download') + ')');
  } catch (e) {
    youtubeAdblockReady = false;
    const reason = (e && e.message) ? e.message : String(e);
    console.error('[youtube] ad-block engine unavailable:', e);
    dvdCore.appendExternal('[youtube] ad-block unavailable: ' + reason);
  }
}

ipcMain.handle('youtube:capabilities', () => ({
  adblock: youtubeAdblockReady,
  userAgent: YOUTUBE_TV_UA,
  preloadPath: (() => {
    try { return require.resolve('@ghostery/adblocker-electron-preload'); } catch (e) { return null; }
  })()
}));

ipcMain.handle('youtube:set-quality-cap', (event, label) => {
  if (label && Object.prototype.hasOwnProperty.call(YOUTUBE_THROTTLE_BY_QUALITY, label)) {
    youtubeThrottleBps = YOUTUBE_THROTTLE_BY_QUALITY[label];
  } else {
    youtubeThrottleBps = null;
  }
  try {
    if (youtubeSession) {
      if (youtubeThrottleBps) {
        youtubeSession.enableNetworkEmulation({ downloadThroughput: youtubeThrottleBps });
        console.log('[youtube] download throttled to ' + youtubeThrottleBps + ' B/s (' + label + ')');
      } else {
        youtubeSession.disableNetworkEmulation();
        console.log('[youtube] download throttle disabled');
      }
    }
  } catch (e) {
    console.error('[youtube] throttle error:', e);
  }
  return youtubeThrottleBps;
});

ipcMain.handle('youtube:sponsor-segments', async (event, videoId) => {
  if (!videoId || typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return [];
  try {
    const categories = encodeURIComponent(JSON.stringify(SPONSORBLOCK_CATEGORIES));
    const actionTypes = encodeURIComponent(JSON.stringify(['skip']));
    const url = SPONSORBLOCK_API + '?videoID=' + videoId + '&categories=' + categories + '&actionTypes=' + actionTypes;
    const { status, buffer } = await httpsGetBuffer(url, 15000);
    if (status !== 200 || !buffer) return [];
    const data = JSON.parse(buffer.toString('utf8'));
    if (!Array.isArray(data)) return [];
    return data
      .filter((s) => s && Array.isArray(s.segment) && s.segment.length >= 2)
      .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category || 'sponsor' }));
  } catch (e) {
    return [];
  }
});
