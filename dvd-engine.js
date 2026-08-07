'use strict';

// dvd-engine.js - renderer-side libvlc video engine for the DVD applet.
//
// Architecture:
//   - libvlc 3.0.23 + koffi FFI run INSIDE the renderer (index.html), because
//     shipping 1.4MB+ frames over IPC is fundamentally too slow (~11fps).
//   - We decode into a JS-owning Node Buffer using the fixed-format path:
//       libvlc_video_set_format('RGBA', 854, 480, 854*4)
//     + libvlc_video_set_callbacks(lock, unlock, display, ...).
//     The koffi cross-thread callback return-value limitation (proven in the
//     spikes) makes libvlc_video_set_format_callbacks unusable, so we use a
//     FIXED decode size. RGBA matches ImageData byte order (no per-pixel byte
//     swap), and 854x480 is DVD-native 16:9 - fast enough for software-rendered
//     low-end machines where 720p decode ran at ~5fps.
//   - lock() writes the Buffer's address into *planes directly
//     (koffi.as(frameBuffer, 'void *')), so libvlc writes pixels straight into
//     the Buffer - zero extra copy on the decode side.
//   - display() just flips a flag. A requestAnimationFrame loop on the MAIN
//     thread copies the buffer into an ImageData (a zero-copy view), scales it
//     onto the full-window <canvas> with ctx.drawImage, and drains events.
//     All DOM/state callbacks therefore run on the main thread.
//   - Everything that needs the main process (disc scan, eject, MRL building,
//     the load-test dialog) stays in dvd-core.js and is reached over IPC.
//
// Disc detection / eject / loadSpec MRL building live in the main process.

(function () {
  const path = window.require('path');
  const fs = window.require('fs');

  const VLC_STATE = { NothingSpecial: 0, Opening: 1, Buffering: 2, Playing: 3, Paused: 4, Stopped: 5, Ended: 6, Error: 7 };

  const EVENT = {
    MediaChanged: 0x100, NothingSpecial: 0x101, Opening: 0x102, Buffering: 0x103,
    Playing: 0x104, Paused: 0x105, Stopped: 0x106, Forward: 0x107, Backward: 0x108,
    EndReached: 0x109, EncounteredError: 0x10A, TimeChanged: 0x10B, PositionChanged: 0x10C,
    SeekableChanged: 0x10D, PausableChanged: 0x10E, TitleChanged: 0x10F, SnapshotTaken: 0x110,
    LengthChanged: 0x111, Vout: 0x112, ScrambledChanged: 0x113, ESAdded: 0x114, ESDeleted: 0x115,
    ESSelected: 0x116, Corked: 0x117, Uncorked: 0x118, Muted: 0x119, Unmuted: 0x11A,
    AudioVolume: 0x11B, AudioDevice: 0x11C, ChapterChanged: 0x11D
  };

  const NAVIGATE = { Up: 0, Down: 1, Left: 2, Right: 3, Activate: 4, Popup: 5 };

  // Decode at native DVD resolution (16:9). The packaged build ships for
  // low-end/software-rendered machines (Win7 ia32, GPU disabled), so 720p
  // decode + a per-pixel byte swap per frame capped out at ~5fps. 854x480 is
  // the DVD-native 16:9 square-pixel size and cuts per-frame pixel work by
  // ~2.3x. Override with MIDIA_DVD_RES=WxH.
  function resolveFrameSize() {
    let w = 854, h = 480;
    try {
      const spec = process.env.MIDIA_DVD_RES;
      if (spec && /^\d+x\d+$/.test(spec)) {
        const [pw, ph] = spec.split('x').map((n) => parseInt(n, 10));
        if (pw >= 320 && ph >= 180) { w = pw; h = ph; }
      }
    } catch (e) {}
    return { w, h };
  }
  const FRAME_SIZE = resolveFrameSize();
  const FRAME_W = FRAME_SIZE.w;
  const FRAME_H = FRAME_SIZE.h;
  const FRAME_PITCH = FRAME_W * 4;

  let koffi = null;
  let libvlc = null;
  let kernel32 = null;

  let inst = null;
  let mp = null;
  let media = null;
  let mediaIsFile = false;

  let ready = false;
  let loaded = false;
  let isDvd = false;
  let isBluray = false;
  let mrl = null;
  let currentTitle = '';
  let currentZoom = 'normal';

  let eventCb = null;
  let lockCb = null;
  let unlockCb = null;
  let displayCb = null;
  let EventCbType = null;
  let CbLockType = null;
  let CbUnlockType = null;
  let CbDisplayType = null;

  let frameBuffer = null;
  let imageData = null;
  let srcCanvas = null;
  let srcCtx = null;
  let canvas = null;
  let ctx = null;
  let resizeObserver = null;
  let rafId = null;

  let newFrame = false;
  let firstFrameDone = false;
  let eventDirty = false;
  let endedFlag = false;
  let errorFlag = false;
  let paintedCount = 0;
  let decodedCount = 0;
  let rafCount = 0;

  let autoPlaySeq = 0;
  let autoPlayStartedAt = 0;
  let autoPlayAttempt = 0;

  const callbacks = { onState: null, onEnded: null, onError: null, onFirstFrame: null };

  let state = { ready: false, loaded: false };

  function dlog(...args) {
    try { console.log('[dvd-engine]', ...args); } catch (e) {}
  }

  function findVlcDir() {
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor', 'vlc'));
    try {
      const u = new URL(window.location.href);
      if (u.protocol === 'file:') {
        const appDir = path.dirname(decodeURIComponent(u.pathname).replace(/^\/+/, ''));
        candidates.push(path.join(appDir, 'vendor', 'vlc'));
      }
    } catch (e) {}
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'libvlc.dll'))) return c;
    }
    return null;
  }

  function makeArgv(args) {
    const ptrs = args.map((a) => {
      const p = koffi.alloc('char', a.length + 1);
      koffi.encode(p, 'str', a);
      return p;
    });
    const buf = Buffer.alloc(args.length * 4);
    for (let i = 0; i < args.length; i++) {
      buf.writeUInt32LE(Number(koffi.address(ptrs[i])), i * 4);
    }
    return buf;
  }

  function loadLibvlcFuncs(lib) {
    const f = (name, ret, params) => { lib[name] = lib.func(name, ret, params); };
    f('libvlc_new', 'void *', ['int32', 'void *']);
    f('libvlc_release', 'void', ['void *']);
    f('libvlc_get_version', 'string', []);
    f('libvlc_media_new_location', 'void *', ['void *', 'string']);
    f('libvlc_media_new_path', 'void *', ['void *', 'string']);
    f('libvlc_media_release', 'void', ['void *']);
    f('libvlc_media_player_new', 'void *', ['void *']);
    f('libvlc_media_player_set_media', 'void', ['void *', 'void *']);
    f('libvlc_media_player_play', 'int32', ['void *']);
    f('libvlc_media_player_pause', 'void', ['void *']);
    f('libvlc_media_player_set_pause', 'void', ['void *', 'int32']);
    f('libvlc_media_player_stop', 'void', ['void *']);
    f('libvlc_media_player_release', 'void', ['void *']);
    f('libvlc_media_player_get_state', 'int32', ['void *']);
    f('libvlc_media_player_is_playing', 'int32', ['void *']);
    f('libvlc_media_player_get_time', 'int64', ['void *']);
    f('libvlc_media_player_set_time', 'void', ['void *', 'int64']);
    f('libvlc_media_player_get_length', 'int64', ['void *']);
    f('libvlc_media_player_get_rate', 'float', ['void *']);
    f('libvlc_media_player_set_rate', 'int32', ['void *', 'float']);
    f('libvlc_media_player_get_chapter', 'int32', ['void *']);
    f('libvlc_media_player_set_chapter', 'void', ['void *', 'int32']);
    f('libvlc_media_player_get_chapter_count', 'int32', ['void *']);
    f('libvlc_media_player_next_chapter', 'void', ['void *']);
    f('libvlc_media_player_previous_chapter', 'void', ['void *']);
    f('libvlc_media_player_get_title', 'int32', ['void *']);
    f('libvlc_media_player_set_title', 'void', ['void *', 'int32']);
    f('libvlc_media_player_get_title_count', 'int32', ['void *']);
    f('libvlc_media_player_navigate', 'void', ['void *', 'int32']);
    f('libvlc_media_player_event_manager', 'void *', ['void *']);
    f('libvlc_media_player_has_vout', 'uint32', ['void *']);
    f('libvlc_media_player_is_seekable', 'int32', ['void *']);
    f('libvlc_media_player_can_pause', 'int32', ['void *']);
    f('libvlc_video_set_callbacks', 'int32', ['void *', koffi.pointer(CbLockType), koffi.pointer(CbUnlockType), koffi.pointer(CbDisplayType), 'void *']);
    f('libvlc_video_set_format', 'int32', ['void *', 'string', 'uint32', 'uint32', 'uint32']);
    f('libvlc_video_get_spu', 'int32', ['void *']);
    f('libvlc_video_get_spu_count', 'int32', ['void *']);
    f('libvlc_video_set_spu', 'int32', ['void *', 'int32']);
    f('libvlc_audio_get_volume', 'int32', ['void *']);
    f('libvlc_audio_set_volume', 'int32', ['void *', 'int32']);
    f('libvlc_audio_get_track', 'int32', ['void *']);
    f('libvlc_audio_set_track', 'int32', ['void *', 'int32']);
    f('libvlc_audio_get_track_count', 'int32', ['void *']);
    f('libvlc_free', 'void', ['void *']);
    f('libvlc_event_attach', 'int32', ['void *', 'int32', koffi.pointer(EventCbType), 'void *']);
    f('libvlc_event_detach', 'void', ['void *', 'int32', koffi.pointer(EventCbType), 'void *']);
  }

  function onVlcEvent(pEvent) {
    let type = -1;
    try {
      type = koffi.decode(pEvent, 'int32');
    } catch (e) {
      return;
    }
    if (type === EVENT.EndReached) endedFlag = true;
    else if (type === EVENT.EncounteredError) errorFlag = true;
    eventDirty = true;
  }

  function buildState() {
    if (!ready || !mp) {
      state = { ready, loaded: false };
      return;
    }
    let st = VLC_STATE.NothingSpecial;
    let time = -1, length = -1;
    let chapter = -1, chapterCount = 0, titleCount = 0, titleIndex = -1;
    let audioCount = 0, spuCount = 0, hasVideo = false, seekable = false, canPause = false, volume = 100;
    try {
      st = libvlc.libvlc_media_player_get_state(mp);
      time = libvlc.libvlc_media_player_get_time(mp);
      length = libvlc.libvlc_media_player_get_length(mp);
      chapter = libvlc.libvlc_media_player_get_chapter(mp);
      chapterCount = libvlc.libvlc_media_player_get_chapter_count(mp);
      titleCount = libvlc.libvlc_media_player_get_title_count(mp);
      titleIndex = libvlc.libvlc_media_player_get_title(mp);
      audioCount = libvlc.libvlc_audio_get_track_count(mp);
      spuCount = libvlc.libvlc_video_get_spu_count(mp);
      hasVideo = libvlc.libvlc_media_player_has_vout(mp) > 0;
      seekable = libvlc.libvlc_media_player_is_seekable(mp) > 0;
      canPause = libvlc.libvlc_media_player_can_pause(mp) > 0;
      volume = libvlc.libvlc_audio_get_volume(mp);
    } catch (e) {}

    // DVD menu detection: libvlc reports the disc menu as title 0 while the
    // movie itself is title >= 1. When in the menu, chapter navigation must be
    // blocked - libvlc's next/previous_chapter in menu mode jumps to the movie
    // PGC (that's what "pressing next then prev chapter" did: it started the
    // feature). Arrows are the correct way to move around a DVD menu.
    const inMenu = loaded && isDvd && (st === VLC_STATE.Stopped || chapterCount <= 0 || titleIndex === 0);
    state = {
      ready, loaded, isDvd, isBluray, title: currentTitle,
      state: st, playing: st === VLC_STATE.Playing, paused: st === VLC_STATE.Paused, inMenu,
      time: time < 0 ? 0 : time, length: length < 0 ? 0 : length,
      chapter: chapter < 0 ? 0 : chapter, chapterCount: chapterCount < 0 ? 0 : chapterCount,
      titleIndex: titleIndex < 0 ? 0 : titleIndex, titleCount: titleCount < 0 ? 0 : titleCount,
      audioCount: audioCount < 0 ? 0 : audioCount, spuCount: spuCount < 0 ? 0 : spuCount,
      hasVideo, seekable, canPause, volume, zoom: currentZoom, mrl
    };
  }

  function pushState() {
    buildState();
    if (callbacks.onState) {
      try { callbacks.onState(state); } catch (e) {}
    }
  }

  function isActionAllowed(action) {
    if (!ready || !loaded) return action === 'eject' || action === 'volume';
    switch (action) {
      case 'play': return true;
      case 'prev':
      case 'next': return !state.inMenu && state.chapterCount > 0;
      case 'rw':
      case 'ff': return state.playing && state.seekable;
      default: return true;
    }
  }

  let lifecycleBusy = false;
  const lifecycleQueue = [];

  function pumpLifecycle() {
    if (lifecycleBusy || lifecycleQueue.length === 0) return;
    lifecycleBusy = true;
    const job = lifecycleQueue.shift();
    Promise.resolve()
      .then(job.taskFn)
      .then((val) => job.resolve(val), () => job.resolve(undefined))
      .then(() => { lifecycleBusy = false; pumpLifecycle(); });
  }

  function lifecycle(taskFn) {
    return new Promise((resolve) => {
      lifecycleQueue.push({ taskFn, resolve });
      pumpLifecycle();
    });
  }

  // Async FFI: run potentially-blocking libvlc calls on koffi worker threads so
  // the JS main thread stays free to service queued koffi callbacks (lockCb
  // etc.). A synchronous stop()/set_media()/release() on the main thread
  // deadlocks: VLC's input thread waits for the vout, the vout waits on our
  // lockCb, and lockCb can only run when the main thread is not blocked.
  function ffia(fn, ...args) {
    return new Promise((resolve, reject) => {
      try {
        fn.async(...args, (err, res) => (err ? reject(err) : resolve(res)));
      } catch (e) {
        reject(e);
      }
    });
  }

  async function stopInternal() {
    if (!ready || !mp) return;
    let st = VLC_STATE.NothingSpecial;
    try { st = libvlc.libvlc_media_player_get_state(mp); } catch (e) {}
    dlog('stop: initial state', st);
    if (st === VLC_STATE.Error) {
      dlog('stop: media errored, skipping stop');
      return;
    }
    if (st !== VLC_STATE.Playing && st !== VLC_STATE.Buffering && st !== VLC_STATE.Opening && st !== VLC_STATE.Paused) {
      dlog('stop: direct stop');
      try { await ffia(libvlc.libvlc_media_player_stop, mp); } catch (e) {}
      dlog('stop: direct stop done');
      return;
    }
    if (st === VLC_STATE.Playing || st === VLC_STATE.Buffering || st === VLC_STATE.Opening) {
      try { await ffia(libvlc.libvlc_media_player_set_pause, mp, 1); } catch (e) {}
      dlog('stop: pause sent');
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
        if (!ready || !mp) return;
        try { st = libvlc.libvlc_media_player_get_state(mp); } catch (e) {}
        if (st === VLC_STATE.Paused || st === VLC_STATE.Ended || st === VLC_STATE.Stopped || st === VLC_STATE.Error) break;
      }
      dlog('stop: post-pause state', st);
      if (st === VLC_STATE.Error) {
        dlog('stop: media errored during pause, skipping stop');
        return;
      }
    }
    dlog('stop: calling stop()');
    try { await ffia(libvlc.libvlc_media_player_stop, mp); } catch (e) {}
    dlog('stopPlayback done');
  }

  function stopPlayback() {
    return lifecycle(() => stopInternal());
  }

  function play() {
    if (!ready || !mp) return;
    lifecycle(async () => {
      try {
        await ffia(libvlc.libvlc_media_player_set_pause, mp, 0);
        await ffia(libvlc.libvlc_media_player_play, mp);
      } catch (e) {}
      pushState();
    });
  }

  function pause() {
    if (!ready || !mp) return;
    lifecycle(async () => {
      try { await ffia(libvlc.libvlc_media_player_set_pause, mp, 1); } catch (e) {}
      pushState();
    });
  }

  function seekBy(seconds) {
    if (!ready || !mp) return;
    try {
      let t = libvlc.libvlc_media_player_get_time(mp);
      let len = libvlc.libvlc_media_player_get_length(mp);
      if (t < 0) return;
      let nt = t + seconds * 1000;
      if (len > 0) nt = Math.max(0, Math.min(nt, len));
      libvlc.libvlc_media_player_set_time(mp, nt);
    } catch (e) {}
    pushState();
  }

  function nextChapter() {
    if (!ready || !mp) return;
    dlog('nextChapter: inMenu=' + state.inMenu + ' title=' + state.titleIndex + ' chapters=' + state.chapterCount + ' st=' + state.state);
    if (state.inMenu) return;
    try { libvlc.libvlc_media_player_next_chapter(mp); } catch (e) {}
    pushState();
  }

  function prevChapter() {
    if (!ready || !mp) return;
    dlog('prevChapter: inMenu=' + state.inMenu + ' title=' + state.titleIndex + ' chapters=' + state.chapterCount + ' st=' + state.state);
    if (state.inMenu) return;
    try { libvlc.libvlc_media_player_previous_chapter(mp); } catch (e) {}
    pushState();
  }

  function setVolume(v) {
    if (!ready || !mp) return;
    try { libvlc.libvlc_audio_set_volume(mp, Math.max(0, Math.min(100, Math.round(v)))); } catch (e) {}
    pushState();
  }

  function applyZoomToCanvas() {
    if (!canvas) return;
    const fit = (currentZoom === 'stretch' || currentZoom === 'dynamic') ? 'fill' : (currentZoom === 'crop' ? 'cover' : 'contain');
    canvas.style.objectFit = fit;
  }

  function setZoom(z) {
    currentZoom = z;
    applyZoomToCanvas();
    pushState();
  }

  function setAudioTrack(i) {
    if (!ready || !mp) return;
    try { libvlc.libvlc_audio_set_track(mp, i); } catch (e) {}
    pushState();
  }

  function setSubtitle(i) {
    if (!ready || !mp) return;
    try { libvlc.libvlc_video_set_spu(mp, i); } catch (e) {}
    pushState();
  }

  function goToTitleMenu() {
    if (!ready || !mp || !loaded) return;
    lifecycle(async () => {
      try { await ffia(libvlc.libvlc_media_player_set_rate, mp, 1.0); } catch (e) {}
      if (isDvd) {
        // Jump to the disc's menu via the standard title-switch path:
        // set_title(0) -> DEMUX_SET_TITLE 0 -> dvdnav_menu_call(DVD_MENU_Root).
        // es_out routes title switches to every demuxer, while navigate(Popup)
        // is forwarded only through the menu SPU track - which is not routed
        // while the movie is playing (that's why the button did nothing).
        dlog('goToTitleMenu: set_title(0)');
        try { libvlc.libvlc_media_player_set_title(mp, 0); } catch (e) {}
      } else {
        try {
          await ffia(libvlc.libvlc_media_player_set_time, mp, 0);
          await ffia(libvlc.libvlc_media_player_play, mp);
        } catch (e) {}
      }
      pushState();
    });
  }

  function navigate(dir) {
    if (!ready || !mp || !loaded || !isDvd) return;
    dlog('navigate dir=' + dir + ' inMenu=' + state.inMenu + ' title=' + state.titleIndex + ' st=' + state.state);
    try { libvlc.libvlc_media_player_navigate(mp, dir); } catch (e) {}
  }

  function releaseMedia() {
    if (media) {
      try { libvlc.libvlc_media_release(media); } catch (e) {}
      media = null;
    }
  }

  function startMedia(mrlOrPath, opts) {
    return lifecycle(async () => {
      if (!ready || !mp) return { ok: false, message: 'DVD engine not ready' };
      try {
        if (media && mrl === mrlOrPath && state.playing) {
          dlog('startMedia', mrlOrPath, '-> same media playing, restarting cleanly');
        }
        await stopInternal();
        if (!ready || !mp) return { ok: false, message: 'DVD engine not ready' };
        decodedCount = 0;
        paintedCount = 0;
        rafCount = 0;
        releaseMedia();
        try { await ffia(libvlc.libvlc_media_player_set_pause, mp, 0); } catch (e) {}
        if (opts.isFile) {
          media = libvlc.libvlc_media_new_path(inst, mrlOrPath);
        } else {
          media = libvlc.libvlc_media_new_location(inst, mrlOrPath);
        }
        if (!media) {
          dlog('startMedia', mrlOrPath, '-> no media');
          return { ok: false, message: 'Could not open media' };
        }
        loaded = true;
        isDvd = !!opts.isDvd;
        isBluray = !!opts.isBluray;
        mrl = mrlOrPath;
        mediaIsFile = !!opts.isFile;
        currentTitle = opts.title || currentTitle;
        await ffia(libvlc.libvlc_media_player_set_media, mp, media);
        try { await ffia(libvlc.libvlc_media_player_set_rate, mp, 1.0); } catch (e) {}
        await ffia(libvlc.libvlc_media_player_play, mp);
        if (isDvd) scheduleAutoPlayCheck();
        dlog('startMedia', mrlOrPath, '-> ok');
        pushState();
        return { ok: true, chapters: state.chapterCount || 0 };
      } catch (e) {
        dlog('startMedia', mrlOrPath, 'error:', e.message);
        return { ok: false, message: e.message || 'Failed to start playback' };
      }
    });
  }

  function scheduleAutoPlayCheck() {
    autoPlaySeq++;
    autoPlayStartedAt = Date.now();
    autoPlayAttempt = 0;
  }

  function cancelAutoPlay() {
    autoPlaySeq = 0;
  }

  function checkAutoPlay() {
    if (autoPlaySeq === 0) return;
    if (!ready || !mp || !loaded || !isDvd) return;
    let st = -1;
    try {
      st = libvlc.libvlc_media_player_get_state(mp);
    } catch (e) {}
    dlog('autoplay: state', st, 'attempt', autoPlayAttempt);

    if (st === VLC_STATE.Error) {
      dlog('autoplay: disc error, retrying play');
      try { ffia(libvlc.libvlc_media_player_play, mp); } catch (e) {}
      if (autoPlayAttempt >= 3) {
        dlog('autoplay: giving up after repeated errors');
        autoPlaySeq = 0;
      } else {
        autoPlayAttempt++;
      }
      return;
    }

    if (st === VLC_STATE.NothingSpecial || st === VLC_STATE.Opening || st === VLC_STATE.Buffering || st === VLC_STATE.Stopped) {
      if (Date.now() - autoPlayStartedAt > 40000) {
        if (autoPlayAttempt >= 3) {
          dlog('autoplay: giving up after repeated open timeouts');
          autoPlaySeq = 0;
          return;
        }
        dlog('autoplay: disc open timeout (40s), retrying play (attempt', autoPlayAttempt + ')');
        try { ffia(libvlc.libvlc_media_player_play, mp); } catch (e) {}
        autoPlayStartedAt = Date.now();
        autoPlayAttempt++;
      }
      return;
    }

    // Playing / Paused / Ended: leave the disc alone so its own navigation
    // runs from the beginning (studio logos, warnings, previews, then menus).
    dlog('autoplay: playing, letting disc navigation proceed');
    autoPlaySeq = 0;
  }

  function attachEvents(em) {
    eventCb = koffi.register((pEvent) => onVlcEvent(pEvent), koffi.pointer(EventCbType));
    const types = [
      EVENT.Playing, EVENT.Paused, EVENT.Stopped, EVENT.EndReached, EVENT.EncounteredError,
      EVENT.TimeChanged, EVENT.TitleChanged, EVENT.LengthChanged, EVENT.Vout, EVENT.ChapterChanged
    ];
    for (const t of types) {
      try { libvlc.libvlc_event_attach(em, t, eventCb, null); } catch (e) {}
    }
  }

  function paintOne() {
    if (endedFlag) { endedFlag = false; if (callbacks.onEnded) { try { callbacks.onEnded(); } catch (e) {} } }
    if (errorFlag) { errorFlag = false; if (callbacks.onError) { try { callbacks.onError({ message: 'Playback error' }); } catch (e) {} } }
    if (eventDirty) { eventDirty = false; pushState(); }
    if (!newFrame || !ctx) return;
    newFrame = false;
    try {
      // 'RGBA' chroma is already R,G,B,A (ImageData order), so just blit.
      ctx.putImageData(imageData, 0, 0);
      paintedCount++;
      if (!firstFrameDone) {
        firstFrameDone = true;
        if (callbacks.onFirstFrame) { try { callbacks.onFirstFrame(); } catch (e) {} }
      }
    } catch (e) {
      dlog('paint error:', e.message);
    }
  }

  function paintLoop() {
    rafId = requestAnimationFrame(paintLoop);
    rafCount++;
    paintOne();
  }

  let watchdogTimer = null;

  function shutdown() {
    autoPlaySeq = 0;
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (resizeObserver) { try { resizeObserver.disconnect(); } catch (e) {} resizeObserver = null; }
    (async () => {
      try {
        if (mp) await ffia(libvlc.libvlc_media_player_stop, mp);
      } catch (e) {}
      for (const cb of [eventCb, lockCb, unlockCb, displayCb]) {
        if (cb && koffi) { try { koffi.unregister(cb); } catch (e) {} }
      }
      eventCb = null; lockCb = null; unlockCb = null; displayCb = null;
      try {
        if (mp) {
          releaseMedia();
          await ffia(libvlc.libvlc_media_player_release, mp);
          mp = null;
        }
        if (inst) { try { libvlc.libvlc_release(inst); } catch (e) {} inst = null; }
      } catch (e) {}
      ready = false;
    })();
  }

  function init(opts) {
    const vlcDir = findVlcDir();
    if (!vlcDir) {
      dlog('VLC runtime not found (vendor/vlc missing)');
      return false;
    }
    try {
      koffi = window.require('koffi');
      kernel32 = koffi.load('kernel32.dll');
      const decl = (name, ret, params) => { kernel32[name] = kernel32.func('__stdcall', name, ret, params); };
      decl('SetDllDirectoryW', 'int32', ['str16']);
      kernel32.SetDllDirectoryW(vlcDir);

      libvlc = koffi.load(path.join(vlcDir, 'libvlc.dll'));
      EventCbType = koffi.proto('dvdEventCb', 'void', ['void *', 'void *']);
      CbLockType = koffi.proto('vlcLock', 'void *', ['void *', 'void *']);
      CbUnlockType = koffi.proto('vlcUnlock', 'void', ['void *', 'void *', 'void *']);
      CbDisplayType = koffi.proto('vlcDisplay', 'void', ['void *', 'void *']);
      loadLibvlcFuncs(libvlc);

      dlog('libvlc', libvlc.libvlc_get_version(), 'from', vlcDir);

      // VLC's dvdnav-menu option DEFAULTS TO TRUE - its own text: "Start the
      // DVD directly in the main menu. This will try to skip all the useless
      // warning introductions." Omitting the flag is NOT enough: it must be
      // explicitly disabled with --no-dvdnav-menu. We want the disc's own
      // sequence (studio logos, FBI warning, previews) before the menu, and
      // the first-play PGC must run so the disc's menus get their SPRM/GPRM
      // state set up before the user navigates them.
      const args = [
        '--no-video-title-show',
        '--quiet',
        '--no-osd',
        '--no-keyboard-events',
        '--no-mouse-events',
        '--avcodec-hw=none',
        '--avcodec-threads=4',
        '--no-dvdnav-menu'
      ];
      if (process.env.MIDIA_VLC_LOG) {
        args.push('--logfile=' + process.env.MIDIA_VLC_LOG);
        args.push('--log-verbose=2');
      }
      if (process.env.MIDIA_VOUT) args.push('--vout=' + process.env.MIDIA_VOUT);
      inst = libvlc.libvlc_new(args.length, makeArgv(args));
      if (!inst) {
        throw new Error('libvlc_new failed');
      }

      mp = libvlc.libvlc_media_player_new(inst);
      if (!mp) throw new Error('libvlc_media_player_new failed');

      frameBuffer = Buffer.alloc(FRAME_PITCH * FRAME_H);
      imageData = new ImageData(new Uint8ClampedArray(frameBuffer.buffer, frameBuffer.byteOffset, frameBuffer.length), FRAME_W, FRAME_H);

      canvas = opts.canvas || null;
      if (canvas) {
        canvas.width = FRAME_W;
        canvas.height = FRAME_H;
        ctx = canvas.getContext('2d');
        applyZoomToCanvas();
        if (opts.onFirstFrame && typeof opts.onFirstFrame === 'function') callbacks.onFirstFrame = opts.onFirstFrame;
      }

      lockCb = koffi.register((opaque, planes) => {
        try {
          if (frameBuffer) koffi.encode(planes, 'void *', koffi.as(frameBuffer, 'void *'));
        } catch (e) {}
        return null;
      }, koffi.pointer(CbLockType));

      unlockCb = koffi.register((opaque, pic, planes) => {}, koffi.pointer(CbUnlockType));

      displayCb = koffi.register((opaque, pic) => {
        decodedCount++;
        newFrame = true;
      }, koffi.pointer(CbDisplayType));

      // 'RGBA' chroma: VLC writes R,G,B,A byte order which is exactly what
      // ImageData expects, so paintOne() can blit the buffer with NO per-pixel
      // byte swap. ('RV32' on x86 is BGRA, which is why a swap loop existed.)
      libvlc.libvlc_video_set_format(mp, 'RGBA', FRAME_W, FRAME_H, FRAME_PITCH);
      libvlc.libvlc_video_set_callbacks(mp, lockCb, unlockCb, displayCb, null);

      const em = libvlc.libvlc_media_player_event_manager(mp);
      if (em) attachEvents(em);

      if (opts.onState && typeof opts.onState === 'function') callbacks.onState = opts.onState;
      if (opts.onEnded && typeof opts.onEnded === 'function') callbacks.onEnded = opts.onEnded;
      if (opts.onError && typeof opts.onError === 'function') callbacks.onError = opts.onError;

      ready = true;
      dlog('ready');
      pushState();
      watchdogTimer = setInterval(() => {
        if (autoPlaySeq > 0) { try { checkAutoPlay(); } catch (e) {} }
        dlog('wd decoded=' + decodedCount + ' painted=' + paintedCount + ' raf=' + rafCount + ' newFrame=' + newFrame + ' playing=' + state.playing + ' state=' + state.state);
      }, 2000);
    } catch (e) {
      ready = false;
      dlog('init failed:', e);
    }
    return ready;
  }

  const api = {
    play,
    pause,
    stop: stopPlayback,
    seekBy,
    nextChapter,
    prevChapter,
    setVolume,
    setZoom,
    setAudioTrack,
    setSubtitle,
    goToTitleMenu,
    navigate,
    startMedia,
    cancelAutoPlay,
    isActionAllowed,
    getState() { return state; },
    stats() { return { painted: paintedCount, ready, loaded, playing: state.playing, state: state.state }; },
    shutdown
  };

  window.DvdEngine = {
    create(opts) {
      if (ready) return api;
      const ok = init(opts || {});
      if (!ok) return null;
      paintLoop();
      window.addEventListener('beforeunload', shutdown);
      return api;
    },
    getState() { return state; },
    get ready() { return ready; },
    NAVIGATE
  };
})();
