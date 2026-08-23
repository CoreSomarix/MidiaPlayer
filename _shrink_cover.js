const { app, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Standalone cover shrinker: electron _shrink_cover.js <src> <dst>
// argv = [electronExe, thisScript, src, dst]
// Runs one image per process so a Skia allocation FATAL on a giant
// bitmap only costs this helper, never the main app.
// Exit codes: 0 = resized file written to dst; 5 = already small, nothing to do;
// 2 = undecodable; 3 = unexpected failure; 4 = bad args.
const src = process.argv[2];
const dst = process.argv[3];

// Use a throwaway profile: the running Midia instance holds the lock on the
// real userData dir, and contending for it makes the helper sit on a hidden
// dialog forever instead of doing work.
app.setPath('userData', path.join(os.tmpdir(), 'midia-shrink-helper'));

app.whenReady().then(() => {
  if (!src || !dst || !fs.existsSync(src)) {
    console.error('[shrink] bad args', { src, dst });
    process.exit(4);
  }
  try {
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) process.exit(2);
    const sz = img.getSize();
    const big = Math.max(sz.width, sz.height);
    if (big <= 900) process.exit(5);
    const k = 800 / big;
    const small = img.resize({ width: Math.max(1, Math.round(sz.width * k)), height: Math.max(1, Math.round(sz.height * k)) });
    const out = /\.png$/i.test(src) ? small.toPNG() : small.toJPEG(82);
    if (!out || !out.length) process.exit(3);
    fs.writeFileSync(dst, out);
    console.log('[shrink] ' + sz.width + 'x' + sz.height + ' -> ' + small.getSize().width + 'x' + small.getSize().height + ' :: ' + path.basename(src));
    process.exit(0);
  } catch (e) {
    process.exit(3);
  }
});
