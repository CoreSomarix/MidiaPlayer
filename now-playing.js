// now-playing.js — Now Playing redesign + WMP visualization hosting
// Layers: gradient (z1) | viz canvas (z2) | dot grid (z3) | UI (z10) | popup (z20+)
(function () {
    'use strict';

    // Self-contained logger: AppLog lives inside index.html's closure scope,
    // unreachable from here. Referencing it throws ReferenceError.
    const NPLog = {
        info: (msg) => { try { console.log('[npviz] ' + msg); } catch (e) {} },
        error: (msg) => { try { console.error('[npviz:error] ' + msg); } catch (e) {} },
    };

    // ==================================================================
    // WMP VISUALIZATION COM HOST (koffi, runs in 32-bit renderer)
    // ==================================================================
    const WmpHost = (function () {
        let koffi = null;
        try { koffi = require('koffi'); } catch (e) {}


        const FAMILIES = [
            // Only family modern systems serve without full WMP player hosting.
            // (Bars & Waves/Battery/Ambience/Plenoptic/Spikes/Dotplane code exists
            // inside wmp.dll but its class factories are withheld by design —
            // DllGetClassObject returns 0x80040111 even via ordinal 3004 and
            // under an impersonated wmplayer.exe image name. Battery lives on
            // as a native BuiltIn instead.)
            { id: 'alchemy', name: 'Alchemy', clsid: '0AA02E8D-F851-4CB0-9F64-BBA9BE7A983D' },
        ];

        const SA_BUFFER_SIZE = 1024;
        const LEVELS_SIZE = 2048 + 2048 + 4 + 4 + 8; // freq[2][1024] + wave[2][1024] + state(int) + pad + hyper

        let bindings = null;

        function guidBuf(str) {
            const h = String(str).replace(/[{}\-]/g, '');
            const b = Buffer.alloc(16);
            b.writeUInt32LE(parseInt(h.substr(0, 8), 16), 0);
            b.writeUInt16LE(parseInt(h.substr(8, 4), 16), 4);
            b.writeUInt16LE(parseInt(h.substr(12, 4), 16), 6);
            for (let i = 0; i < 8; i++) b.writeUInt8(parseInt(h.substr(16 + i * 2, 2), 16), 8 + i);
            return b;
        }

        function dllDir() {
            const candidates = [];
            try { candidates.push(require('path').join(__dirname, 'vendor', 'wmp-viz', 'raw', 'wmp10-x86')); } catch (e) {}
            try { candidates.push(require('path').join(process.resourcesPath || '', 'vendor', 'wmp-viz', 'raw', 'wmp10-x86')); } catch (e) {}
            for (const dir of candidates) {
                try { if (dir && require('fs').existsSync(require('path').join(dir, 'wmp.dll'))) return dir; } catch (e) {}
            }
            return null;
        }

        // Prototype strings with explicit __stdcall (ia32 stack cleanup).
        // Cached by SIGNATURE so every family/instance reuses the same proto object.
        const protoCache = new Map();
        function makeProto(retType, argTypes) {
            const key = retType + '|' + argTypes.join(',');
            if (protoCache.has(key)) return protoCache.get(key);
            const p = koffi.proto(retType + ' __stdcall NP_Proto' + protoCache.size + '(' + argTypes.join(', ') + ')');
            protoCache.set(key, p);
            return p;
        }

        function bindFn(fp, retType, argTypes, nameHint) {
            if (!fp) throw new Error(nameHint + ': null function pointer');
            const fn = koffi.decode(fp, makeProto(retType, argTypes));
            if (typeof fn !== 'function') throw new Error(nameHint + ': not callable');
            return fn;
        }

        // COM method = stdcall with implicit this as first arg
        function bindMethod(slots, idx, retType, argTypes, nameHint) {
            if (!slots || idx >= slots.length) throw new Error(nameHint + ': vtable slot ' + idx + ' out of range');
            return bindFn(slots[idx], retType, ['void *'].concat(argTypes), nameHint);
        }

        const VT_SLOTS = 24;
        function readVTable(objPtr) {
            const vtbl = koffi.decode(objPtr, 'void *');
            if (!vtbl) throw new Error('null vtable pointer');
            return koffi.decode(vtbl, koffi.array('void *', VT_SLOTS));
        }

        function initBindings(dir) {
            const path = require('path');
            const kernel32 = koffi.load('kernel32.dll');
            const gdi32 = koffi.load('gdi32.dll');
            const oleaut32 = koffi.load('oleaut32.dll');

            bindings = {
                LoadLibraryExW: kernel32.func('__stdcall', 'LoadLibraryExW', 'void*', ['str16', 'void*', 'uint32']),
                GetProcAddress: kernel32.func('__stdcall', 'GetProcAddress', 'void*', ['void*', 'str']),
                RtlMoveMemory: kernel32.func('__stdcall', 'RtlMoveMemory', 'void', ['void*', 'void*', 'long']),
                SysAllocString: oleaut32.func('__stdcall', 'SysAllocString', 'void*', ['str16']),
                SysFreeString: oleaut32.func('__stdcall', 'SysFreeString', 'void', ['void*']),
                CreateCompatibleDC: gdi32.func('__stdcall', 'CreateCompatibleDC', 'void*', ['void*']),
                DeleteDC: gdi32.func('__stdcall', 'DeleteDC', 'int', ['void*']),
                CreateDIBSection: gdi32.func('__stdcall', 'CreateDIBSection', 'void*', ['void*', 'void*', 'uint32', 'void**', 'void*', 'uint32']),
                DeleteObject: gdi32.func('__stdcall', 'DeleteObject', 'int', ['void*']),
                SelectObject: gdi32.func('__stdcall', 'SelectObject', 'void*', ['void*', 'void*']),
                bindFn, bindMethod, readVTable,
            };

            // Load every candidate host DLL; families are served per-DLL.
            bindings.dgcList = [];
            for (const fname of ['mpvis.DLL', 'wmp.dll']) {
                const fp = path.join(dir, fname);
                if (!require('fs').existsSync(fp)) continue;
                const hMod = bindings.LoadLibraryExW(fp, null, 0x8 /* LOAD_WITH_ALTERED_SEARCH_PATH */);
                if (!hMod) { NPLog.info(fname + ' failed to load'); continue; }
                const dgcPtr = bindings.GetProcAddress(hMod, 'DllGetClassObject');
                if (!dgcPtr) { NPLog.info(fname + ' has no DllGetClassObject'); continue; }
                bindings.dgcList.push({ tag: fname, dgc: bindFn(dgcPtr, 'int32', ['void*', 'void*', 'void**'], 'DllGetClassObject') });
            }
            if (!bindings.dgcList.length) { bindings = null; throw new Error('no usable visualization DLL found'); }
        }

        // Per-family live instance
        function makeInstance(family) {
            const B = bindings;
            const clsidBuf = guidBuf(family.clsid);
            const iidCF = guidBuf('00000001-0000-0000-C000-000000000046');
            const iidEffects = guidBuf('D3984C13-C3CB-48E2-8BE5-5168340B4F35'); // IID_IWMPEffects
            const iidUnk = guidBuf('00000000-0000-0000-C000-000000000046');

            // Acquire the class object via IID_IUnknown (some legacy DLLs reject
            // IID_IClassFactory here), then QI it for the factory interface.
            let unk = null, lastHr = 0;
            for (const entry of B.dgcList) {
                const ub = Buffer.alloc(8);
                const hr = entry.dgc(clsidBuf, iidUnk, ub);
                if (hr === 0) { unk = koffi.decode(ub, 'void*'); break; }
                lastHr = hr;
            }
            if (!unk) throw new Error('DllGetClassObject failed hr=0x' + (lastHr >>> 0).toString(16));

            const unkSlots = B.readVTable(unk);
            const QueryInterface = B.bindMethod(unkSlots, 0, 'int32', ['void*', 'void**'], 'IUnknown::QueryInterface');
            const ReleaseClassObj = B.bindMethod(unkSlots, 2, 'uint32', [], 'IUnknown::Release');

            let factory = null;
            let factoryIsUnk = false;
            const cfBuf = Buffer.alloc(8);
            if (QueryInterface(unk, iidCF, cfBuf) === 0) {
                factory = koffi.decode(cfBuf, 'void*');
            } else {
                // Legacy DLLs sometimes return the factory itself for IID_IUnknown
                factory = unk;
                factoryIsUnk = true;
            }
            if (!factory) { try { ReleaseClassObj(unk); } catch (e) {} throw new Error('null class factory'); }

            const cfSlots = B.readVTable(factory);
            const CreateInstance = B.bindMethod(cfSlots, 3, 'int32', ['void*', 'void*', 'void**'], 'IClassFactory::CreateInstance');
            const ReleaseFactory = B.bindMethod(cfSlots, 2, 'uint32', [], 'IClassFactory::Release');

            const objBuf = Buffer.alloc(8);
            let createHr = CreateInstance(factory, null, iidEffects, objBuf);
            let effects = null;
            if (createHr === 0) {
                effects = koffi.decode(objBuf, 'void*');
            } else {
                // Fall back to primary interface (IUnknown vtable == most-derived primary)
                createHr = CreateInstance(factory, null, iidUnk, objBuf);
                if (createHr !== 0) { try { ReleaseFactory(factory); } catch (e) {} throw new Error('CreateInstance failed hr=0x' + (createHr >>> 0).toString(16)); }
                effects = koffi.decode(objBuf, 'void*');
            }
            try { ReleaseFactory(factory); } catch (e) {}
            if (!effects) throw new Error('null effects object');

            const slots = B.readVTable(effects);
            const inst = { family, obj: effects };
            inst.Release = B.bindMethod(slots, 2, 'uint32', [], 'IUnknown::Release');
            inst.Render = B.bindMethod(slots, 3, 'int32', ['void*', 'void*', 'void*'], 'Render');
            inst.MediaInfo = B.bindMethod(slots, 4, 'int32', ['int32', 'int32', 'void*'], 'MediaInfo');
            inst.GetCapabilities = B.bindMethod(slots, 5, 'int32', ['void*'], 'GetCapabilities');
            inst.GetTitle = B.bindMethod(slots, 6, 'int32', ['void**'], 'GetTitle');
            inst.GetPresetTitle = B.bindMethod(slots, 7, 'int32', ['int32', 'void**'], 'GetPresetTitle');
            inst.GetPresetCount = B.bindMethod(slots, 8, 'int32', ['void*'], 'GetPresetCount');
            inst.SetCurrentPreset = B.bindMethod(slots, 9, 'int32', ['int32'], 'SetCurrentPreset');
            inst.GetCurrentPreset = B.bindMethod(slots, 10, 'int32', ['void*'], 'GetCurrentPreset');

            // Read a BSTR out-param written by the callee
            inst.readBstr = (outBuf) => {
                try {
                    const p = koffi.decode(outBuf, 'void*');
                    if (!p) return '';
                    const s = koffi.decode(p, 'str16') || '';
                    try { B.SysFreeString(p); } catch (e) {}
                    return s;
                } catch (e) { return ''; }
            };
            return inst;
        }

        // Surface = GDI DIB the effect paints into
        function makeSurface(width, height) {
            const B = bindings;
            const memDC = B.CreateCompatibleDC(null);
            if (!memDC) throw new Error('CreateCompatibleDC failed');
            const bi = Buffer.alloc(40);
            bi.writeUInt32LE(40, 0);
            bi.writeInt32LE(width, 4);
            bi.writeInt32LE(-height, 8); // top-down
            bi.writeUInt16LE(1, 12);
            bi.writeUInt16LE(32, 14);
            bi.writeUInt32LE(0, 16); // BI_RGB
            bi.writeUInt32LE(width * height * 4, 20);
            const bitsOut = Buffer.alloc(8);
            const hbm = B.CreateDIBSection(memDC, bi, 0, bitsOut, null, 0);
            if (!hbm) { B.DeleteDC(memDC); throw new Error('CreateDIBSection failed'); }
            const bits = koffi.decode(bitsOut, 'void*');
            const oldBm = B.SelectObject(memDC, hbm);
            return {
                dc: memDC, hbm, bits, width, height,
                pixBuf: Buffer.alloc(width * height * 4),
                rect: (() => { const r = Buffer.alloc(16); r.writeInt32LE(0, 0); r.writeInt32LE(0, 4); r.writeInt32LE(width, 8); r.writeInt32LE(height, 12); return r; })(),
                destroy() {
                    try { B.SelectObject(memDC, oldBm); } catch (e) {}
                    try { B.DeleteObject(hbm); } catch (e) {}
                    try { B.DeleteDC(memDC); } catch (e) {}
                },
                grab() { B.RtlMoveMemory(this.pixBuf, this.bits, this.pixBuf.length); return this.pixBuf; },
            };
        }

        return {
            families: FAMILIES,
            ready: false,
            error: null,

            init() {
                if (!koffi || bindings) return;
                try {
                    const dir = dllDir();
                    if (!dir) throw new Error('wmp.dll assets not found');
                    initBindings(dir);
                    this.ready = true;
                    NPLog.info('WMP host initialized');
                } catch (e) {
                    this.error = e.message;
                    NPLog.error('WMP host init failed: ' + e.message);
                }
            },

            // Probe a family: instantiate, validate capabilities, release.
            // NOTE: GetTitle/GetPresetCount/GetPresetTitle deadlock modern mpvis
            // (Alchemy) — metadata must come from the family table instead.
            probe(family) {
                if (!this.ready) return null;
                const inst = makeInstance(family);
                try {
                    const capBuf = Buffer.alloc(8);
                    inst.GetCapabilities(inst.obj, capBuf);
                    return { title: family.name, presets: ['Default'] };
                } finally {
                    try { inst.Release(inst.obj); } catch (e) {}
                }
            },

            activate(family) {
                if (!this.ready) throw new Error('WMP host not ready');
                const inst = makeInstance(family);
                try { inst.MediaInfo(inst.obj, 2, 44100, bindings.SysAllocString(family.name)); } catch (e) {}
                return inst;
            },

            deactivate(inst) {
                if (!inst) return;
                try { inst.Release(inst.obj); } catch (e) {}
            },

            surface(width, height) { return makeSurface(width, height); },
            levelsBuffer() { return Buffer.alloc(LEVELS_SIZE); },
        };
    })();

    // ==================================================================
    // BATTERY ENGINE — faithful rebuild of the classic WMP family.
    // Architecture mirrors the real internals extracted from wmp.dll:
    // frame-feedback canvas + displacement "shift" units + pre/post
    // overlay drawers + per-preset palettes with lock behavior.
    // ==================================================================
    const BatteryViz = (() => {
        let fw = 320, fh = 180;
        let fbCanvas = null, fbCtx = null;
        let imgA = null, outBuf = null;
        let t = 0, spinVel = 0, beatEma = 0, lastBeat = -1;
        let curIdx = 0, curCfg = null, ramps = null;
        let walkers = [], stars = null;

        function hex(h) {
            return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
        }
        function makeRamp(cols) {
            const rgb = cols.map(hex);
            return (u) => {
                u = u - Math.floor(u);
                const n = rgb.length;
                const p = u * n, i = Math.floor(p) % n, j = (i + 1) % n, fr = p - Math.floor(p);
                const a = rgb[i], b = rgb[j];
                return [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr, a[2] + (b[2] - a[2]) * fr];
            };
        }

        function feats(lvl) {
            const fq = lvl.freqL, wv = lvl.waveL;
            let bass = 0, mid = 0, treb = 0;
            for (let i = 2; i < 26; i++) bass += fq[i];
            for (let i = 26; i < 170; i++) mid += fq[i];
            for (let i = 170; i < 500; i++) treb += fq[i];
            bass /= 24 * 255; mid /= 144 * 255; treb /= 330 * 255;
            if (!lvl.playing) { bass *= 0.15; mid *= 0.15; treb *= 0.15; }
            beatEma += (bass - beatEma) * 0.06;
            const beat = lvl.playing && bass > 0.28 && bass > beatEma * 1.32 && (t - lastBeat) > 0.14;
            if (beat) lastBeat = t;
            return { bass, mid, treb, level: Math.min(1, bass * 1.3 + mid * 0.8 + treb * 0.5), wave: wv, beat };
        }

        function ensureBuffers(w, h) {
            const nh = Math.max(120, Math.min(260, Math.round(fw * h / Math.max(1, w))));
            if (!fbCanvas || fh !== nh) {
                fh = nh;
                fbCanvas = document.createElement('canvas');
                fbCanvas.width = fw; fbCanvas.height = fh;
                fbCtx = fbCanvas.getContext('2d', { willReadFrequently: true });
                fbCtx.fillStyle = '#000'; fbCtx.fillRect(0, 0, fw, fh);
                imgA = fbCtx.getImageData(0, 0, fw, fh);
                outBuf = new Uint8ClampedArray(imgA.data.length);
            }
        }

        function hash2(x, y, s) {
            let n = (x * 374761393 + y * 668265263 + s * 974711) | 0;
            n = Math.imul(n ^ (n >>> 13), 1274126177);
            return ((n >>> 16) & 0xff) / 255;
        }

        const SHIFT_KINDS = ['zoom','swirl','ringspin','starburst','stretch','tile','trig','shimmer','edgefalloff','trigstretch','twirlocity','thingus','linear'];

        function renderFrame(f, dt) {
            const P = curCfg, src = imgA.data, dst = outBuf;
            const W = fw, H = fh, cx = W / 2, cy = H / 2;
            const rmax = Math.sqrt(cx * cx + cy * cy);
            const d = P.decay;
            const tint = P.tintHex ? hex(P.tintHex) : null;
            const lv = f.level, bs = f.bass;
            const kind = SHIFT_KINDS.indexOf(P.shift);
            const a = (P.amp || 0.5) * (0.35 + 0.65 * lv);
            let kick = 0;
            if (f.beat) kick = 1;
            const pr = P.p || {};
            const nSeg = pr.n || 6;
            const spd = (pr.spd || 1) * (pr.audioSpd ? (0.3 + lv * 1.7) : 1);

            let di = 0;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++, di += 4) {
                    let sx = x, sy = y, tmp;
                    switch (kind) {
                        case 0: { const sc = 1 - (0.06 + a * 0.34); sx = cx + (x - cx) * sc; sy = cy + (y - cy) * sc; break; }
                        case 1: {
                            const dx = x - cx, dy = y - cy;
                            const r = Math.sqrt(dx * dx + dy * dy) + 0.001, rn = r / rmax;
                            const ang = a * Math.pow(1 - rn, 1.6) * 5 + t * 0.4 * spd;
                            const ca = Math.cos(ang), sa = Math.sin(ang);
                            sx = cx + dx * ca - dy * sa; sy = cy + dx * sa + dy * ca; break;
                        }
                        case 2: {
                            const dx = x - cx, dy = y - cy;
                            const r = Math.sqrt(dx * dx + dy * dy);
                            let th = Math.atan2(dy, dx) + t * 0.25 * spd;
                            const sec = (Math.PI * 2) / nSeg;
                            let m = th % sec; if (m < 0) m += sec;
                            const wi = Math.floor((th + (th < 0 ? -Math.PI * 2 : 0)) / sec) & 1;
                            if (wi) m = sec - m;
                            sx = cx + Math.cos(m) * r; sy = cy + Math.sin(m) * r; break;
                        }
                        case 3: {
                            const dx = x - cx, dy = y - cy;
                            const r = Math.sqrt(dx * dx + dy * dy) + 0.001;
                            const th = Math.atan2(dy, dx);
                            const sp = Math.pow(Math.max(0, Math.sin(nSeg * th - t * 2.2 * spd)), 2);
                            const rr = r * (1 - (a * 0.45 + kick * 0.18) * sp);
                            sx = cx + Math.cos(th) * rr; sy = cy + Math.sin(th) * rr; break;
                        }
                        case 4: {
                            const dx = x - cx, dy = y - cy;
                            const r = Math.sqrt(dx * dx + dy * dy) + 0.001, rn = Math.min(1, r / rmax);
                            const e = 1 + a * 2.2;
                            const rr = Math.pow(rn, e) * rmax;
                            const th = Math.atan2(dy, dx) + t * 0.1;
                            sx = cx + Math.cos(th) * rr; sy = cy + Math.sin(th) * rr; break;
                        }
                        case 5: {
                            const B = pr.B || 24;
                            const stp = Math.floor(t * 1.6);
                            const jx = (hash2(Math.floor(x / B), Math.floor(y / B), stp) - 0.5) * B * a * 1.6;
                            const jy = (hash2(Math.floor(y / B) + 77, Math.floor(x / B), stp + 13) - 0.5) * B * a * 1.6;
                            sx = x + jx; sy = y + jy; break;
                        }
                        case 6: {
                            sx = x + a * 13 * Math.sin(y * (pr.f1 || 0.09) + t * 1.4 * spd);
                            sy = y + a * 13 * Math.cos(x * (pr.f2 || 0.075) + t * 1.1 * spd); break;
                        }
                        case 7: {
                            sx = x + a * 4 * Math.sin(y * 0.55 + t * 6 * spd);
                            sy = y + a * 4 * Math.cos(x * 0.5 + t * 5 * spd); break;
                        }
                        case 8: {
                            const mx = Math.abs(x - cx) / cx, my = Math.abs(y - cy) / cy;
                            const m = Math.max(mx, my);
                            const sc = 1 - a * 0.5 * m * m;
                            sx = cx + (x - cx) * sc; sy = cy + (y - cy) * sc; break;
                        }
                        case 9: {
                            const dx = x - cx, dy = y - cy;
                            const r = Math.sqrt(dx * dx + dy * dy) + 0.001;
                            const th = Math.atan2(dy, dx);
                            const pulse = 0.3 + 0.3 * Math.sin(t * 1.9);
                            const rr = r * (1 - a * (pulse + 0.25) * (r / rmax));
                            sx = cx + Math.cos(th + t * 0.15) * rr; sy = cy + Math.sin(th + t * 0.15) * rr; break;
                        }
                        case 10: {
                            const dx = x - cx, dy = y - cy;
                            const r = Math.sqrt(dx * dx + dy * dy) + 0.001, rn = r / rmax;
                            const ang = spinVel * (1.2 - rn) + rn * 2.2;
                            const ca = Math.cos(ang), sa = Math.sin(ang);
                            sx = cx + dx * ca - dy * sa; sy = cy + dx * sa + dy * ca; break;
                        }
                        case 11: {
                            sx = x + a * 22 * Math.sin((y + 40) * 0.02 + t * 0.7) + a * 10 * Math.sin(x * 0.013 - t * 0.43);
                            sy = y + a * 20 * Math.cos((x + 17) * 0.021 - t * 0.6) + a * 9 * Math.sin(y * 0.017 + t * 0.51); break;
                        }
                        case 12: {
                            const o = t * (pr.v || 40) * (0.3 + lv);
                            const dx = pr.dx || 1, dyy = pr.dy || 0;
                            sx = x - dx * o; sy = y - dyy * o; break;
                        }
                    }
                    if (P.wrap) {
                        sx = ((sx % W) + W) % W; sy = ((sy % H) + H) % H;
                    } else {
                        sx = sx < 0 ? 0 : sx >= W ? W - 1 : sx;
                        sy = sy < 0 ? 0 : sy >= H ? H - 1 : sy;
                    }
                    const si = (((sy | 0) * W) + (sx | 0)) << 2;
                    let r = src[si] * d, g = src[si + 1] * d, b = src[si + 2] * d;
                    if (tint) {
                        r += tint[0] * (1 - d) * 0.55; g += tint[1] * (1 - d) * 0.55; b += tint[2] * (1 - d) * 0.55;
                    }
                    const o4 = di;
                    dst[o4] = r; dst[o4 + 1] = g; dst[o4 + 2] = b; dst[o4 + 3] = 255;
                }
            }
            fbCtx.putImageData(new ImageData(dst.slice(), W, H), 0, 0);
        }

        function col(ramp, u, alpha) {
            const c = ramp(u);
            return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + alpha + ')';
        }

        function drawOverlays(f) {
            const P = curCfg, g = fbCtx, W = fw, H = fh;
            const R = ramps, cyc = t * (P.hueSpeed || 0.08);
            if (!P.post) return;
            for (const ov of P.post) {
                if (ov === 'circlewave') {
                    const rings = 2;
                    for (let ri = 0; ri < rings; ri++) {
                        g.beginPath();
                        const RR = Math.min(W, H) * (0.18 + ri * 0.11) * (1 + f.bass * 0.35);
                        for (let i = 0; i <= 96; i++) {
                            const th = (i / 96) * Math.PI * 2;
                            const wv = (f.wave[(i * 10 + ri * 250) % 1024] - 128) / 128;
                            const rr = RR + wv * RR * 0.38;
                            const px = W / 2 + Math.cos(th) * rr, py = H / 2 + Math.sin(th) * rr * 0.92;
                            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
                        }
                        g.strokeStyle = col(R, cyc + ri * 0.25, 0.85); g.lineWidth = 1.6; g.stroke();
                    }
                } else if (ov === 'spectrumedge') {
                    const bars = 48, bw = W / bars;
                    for (let i = 0; i < bars; i++) {
                        const v = f.wave ? (P.freqRef ? 0 : 0) : 0;
                        const fv = (curCfg._fq ? curCfg._fq[Math.floor((i / bars) * 300) + 2] : 0) / 255;
                        const bh2 = fv * H * 0.42;
                        g.fillStyle = col(R, cyc + i / bars, 0.8);
                        g.fillRect(i * bw + 1, H - bh2, bw - 2, bh2);
                        g.globalAlpha = 0.35;
                        g.fillRect(i * bw + 1, 0, bw - 2, bh2 * 0.6);
                        g.globalAlpha = 1;
                    }
                } else if (ov === 'edgetrace') {
                    g.beginPath();
                    const jit = f.treb * 9 + 1.5;
                    for (let i = 0; i <= 64; i++) {
                        const px = (i / 64) * W;
                        const wy = (f.wave[(i * 16) % 1024] - 128) / 128 * jit;
                        if (i === 0) g.moveTo(px, wy + 3); else g.lineTo(px, wy + 3);
                    }
                    for (let i = 64; i >= 0; i--) {
                        const px = (i / 64) * W;
                        const wy = H - 3 - (f.wave[(512 + i * 16) % 1024] - 128) / 128 * jit;
                        g.lineTo(px, wy);
                    }
                    g.closePath();
                    g.strokeStyle = col(R, cyc, 0.9); g.lineWidth = 2; g.stroke();
                } else if (ov === 'dotplane') {
                    const colsN = 24, rowsN = Math.round(colsN * H / W);
                    for (let iy = 0; iy < rowsN; iy++) {
                        for (let ix = 0; ix < colsN; ix++) {
                            const band = Math.floor(((ix + iy * colsN) % colsN) / colsN * 200) + 2;
                            const v = (curCfg._fq ? curCfg._fq[band] : 0) / 255;
                            if (v < 0.04) continue;
                            g.fillStyle = col(R, cyc + (ix / colsN) * 0.3, 0.25 + v * 0.75);
                            const dsz = 1 + v * 3;
                            g.fillRect(ix * (W / colsN) + (W / colsN) / 2 - dsz / 2, iy * (H / rowsN) + (H / rowsN) / 2 - dsz / 2, dsz, dsz);
                        }
                    }
                } else if (ov === 'jdar') {
                    const cx2 = W / 2, cy2 = H / 2, RR = Math.min(W, H) * 0.46;
                    g.strokeStyle = col(R, cyc, 0.35); g.lineWidth = 1;
                    for (let ri = 1; ri <= 3; ri++) { g.beginPath(); g.arc(cx2, cy2, RR * ri / 3, 0, Math.PI * 2); g.stroke(); }
                    const sw = t * 1.4;
                    const grd = g.createConicGradient ? null : null;
                    g.beginPath(); g.moveTo(cx2, cy2);
                    g.lineTo(cx2 + Math.cos(sw) * RR, cy2 + Math.sin(sw) * RR);
                    g.strokeStyle = col(R, cyc + 0.1, 0.95); g.lineWidth = 2; g.stroke();
                    if (f.beat) { g.fillStyle = col(R, cyc + 0.2, 0.9); g.fillRect(cx2 + (hash2(lastBeat * 91, 7, 1) - 0.5) * RR * 1.4, cy2 + (hash2(3, lastBeat * 57, 2) - 0.5) * RR * 1.4, 3, 3); }
                } else if (ov === 'galaxy') {
                    if (!stars) { stars = []; for (let i = 0; i < 110; i++) stars.push({ a: Math.random() * Math.PI * 2, sp: 0.3 + Math.random() * 0.8, rr: 0.1 + Math.random() * 0.42 }); }
                    for (const s of stars) {
                        s.a += 0.01 * s.sp * (0.4 + f.mid * 2);
                        const rr = s.rr * Math.min(W, H) * (1 + f.level * 0.25);
                        const px = W / 2 + Math.cos(s.a) * rr * 1.4, py = H / 2 + Math.sin(s.a) * rr * 0.8;
                        g.fillStyle = col(R, cyc + s.rr, 0.35 + f.treb * 0.65);
                        g.fillRect(px, py, 1.6, 1.6);
                    }
                } else if (ov === 'scribble') {
                    if (f.beat && walkers.length < 50) {
                        for (let n = 0; n < 4; n++) walkers.push({ x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H / 2 + (Math.random() - 0.5) * H * 0.3, dx: (Math.random() - 0.5) * 6, dy: (Math.random() - 0.5) * 6, life: 1, u: Math.random() });
                    }
                    for (let i = walkers.length - 1; i >= 0; i--) {
                        const wk = walkers[i];
                        wk.dx += (Math.random() - 0.5) * 2.4; wk.dy += (Math.random() - 0.5) * 2.4;
                        wk.dx *= 0.92; wk.dy *= 0.92;
                        const nx = wk.x + wk.dx, ny = wk.y + wk.dy;
                        g.strokeStyle = col(R, cyc + wk.u, 0.85); g.lineWidth = 1.4;
                        g.beginPath(); g.moveTo(wk.x, wk.y); g.lineTo(nx, ny); g.stroke();
                        wk.x = nx; wk.y = ny; wk.life -= 0.006;
                        if (wk.life <= 0 || wk.x < -20 || wk.x > W + 20 || wk.y < -20 || wk.y > H + 20) walkers.splice(i, 1);
                    }
                } else if (ov === 'gradborder') {
                    const inset = 7;
                    g.lineWidth = 9;
                    g.strokeStyle = col(R, cyc, 0.5);
                    g.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
                    g.lineWidth = 2;
                    g.strokeStyle = col(R, cyc + 0.12, 0.9);
                    g.strokeRect(inset + 6, inset + 6, W - inset * 2 - 12, H - inset * 2 - 12);
                } else if (ov === 'orb') {
                    const cx2 = W / 2, cy2 = H / 2;
                    const RR = Math.min(W, H) * (0.14 + f.level * 0.3);
                    const grd = g.createRadialGradient(cx2, cy2, 0, cx2, cy2, Math.max(2, RR));
                    grd.addColorStop(0, col(R, cyc, 0.95));
                    grd.addColorStop(0.55, col(R, cyc + 0.08, 0.45));
                    grd.addColorStop(1, 'rgba(0,0,0,0)');
                    g.fillStyle = grd;
                    g.fillRect(cx2 - RR * 1.4, cy2 - RR * 1.4, RR * 2.8, RR * 2.8);
                } else if (ov === 'web') {
                    const cx2 = W / 2, cy2 = H / 2, RR = Math.min(W, H) * 0.5;
                    const pull = f.beat ? 0.25 : 0.75;
                    g.strokeStyle = col(R, cyc, 0.8); g.lineWidth = 1.2;
                    for (let i = 0; i < 16; i++) {
                        const th = (i / 16) * Math.PI * 2 + t * 0.05;
                        g.beginPath(); g.moveTo(cx2, cy2);
                        g.lineTo(cx2 + Math.cos(th) * RR * pull, cy2 + Math.sin(th) * RR * pull);
                        g.stroke();
                    }
                    for (let ri = 0.17; ri < 1; ri += 0.17) {
                        g.beginPath();
                        for (let i = 0; i <= 24; i++) {
                            const th = (i / 24) * Math.PI * 2;
                            const rr = RR * ri * (pull + (f.wave[(i * 40) % 1024] - 128) / 128 * 0.16);
                            const px = cx2 + Math.cos(th) * rr, py = cy2 + Math.sin(th) * rr;
                            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
                        }
                        g.stroke();
                    }
                }
            }
        }

        const P_ = (name, shift, opts) => Object.assign({ name, shift }, opts);
        const PRESETS = [
            P_('randomization', 'zoom', { random: true }),
            P_('brightsphere', 'zoom', { decay: 0.962, amp: 0.5, post: ['circlewave', 'orb'], palette: ['#fff3c4', '#ffd166', '#ff9e2c', '#fff7db'], lock: true }),
            P_('dance of the freaky circles', 'ringspin', { decay: 0.95, amp: 0.55, p: { n: 8 }, post: ['circlewave'], palette: ['#19d3de', '#f424d0', '#7b1fa2'] }),
            P_('cominatcha', 'starburst', { decay: 0.93, amp: 0.7, p: { n: 9 }, post: ['spectrumedge'], palette: ['#ff2d2d', '#ff8c1a', '#ffe14d'] }),
            P_('dandelionaid', 'thingus', { decay: 0.972, amp: 0.45, post: ['scribble', 'galaxy'], palette: ['#d9f99d', '#a3e635', '#fef08a'] }),
            P_('drinkdeep', 'zoom', { decay: 0.97, amp: -0.35, post: ['circlewave', 'galaxy'], palette: ['#0b3d91', '#1163c9', '#27c3e0'], lock: true }),
            P_('eletriarnation', 'trig', { decay: 0.9, amp: 0.8, p: { f1: 0.16, f2: 0.14 }, post: ['edgetrace'], palette: ['#e8f4ff', '#41c9ff', '#2255ff'], lock: true }),
            P_('event horizon', 'stretch', { decay: 0.975, amp: 0.62, post: ['jdar'], palette: ['#12002b', '#5a189a', '#b100e8'], lock: true }),
            P_('hizodge', 'tile', { decay: 0.94, amp: 0.5, p: { B: 14 }, post: ['dotplane'], palette: ['#39ff14', '#baffc9', '#0f0'] }),
            P_('gemstonematrix', 'tile', { decay: 0.96, amp: 0.42, p: { B: 34 }, post: ['gradborder', 'circlewave'], palette: ['#00e5cc', '#7a5cff', '#ff4dd2', '#00b3a4'] }),
            P_('sepiaswirl', 'swirl', { decay: 0.968, amp: 0.55, post: ['gradborder'], palette: ['#704214', '#c9a227', '#efe0bb'], lock: true }),
            P_('illuminator', 'zoom', { decay: 0.955, amp: 0.3, post: ['orb', 'circlewave'], palette: ['#fffbe6', '#ffd700', '#ffae00'] }),
            P_('i see the truth', 'swirl', { decay: 0.972, amp: 0.3, post: ['jdar', 'circlewave'], palette: ['#001a00', '#00c853', '#b9ffdf'], lock: true }),
            P_('kaleidovision', 'ringspin', { decay: 0.965, amp: 0.5, p: { n: 12 }, post: ['spectrumedge'], palette: ['#ff004d', '#ffbe0b', '#3bf4a0', '#29b6ff', '#b24dff'] }),
            P_('chemicalnova', 'starburst', { decay: 0.92, amp: 0.75, p: { n: 5 }, post: ['scribble', 'orb'], palette: ['#b6ff00', '#ff00e6', '#00ffc8'] }),
            P_('lotus', 'ringspin', { decay: 0.977, amp: 0.35, p: { n: 6 }, post: ['circlewave', 'orb'], palette: ['#ffc2d1', '#ff87ab', '#ffdab9', '#fff0f3'] }),
            P_('green is not your enemy', 'shimmer', { decay: 0.94, amp: 0.6, post: ['spectrumedge', 'dotplane'], palette: ['#003b00', '#00c853', '#aaffaa'], lock: true }),
            P_('relatively calm', 'shimmer', { decay: 0.982, amp: 0.3, post: ['circlewave'], palette: ['#e8dcc8', '#cbb69a', '#efe7da'] }),
            P_('sleepyspray', 'thingus', { decay: 0.985, amp: 0.3, post: ['scribble', 'orb'], palette: ['#cdb4f9', '#9d6fe8', '#efe6ff'] }),
            P_('smoke or water?', 'twirlocity', { decay: 0.978, amp: 0.5, post: ['circlewave'], palette: ['#33566b', '#5f9ea8', '#bcd8de'] }),
            P_("spider's last moment...", 'thingus', { decay: 0.945, amp: 0.4, post: ['web', 'edgetrace'], palette: ['#8b0000', '#d43a3a', '#1a0000'], lock: true }),
            P_('strawberryaid', 'swirl', { decay: 0.96, amp: 0.45, post: ['circlewave'], palette: ['#ff5d8f', '#ff8fab', '#ffb3c6', '#fff0f3'] }),
            P_('the world', 'ringspin', { decay: 0.972, amp: 0.3, p: { n: 3 }, post: ['dotplane', 'circlewave'], palette: ['#0b7a4b', '#1e90d6', '#e8f4ea', '#d9b26a'] }),
            P_('my tornado is resting', 'twirlocity', { decay: 0.966, amp: 0.8, post: ['galaxy'], palette: ['#37474f', '#78909c', '#b0bec5', '#4dd0e1'] }),
            P_('back to the groove', 'trig', { decay: 0.93, amp: 0.7, p: { f1: 0.12, f2: 0.1 }, post: ['scribble', 'gradborder'], palette: ['#ff3ea5', '#ffd23f', '#3bf4a0', '#29b6ff'] }),
            P_('plasmatica', 'shimmer', { decay: 0.974, amp: 0.55, post: ['orb', 'galaxy'], palette: ['#ff6a00', '#ff006e', '#8338ec', '#ff9671'] }),
        ];

        function apply(idx) {
            if (!(idx >= 1 && idx < PRESETS.length)) {
                if (idx > 0) idx = Math.min(idx | 0, PRESETS.length - 1);
            }
            if (PRESETS[idx].random) idx = 1 + Math.floor(Math.random() * (PRESETS.length - 1));
            curIdx = idx; curCfg = PRESETS[idx];
            curCfg._fq = new Uint8Array(1024);
            ramps = makeRamp(curCfg.palette || ['#ffffff']);
            walkers = []; stars = null; spinVel = 0; beatEma = 0;
            if (fbCtx) { fbCtx.fillStyle = '#000'; fbCtx.fillRect(0, 0, fw, fh); }
            try { localStorage.setItem('np-battery-preset', String(idx)); } catch (e) {}
            return curIdx;
        }

        return {
            get presets() { return PRESETS; },
            current() { return curIdx; },
            currentName() { return curCfg ? curCfg.name : ''; },

            presetCount() { return Math.max(0, PRESETS.length - 1); },
            setPreset(i) { return apply(i | 0); },
            cycle(dir) { return apply((curIdx + (dir || 1) - 1) % (PRESETS.length - 1) + 1); },
            draw(ctx, W, H, lvl) {
                ensureBuffers(W, H);
                if (!curCfg) {
                    let saved = 0;
                    try { saved = parseInt(localStorage.getItem('np-battery-preset') || '0', 10) || 0; } catch (e) {}
                    apply(saved >= 0 && saved < PRESETS.length ? saved : 0);
                }
                const dt = 1 / 60; t += dt;
                const f = feats(lvl);
                if (curCfg._fq && lvl.freqL) curCfg._fq.set(lvl.freqL.subarray(0, 1024));
                spinVel += (f.level * 0.09 - spinVel * 0.04);
                renderFrame(f, dt);
                drawOverlays(f);
                imgA = fbCtx.getImageData(0, 0, fw, fh);
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(fbCanvas, 0, 0, W, H);
            },
        };
    })();

    // ==================================================================
    // AMBIENCE — homage to WMP's classic Ambience family (Battery's
    // sister). Soft glowing line-work over persistent trails; hues fade
    // through the documented color cycle. Documented behaviors kept:
    // white flash on loud parts (Swirl/Water/Windmill/Niagara/X/Thingus),
    // left-drift flipping right at high volume (Anon/Dizzy/Blender/X),
    // Down-the-Drain's two lines swapping positions.
    // ==================================================================
    const AmbienceViz = (() => {
        let fw = 320, fh = 180;
        let fbCanvas = null, fbCtx = null;
        let t = 0, beatEma = 0, lastBeat = -1;
        let curIdx = 0, curCfg = null, ramp = null;
        let streaks = null, bubbles = [], drops = [], peaks = null;

        function hex(h) {
            return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
        }
        function makeRamp(cols) {
            const rgb = cols.map(hex);
            return (u) => {
                u = u - Math.floor(u);
                const n = rgb.length;
                const p = u * n, i = Math.floor(p) % n, j = (i + 1) % n, fr = p - Math.floor(p);
                const a = rgb[i], b = rgb[j];
                return [a[0] + (b[0] - a[0]) * fr, a[1] + (b[1] - a[1]) * fr, a[2] + (b[2] - a[2]) * fr];
            };
        }
        function colr(u, alpha) {
            const c = ramp(u);
            return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + alpha + ')';
        }

        // Master hue cycle per the wiki's documented color progression
        const HUES = ['#8fd3ef', '#ff453a', '#ff9f0a', '#ffd60a', '#32d74b', '#3ddad7', '#64d2ff', '#0a84ff', '#ff2d92', '#ffa5cd', '#bf5af2', '#ffd0a6', '#aeb0b8'];
        const TAU = Math.PI * 2;

        function feats(lvl) {
            const fq = lvl.freqL, wv = lvl.waveL;
            let bass = 0, mid = 0, treb = 0;
            for (let i = 2; i < 26; i++) bass += fq[i];
            for (let i = 26; i < 170; i++) mid += fq[i];
            for (let i = 170; i < 500; i++) treb += fq[i];
            bass /= 24 * 255; mid /= 144 * 255; treb /= 330 * 255;
            if (!lvl.playing) { bass *= 0.15; mid *= 0.15; treb *= 0.15; }
            beatEma += (bass - beatEma) * 0.06;
            const beat = lvl.playing && bass > 0.28 && bass > beatEma * 1.32 && (t - lastBeat) > 0.14;
            if (beat) lastBeat = t;
            return { bass, mid, treb, level: Math.min(1, bass * 1.3 + mid * 0.8 + treb * 0.5), wave: wv, beat };
        }

        function ensureBuffers(w, h) {
            const nh = Math.max(120, Math.min(260, Math.round(fw * h / Math.max(1, w))));
            if (!fbCanvas || fh !== nh) {
                fh = nh;
                fbCanvas = document.createElement('canvas');
                fbCanvas.width = fw; fbCanvas.height = fh;
                fbCtx = fbCanvas.getContext('2d');
                fbCtx.fillStyle = '#000'; fbCtx.fillRect(0, 0, fw, fh);
            }
        }

        // Smoothed drift: -1 flows left, flips right while music is loud
        let flowX = -1;

        function drawSwirl(g, f, W, H, cx, cy, M, cyc) {
            for (let k = 0; k < 3; k++) {
                const base = t * (0.45 + f.bass * 1.1) + (k * TAU) / 3;
                g.beginPath();
                for (let i = 0; i <= 64; i++) {
                    const u = i / 64;
                    const ang = base + u * 4.4;
                    const rr = u * M * (0.44 + 0.14 * f.level);
                    const px = cx + Math.cos(ang) * rr * 1.3, py = cy + Math.sin(ang) * rr * 0.92;
                    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
                }
                g.strokeStyle = colr(cyc + k * 0.09, 0.7);
                g.lineWidth = 2;
                g.stroke();
            }
        }

        function drawWarp(g, f, W, H, cx, cy, M, cyc) {
            if (!streaks) { streaks = []; for (let i = 0; i < 70; i++) streaks.push({ a: Math.random() * TAU, r: Math.random() * M * 0.5, sp: 0.4 + Math.random() }); }
            const maxR = Math.sqrt(cx * cx + cy * cy);
            for (const s of streaks) {
                s.r += s.sp * (0.6 + f.mid * 2.4) * M * 0.014;
                if (s.r > maxR) { s.r = Math.random() * M * 0.12; s.a = Math.random() * TAU; }
                const len = M * (0.03 + f.treb * 0.13) * (s.r / maxR);
                g.strokeStyle = colr(cyc + s.a / TAU, 0.75);
                g.lineWidth = 1.5;
                g.beginPath();
                g.moveTo(cx + Math.cos(s.a) * s.r, cy + Math.sin(s.a) * s.r * 0.9);
                g.lineTo(cx + Math.cos(s.a) * (s.r + len), cy + Math.sin(s.a) * (s.r + len) * 0.9);
                g.stroke();
            }
        }

        function drawAnon(g, f, W, H, cx, cy, M, cyc) {
            for (let L = 0; L < 3; L++) {
                const yBase = H * (0.28 + L * 0.22);
                g.beginPath();
                for (let x = 0; x <= W; x += 4) {
                    const amp = M * 0.07 * (0.5 + f.mid * 1.4) * (1 - Math.abs(x / W - 0.5));
                    const yy = yBase + Math.sin(x * 0.05 + flowX * t * (1.6 + f.level * 2) + L * 2.1) * amp;
                    if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
                }
                g.strokeStyle = colr(cyc + L * 0.12, 0.72);
                g.lineWidth = 1.8;
                g.stroke();
            }
        }

        function ensurePeaks(n) {
            if (!peaks || peaks.length !== n) { peaks = new Float32Array(n); }
            return peaks;
        }
        function drawFalloff(g, f, W, H, cx, cy, M, cyc) {
            const cols = 40;
            const pk = ensurePeaks(cols);
            for (let i = 0; i < cols; i++) {
                const band = Math.floor((i / cols) * 300) + 2;
                const v = curCfg._fq ? curCfg._fq[band] / 255 : 0;
                pk[i] = Math.max(v, pk[i] * 0.93);
                const bw = W / cols;
                const hh = pk[i] * H * 0.55;
                g.fillStyle = colr(cyc + i / cols * 0.25, 0.55);
                g.fillRect(i * bw + 1, H - hh - 4, bw - 2, hh);
                g.fillStyle = colr(cyc + i / cols * 0.25 + 0.05, 0.95);
                g.fillRect(i * bw + 1, H - hh - 6, bw - 2, 2.5);
            }
        }

        function drawWater(g, f, W, H, cx, cy, M, cyc) {
            for (let L = 0; L < 5; L++) {
                const yBase = H * (0.42 + L * 0.115);
                g.beginPath();
                for (let x = 0; x <= W; x += 3) {
                    const amp = M * (0.02 + L * 0.012) * (0.7 + f.bass * 1.8);
                    const yy = yBase + Math.sin(x * 0.055 + t * (1.1 + L * 0.35)) * amp + Math.sin(x * 0.021 - t * 0.7) * amp * 0.6;
                    if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
                }
                g.strokeStyle = colr(cyc + L * 0.07, 0.45 + L * 0.1);
                g.lineWidth = 1.6;
                g.stroke();
            }
        }

        function drawBubble(g, f, W, H, cx, cy, M, cyc) {
            if ((f.beat || Math.random() < 0.04 + f.level * 0.08) && bubbles.length < 42) {
                bubbles.push({ x: W * 0.1 + Math.random() * W * 0.8, y: H + 8, r: 2.5 + Math.random() * 7, wob: Math.random() * TAU });
            }
            for (let i = bubbles.length - 1; i >= 0; i--) {
                const b = bubbles[i];
                b.y -= (0.35 + b.r / M) * (0.7 + f.level * 1.3);
                b.x += Math.sin(t * 2.4 + b.wob) * 0.35;
                if (b.y < -10) { bubbles.splice(i, 1); continue; }
                g.strokeStyle = colr(cyc + b.y / H, 0.7);
                g.lineWidth = 1.4;
                g.beginPath();
                g.arc(b.x, b.y, b.r * (1 + f.bass * 0.2), 0, TAU);
                g.stroke();
                g.beginPath();
                g.arc(b.x - b.r * 0.32, b.y - b.r * 0.32, b.r * 0.28, 0, TAU);
                g.strokeStyle = 'rgba(255,255,255,0.5)';
                g.stroke();
            }
        }

        function drawDizzy(g, f, W, H, cx, cy, M, cyc) {
            const ccx = cx + flowX * W * 0.16 + Math.sin(t * 0.6) * W * 0.05;
            const ccy = cy + Math.cos(t * 0.83) * H * 0.08;
            for (let k = 0; k < 22; k++) {
                const om = 0.5 + ((k * 37) % 11) / 11 * 2.2;
                const ang = t * om * (k % 2 ? 1 : -1) * (1 + f.mid * 1.6) + k;
                const rr = M * (0.08 + ((k * 53) % 17) / 17 * 0.34) * (1 + f.bass * 0.3);
                const px = ccx + Math.cos(ang) * rr, py = ccy + Math.sin(ang) * rr * 0.85;
                g.fillStyle = colr(cyc + k / 22, 0.85);
                g.beginPath();
                g.arc(px, py, 1.6 + f.treb * 2.2, 0, TAU);
                g.fill();
            }
        }

        function drawWindmill(g, f, W, H, cx, cy, M, cyc) {
            const R = M * 0.42;
            for (let v = 0; v < 4; v++) {
                const base = t * (0.55 + f.bass * 0.9) + v * (TAU / 4);
                g.beginPath();
                g.moveTo(cx, cy);
                g.quadraticCurveTo(
                    cx + Math.cos(base - 0.5) * R * 0.6, cy + Math.sin(base - 0.5) * R * 0.6,
                    cx + Math.cos(base) * R * (1 + f.wave[(v * 200) % 1024] / 128 * 0.12), cy + Math.sin(base) * R
                );
                g.strokeStyle = colr(cyc + v * 0.1, 0.78);
                g.lineWidth = 2.4;
                g.stroke();
            }
            g.fillStyle = colr(cyc + 0.5, 0.9);
            g.beginPath(); g.arc(cx, cy, 3 + f.bass * 5, 0, TAU); g.fill();
        }

        function drawNiagara(g, f, W, H, cx, cy, M, cyc) {
            const want = Math.min(90, 30 + Math.round(f.treb * 70));
            while (drops.length < want) drops.push({ x: Math.random() * W, y: -Math.random() * H, v: 1.5 + Math.random() * 2.5 });
            while (drops.length > want) drops.pop();
            for (const d of drops) {
                d.y += d.v * (1 + f.level * 1.6);
                if (d.y > H) { d.y = -6; d.x = Math.random() * W; }
                g.strokeStyle = colr(cyc + d.x / W * 0.2, 0.65);
                g.lineWidth = 1.3;
                g.beginPath();
                g.moveTo(d.x, d.y);
                g.lineTo(d.x, d.y + 4 + d.v * 2.2);
                g.stroke();
            }
            g.strokeStyle = colr(cyc + 0.4, 0.5);
            g.lineWidth = 1;
            g.beginPath();
            for (let x = 0; x <= W; x += 8) {
                const yy = H - 5 - Math.abs(Math.sin(x * 0.09 + t * 2)) * f.bass * 8;
                if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
            }
            g.stroke();
        }

        function drawBlender(g, f, W, H, cx, cy, M, cyc) {
            const ox = flowX * W * 0.1;
            for (let e = 0; e < 2; e++) {
                const dir = e ? -1 : 1;
                g.beginPath();
                for (let i = 0; i <= 60; i++) {
                    const th = (i / 60) * TAU;
                    const rr = M * (0.2 + 0.1 * Math.sin(th * 3 + t * dir * 2));
                    const px = cx + ox + Math.cos(th + t * dir * (1 + f.bass)) * rr * 1.35;
                    const py = cy + Math.sin(th + t * dir * (1 + f.bass)) * rr;
                    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
                }
                g.strokeStyle = colr(cyc + e * 0.35, 0.7);
                g.lineWidth = 1.8;
                g.stroke();
            }
        }

        function drawXmarks(g, f, W, H, cx, cy, M, cyc) {
            const diag = [[0, 0, W, H], [W, 0, 0, H]];
            for (let d = 0; d < 2; d++) {
                const [x1, y1, x2, y2] = diag[d];
                g.setLineDash([10, 8]);
                g.lineDashOffset = flowX * t * 60 * (d ? -1 : 1);
                g.strokeStyle = colr(cyc + d * 0.2, 0.85);
                g.lineWidth = 3;
                g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
                g.lineDashOffset = flowX * t * 60 * (d ? -1 : 1) + 9;
                g.strokeStyle = colr(cyc + d * 0.2 + 0.1, 0.4);
                g.lineWidth = 7;
                g.stroke();
            }
            g.setLineDash([]);
        }

        function drawDrain(g, f, W, H, cx, cy, M, cyc) {
            // two arms spiral inward; swap angular positions while loud
            const swap = f.level > 0.6 ? 1 : 0;
            drawDrain.s = (drawDrain.s || 0) + (swap - (drawDrain.s || 0)) * 0.06;
            for (let s = 0; s < 2; s++) {
                const off = s * Math.PI + drawDrain.s * Math.PI;
                g.beginPath();
                for (let i = 0; i <= 70; i++) {
                    const u = 1 - i / 70;
                    const ang = t * (1.3 + f.bass * 1.4) + off + u * 5.2;
                    const rr = u * M * 0.52;
                    const px = cx + Math.cos(ang) * rr * 1.25, py = cy + Math.sin(ang) * rr;
                    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
                }
                g.strokeStyle = colr(cyc + s * 0.3, 0.8);
                g.lineWidth = 2;
                g.stroke();
            }
        }

        function drawThingus(g, f, W, H, cx, cy, M, cyc) {
            const cols = 26, rows = Math.round(cols * H / W);
            for (let iy = 0; iy < rows; iy++) {
                for (let ix = 0; ix < cols; ix++) {
                    const band = Math.floor(((ix + iy) % cols) / cols * 240) + 2;
                    const en = curCfg._fq ? curCfg._fq[band] / 255 : 0;
                    const tw = Math.sin(t * 3 + ix * 1.7 + iy * 2.3) * 0.5 + 0.5;
                    const br = en * 0.8 + tw * 0.2;
                    if (br < 0.08) continue;
                    g.fillStyle = colr(cyc + (ix / cols) * 0.4, Math.min(1, br));
                    const sz = 1 + br * 2.6;
                    g.fillRect(ix * (W / cols) + (W / cols) / 2 - sz / 2, iy * (H / rows) + (H / rows) / 2 - sz / 2, sz, sz);
                }
            }
        }

        const A_ = (name, mode, opts) => Object.assign({ name, mode }, opts);
        const PRESETS = [
            A_('randomization', 'swirl', { random: true }),
            A_('Swirl', 'swirl', { fade: 0.10, hueOff: 0.00, flash: true }),
            A_('Warp', 'warp', { fade: 0.16 }),
            A_('Anon', 'anon', { fade: 0.12, flow: true, hueOff: 0.15 }),
            A_('Falloff', 'falloff', { fade: 0.20 }),
            A_('Water', 'water', { fade: 0.09, flash: true, hueOff: 0.42, hueSpd: 0.6 }),
            A_('Bubble', 'bubble', { fade: 0.13 }),
            A_('Dizzy', 'dizzy', { fade: 0.14, flow: true }),
            A_('Windmill', 'windmill', { fade: 0.12, flash: true }),
            A_('Niagara', 'niagara', { fade: 0.18, flash: true }),
            A_('Blender', 'blender', { fade: 0.12, flow: true }),
            A_('X Marks the Spot', 'xmarks', { fade: 0.15, flow: true, flash: true }),
            A_('Down the Drain', 'drain', { fade: 0.10, hueOff: 0.55 }),
            A_('Thingus', 'thingus', { fade: 0.22, flash: true }),
        ];

        const MODES = { swirl: drawSwirl, warp: drawWarp, anon: drawAnon, falloff: drawFalloff, water: drawWater, bubble: drawBubble, dizzy: drawDizzy, windmill: drawWindmill, niagara: drawNiagara, blender: drawBlender, xmarks: drawXmarks, drain: drawDrain, thingus: drawThingus };

        function apply(idx) {
            if (!(idx >= 1 && idx < PRESETS.length)) {
                if (idx > 0) idx = Math.min(idx | 0, PRESETS.length - 1);
            }
            if (PRESETS[idx].random) idx = 1 + Math.floor(Math.random() * (PRESETS.length - 1));
            curIdx = idx; curCfg = PRESETS[idx];
            curCfg._fq = new Uint8Array(1024);
            ramp = makeRamp(HUES);
            streaks = null; bubbles = []; drops = []; peaks = null;
            if (fbCtx) { fbCtx.fillStyle = '#000'; fbCtx.fillRect(0, 0, fw, fh); }
            try { localStorage.setItem('np-ambience-preset', String(idx)); } catch (e) {}
            return curIdx;
        }

        return {
            get presets() { return PRESETS; },
            current() { return curIdx; },
            currentName() { return curCfg ? curCfg.name : ''; },
            presetCount() { return Math.max(0, PRESETS.length - 1); },
            setPreset(i) { return apply(i | 0); },
            cycle(dir) { return apply((curIdx + (dir || 1) - 1) % (PRESETS.length - 1) + 1); },
            draw(ctx, W, H, lvl) {
                ensureBuffers(W, H);
                if (!curCfg) {
                    let saved = 0;
                    try { saved = parseInt(localStorage.getItem('np-ambience-preset') || '0', 10) || 0; } catch (e) {}
                    apply(saved >= 0 && saved < PRESETS.length ? saved : 0);
                }
                t += 1 / 60;
                const f = feats(lvl);
                if (curCfg._fq && lvl.freqL) curCfg._fq.set(lvl.freqL.subarray(0, 1024));
                const target = f.level > 0.6 ? 1 : -1;
                flowX += (target - flowX) * 0.02;

                const g = fbCtx;
                g.globalCompositeOperation = 'source-over';
                g.shadowBlur = 0;
                g.fillStyle = 'rgba(0,0,0,' + (curCfg.fade != null ? curCfg.fade : 0.13) + ')';
                g.fillRect(0, 0, fw, fh);
                g.globalCompositeOperation = 'lighter';

                const cyc = t * 0.016 * (curCfg.hueSpd || 1) + (curCfg.hueOff || 0);
                const fn = MODES[curCfg.mode];
                if (fn) fn(g, f, fw, fh, fw / 2, fh / 2, Math.min(fw, fh), cyc);

                if (curCfg.flash && f.level > 0.58) {
                    const wf = Math.min(0.75, (f.level - 0.58) * 2.4);
                    g.globalCompositeOperation = 'source-over';
                    g.fillStyle = 'rgba(255,255,255,' + wf + ')';
                    g.fillRect(0, 0, fw, fh);
                }

                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(fbCanvas, 0, 0, W, H);
            },
        };
    })();

    // ==================================================================
    // BUILT-IN FALLBACK VISUALIZERS
    // ==================================================================
    const BuiltIns = [
        {
            id: 'neon-bars', name: 'Neon Bars',
            phase: 0,
            draw(ctx, w, h, lvl) {
                this.phase += 0.02;
                ctx.clearRect(0, 0, w, h);
                const bars = 56, gap = 2;
                const bw = (w - gap * (bars - 1)) / bars;
                for (let i = 0; i < bars; i++) {
                    const idx = Math.floor((i / bars) * lvl.freqL.length * 0.85);
                    const v = lvl.freqL[idx] / 255;
                    const bh = Math.max(3, v * h * 0.9);
                    const x = i * (bw + gap);
                    const grad = ctx.createLinearGradient(0, h - bh, 0, h);
                    grad.addColorStop(0, 'rgba(244,36,208,0.95)');
                    grad.addColorStop(1, 'rgba(123,31,162,0.55)');
                    ctx.fillStyle = grad;
                    ctx.shadowColor = 'rgba(244,36,208,0.6)';
                    ctx.shadowBlur = 12;
                    ctx.fillRect(x, h - bh, bw, bh);
                }
                ctx.shadowBlur = 0;
            },
        },
        {
            id: 'waveform', name: 'Waveform',
            phase: 0,
            draw(ctx, w, h, lvl) {
                ctx.clearRect(0, 0, w, h);
                const mid = h / 2;
                for (let pass = 0; pass < 2; pass++) {
                    ctx.beginPath();
                    const data = pass === 0 ? lvl.waveL : lvl.waveR;
                    for (let x = 0; x < w; x++) {
                        const v = (data[Math.floor((x / w) * data.length)] - 128) / 128;
                        const y = mid + v * h * 0.38 * (pass ? -1 : 1);
                        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    }
                    ctx.strokeStyle = pass === 0 ? 'rgba(244,36,208,0.9)' : 'rgba(26,214,222,0.75)';
                    ctx.lineWidth = 3;
                    ctx.shadowColor = pass === 0 ? 'rgba(244,36,208,0.7)' : 'rgba(26,214,222,0.6)';
                    ctx.shadowBlur = 14;
                    ctx.stroke();
                }
                ctx.shadowBlur = 0;
            },
        },
        {
            // Faithful rebuild of WMP's classic Battery family (see BatteryViz
            // above) — feedback pipeline, shift units, overlay drawers, presets.
            id: 'battery', name: 'Battery', engine: BatteryViz,
            draw(ctx, w, h, lvl) { BatteryViz.draw(ctx, w, h, lvl); },
        },
        {
            // Homage to WMP's classic Ambience family (Battery's sister) —
            // see AmbienceViz above. 13 presets + randomization slot.
            id: 'ambience', name: 'Ambience', engine: AmbienceViz,
            draw(ctx, w, h, lvl) { AmbienceViz.draw(ctx, w, h, lvl); },
        },
    ];

    // ==================================================================
    // NOW PLAYING SYSTEM
    // ==================================================================
    const NPViz = {
        applet: null, els: {},
        audioCtx: null, analyserL: null, analyserR: null,
        freqL: new Uint8Array(1024), freqR: new Uint8Array(1024),
        waveL: new Uint8Array(1024), waveR: new Uint8Array(1024),
        active: null,           // {type:'wmp'|'builtin', id, inst?, builtin?}
        surface: null, levels: null,
        rafId: null, wantDefault: false,
        idleTimer: null, idleOn: false, popupOpen: false,
        gridVisible: true,
        gradToggle: false, lastColors: null,

        init(musicApplet) {
            this.applet = musicApplet;
            const ids = ['np-grad-a', 'np-grad-b', 'np-viz-canvas', 'np-dot-grid',
                'np-title-top', 'np-viz-name-pill', 'np-card', 'np-card-tint',
                'np-viz-btn-wrap', 'np-viz-tooltip', 'np-viz-backdrop', 'np-viz-popup', 'np-viz-grid'];
            for (const id of ids) this.els[id] = document.getElementById(id);
            this.view = document.getElementById('now-playing-view');
            this.canvas = this.els['np-viz-canvas'];
            if (!this.view || !this.canvas) { NPLog.error('now playing DOM missing'); return; }
            try { this.ctx = this.canvas.getContext('2d'); } catch (e) { NPLog.error('canvas ctx: ' + e.message); }
            this.imageData = null;

            try { WmpHost.init(); } catch (e) { NPLog.error('wmp host init: ' + e.message); }

            const steps = [
                ['popup', () => this.wirePopup()],
                ['idle', () => this.wireIdle()],
                ['keys', () => this.wireKeys()],
                ['tip', () => this.wirePresetTip()],
                ['pillcycle', () => {
                    const pill = this.els['np-viz-name-pill'];
                    if (!pill) return;
                    pill.style.cursor = 'pointer';
                    pill.title = 'click: next preset';
                    pill.addEventListener('click', () => {
                        const eng = this.multiPresetEngine();
                        if (!eng) return;
                        try { AudioManager.playMusicClickUI(); } catch (e) {}
                        eng.cycle(1);
                        this.updateMultiNamePill();
                    });
                }],
            ];
            for (const [nm, fn] of steps) {
                try { fn(); } catch (e) { NPLog.error(nm + ' wiring failed: ' + e.message); }
            }
            window.addEventListener('resize', () => this.fitSurface());
            try { this.applyGradient(null); } catch (e) { NPLog.error('initial gradient: ' + e.message); }
        },

        // ---------------- Audio graph ----------------
        ensureAudio() {
            if (this.audioCtx) { if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {}); return; }
            try {
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const src = this.audioCtx.createMediaElementSource(this.applet.audioPlayer);
                const splitter = this.audioCtx.createChannelSplitter(2);
                this.analyserL = this.audioCtx.createAnalyser();
                this.analyserR = this.audioCtx.createAnalyser();
                for (const a of [this.analyserL, this.analyserR]) { a.fftSize = 2048; a.smoothingTimeConstant = 0.72; }
                src.connect(splitter);
                splitter.connect(this.analyserL, 0);
                splitter.connect(this.analyserR, 1);
                src.connect(this.audioCtx.destination);
            } catch (e) { NPLog.error('audio graph failed: ' + e.message); }
        },

        readLevels(state) {
            try {
                this.analyserL.getByteFrequencyData(this.freqL);
                this.analyserR.getByteFrequencyData(this.freqR);
                this.analyserL.getByteTimeDomainData(this.waveL);
                this.analyserR.getByteTimeDomainData(this.waveR);
            } catch (e) {}
        },

        // ---------------- Gradient + album colors ----------------
        async extractColors(coverPath) {
            const fallback = ['#ff5fb2', '#c026d3', '#3d1454'];
            if (!coverPath) return fallback;
            try {
                const fs = require('fs');
                const b64 = fs.readFileSync(coverPath).toString('base64');
                const dot = coverPath.lastIndexOf('.');
                const ext = dot >= 0 ? coverPath.slice(dot + 1).toLowerCase() : 'jpg';
                const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
                const url = 'data:' + mime + ';base64,' + b64;
                const img = await new Promise((res, rej) => {
                    const im = new Image();
                    im.onload = () => res(im); im.onerror = rej; im.src = url;
                });
                const N = 24;
                const c = document.createElement('canvas'); c.width = N; c.height = N;
                const cx = c.getContext('2d', { willReadFrequently: true });
                cx.drawImage(img, 0, 0, N, N);
                const d = cx.getImageData(0, 0, N, N).data;
                const px = [];
                for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
                const sat = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
                const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
                const scored = px.map(p => ({ p, s: sat(p) * 1.4 + (lum(p) / 255) })).sort((a, b) => b.s - a.s);
                const mix = arr => {
                    if (!arr.length) return null;
                    const r = Math.round(arr.reduce((t, o) => t + o.p[0], 0) / arr.length);
                    const g = Math.round(arr.reduce((t, o) => t + o.p[1], 0) / arr.length);
                    const b = Math.round(arr.reduce((t, o) => t + o.p[2], 0) / arr.length);
                    return [r, g, b];
                };
                const c1 = mix(scored.slice(0, Math.max(4, Math.floor(px.length * 0.06)))) || [244, 36, 208];
                const midStart = Math.floor(scored.length * 0.35);
                const c2 = mix(scored.slice(midStart, midStart + Math.max(4, Math.floor(px.length * 0.15)))) || [192, 38, 211];
                const c3Raw = mix(scored.slice(Math.floor(scored.length * 0.82))) || [61, 20, 84];
                const c3 = c3Raw.map(v => Math.round(v * 0.45));
                const hex = a => '#' + a.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
                return [hex(c1), hex(c2), hex(c3)];
            } catch (e) { return fallback; }
        },

        cssCol(hex, a) {
            const n = parseInt(hex.slice(1), 16);
            return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
        },

        vivid(hexStr, sMin, lMin, lMax) {
            try {
                const n = parseInt(hexStr.slice(1), 16);
                const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
                const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                let l = (mx + mn) / 2; const d = mx - mn;
                let h = 0, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
                if (d) {
                    if (mx === r) h = ((g - b) / d) % 6;
                    else if (mx === g) h = (b - r) / d + 2;
                    else h = (r - g) / d + 4;
                    h *= 60; if (h < 0) h += 360;
                }
                s = Math.max(s, sMin);
                l = Math.min(lMax, Math.max(lMin, l));
                const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
                let rr, gg, bb;
                if (h < 60) { rr = c; gg = x; bb = 0; } else if (h < 120) { rr = x; gg = c; bb = 0; } else if (h < 180) { rr = 0; gg = c; bb = x; } else if (h < 240) { rr = 0; gg = x; bb = c; } else if (h < 300) { rr = x; gg = 0; bb = c; } else { rr = c; gg = 0; bb = x; }
                return '#' + [rr, gg, bb].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
            } catch (e) { return hexStr; }
        },

        async applyGradient(colors) {
            const cols = Array.isArray(colors) ? colors : ['#ff5fb2', '#c026d3', '#3d1454'];
            this.lastColors = cols;
            const grad = 'radial-gradient(120% 130% at 28% 18%, ' + cols[0] + ' 0%, ' + cols[1] + ' 42%, ' + cols[2] + ' 100%)';
            const aEl = this.els['np-grad-a'], bEl = this.els['np-grad-b'];
            const back = this.gradToggle ? aEl : bEl;
            const front = this.gradToggle ? bEl : aEl;
            back.style.backgroundImage = grad;
            back.style.opacity = '1';
            front.style.opacity = '0';
            this.gradToggle = !this.gradToggle;
            // Card glass tint follows album art
            const tint = this.els['np-card-tint'];
            if (tint) tint.style.backgroundColor = this.cssCol(cols[0], 0.16);
            // Seek bar + controls inherit album colors (vividness-normalized)
            const npView = document.getElementById('now-playing-view');
            if (npView) {
                npView.style.setProperty('--np-accent', this.vivid(cols[0], 0.55, 0.45, 0.62));
                npView.style.setProperty('--np-accent-2', this.vivid(cols[1], 0.5, 0.38, 0.55));
                npView.style.setProperty('--np-accent-glow', this.cssCol(cols[0], 0.45));
            }
        },

        async onTrack(track) {
            const colors = await this.extractColors(track.cover);
            await this.applyGradient(colors);
        },

        // ---------------- Surface / render loop ----------------
        fitSurface() {
            if (!this.active) return;
            const aspect = window.innerWidth / Math.max(1, window.innerHeight);
            const H = 288;
            const W = Math.max(320, Math.min(720, Math.round(H * aspect)));
            if (this.surface && this.surface.width === W && this.surface.height === H) return;
            if (this.active.type !== 'wmp') { this.sizeCanvas(W, H); return; }
            try {
                const old = this.surface;
                this.surface = WmpHost.surface(W, H);
                if (old) old.destroy();
                this.sizeCanvas(W, H);
                this.imageData = this.ctx.createImageData(W, H);
            } catch (e) { NPLog.error('surface resize failed: ' + e.message); }
        },

        sizeCanvas(w, h) {
            this.canvas.width = w; this.canvas.height = h;
            this.imageData = this.ctx.createImageData(w, h);
        },

        startLoop() {
            if (this.rafId) return;
            const tick = () => {
                this.rafId = requestAnimationFrame(tick);
                if (!this.active) return;
                if (!this.view.classList.contains('active-view')) return;
                this.ensureAudio();
                this.readLevels();
                const playing = this.applet.audioPlayer && !this.applet.audioPlayer.paused;
                if (this.active.type === 'builtin') {
                    const item = this.active.builtin;
                    item.draw(this.ctx, this.canvas.width, this.canvas.height,
                        { freqL: this.freqL, freqR: this.freqR, waveL: this.waveL, waveR: this.waveR, playing });
                    return;
                }
                if (this.active.type === 'wmp' && this.surface && this.levels) {
                    try {
                        const lv = this.levels;
                        lv.set(this.freqL, 0);
                        lv.set(this.freqR, 1024);
                        lv.set(this.waveL, 2048);
                        lv.set(this.waveR, 3072);
                        lv.writeInt32LE(playing ? 2 : (this.applet.audioPlayer && this.applet.audioPlayer.currentTime > 0 ? 1 : 0), 4096);
                        lv.writeBigInt64LE(BigInt(Date.now()), 4104);
                        const inst = this.active.inst;
                        const hr = inst.Render(inst.obj, lv, this.surface.dc, this.surface.rect);
                        if (hr !== 0 && hr !== 1) { /* tolerate non-fatal codes */ }
                        const pix = this.surface.grab();
                        const data = this.imageData.data;
                        for (let i = 0; i < data.length; i += 4) {
                            data[i] = pix[i + 2];
                            data[i + 1] = pix[i + 1];
                            data[i + 2] = pix[i];
                            data[i + 3] = 255;
                        }
                        this.ctx.putImageData(this.imageData, 0, 0);
                    } catch (e) {
                        NPLog.error('render frame failed: ' + e.message);
                        this.deactivate(true);
                    }
                }
            };
            this.rafId = requestAnimationFrame(tick);
        },

        stopLoop() { if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; } },

        // ---------------- Activate / deactivate ----------------
        entries() {
            const list = [];
            if (WmpHost.ready) {
                for (const fam of WmpHost.families) {
                    try { WmpHost.probe(fam); list.push({ type: 'wmp', id: fam.id, name: fam.name }); }
                    catch (e) { NPLog.info('family unavailable: ' + fam.id + ' (' + e.message + ')'); }
                }
            }
            for (const b of BuiltIns) list.push({ type: 'builtin', id: b.id, name: b.name });
            return list;
        },

        async select(entryId) {
            if (entryId === 'none') { this.deactivate(); return; }
            const wmpFam = WmpHost.ready && WmpHost.families.find(f => f.id === entryId);
            try {
                if (wmpFam) {
                    const prev = this.active;
                    this.active = null;
                    if (prev && prev.type === 'wmp') WmpHost.deactivate(prev.inst);
                    const inst = WmpHost.activate(wmpFam);
                    this.levels = WmpHost.levelsBuffer();
                    this.surface = null; // rebuilt by fitSurface
                    this.active = { type: 'wmp', id: wmpFam.id, name: wmpFam.name, inst };
                    this.setVizVisualState(true);
                    this.fitSurface();
                    this.startLoop();
                } else {
                    const builtin = BuiltIns.find(b => b.id === entryId);
                    if (!builtin) return;
                    const prev = this.active;
                    this.active = null;
                    if (prev && prev.type === 'wmp') WmpHost.deactivate(prev.inst);
                    if (this.surface) { try { this.surface.destroy(); } catch (e) {} this.surface = null; }
                    this.active = { type: 'builtin', id: builtin.id, name: builtin.name, builtin };
                    this.setVizVisualState(true);
                    this.sizeCanvas(480, Math.round(480 * window.innerHeight / Math.max(1, window.innerWidth)));
                    this.startLoop();
                }
                this.setNamePill(this.active.name);
                if (this.multiPresetEngine()) {
                    this.updateMultiNamePill();
                    this.maybeShowPresetTip();
                }
            } catch (e) {
                NPLog.error('activate ' + entryId + ' failed: ' + e.message);
                this.deactivate();
            }
        },

        deactivate() {
            const prev = this.active;
            this.active = null;
            if (prev && prev.type === 'wmp') WmpHost.deactivate(prev.inst);
            if (this.surface) { try { this.surface.destroy(); } catch (e) {} this.surface = null; }
            this.stopLoop();
            this.setVizVisualState(false);
            this.setNamePill(null);
            this.applyGradient(this.lastColors);
        },

        setVizVisualState(on) {
            this.view.classList.toggle('viz-active', !!on);
            this.canvas.style.display = on ? 'block' : 'none';
        },

        setNamePill(name) {
            const pill = this.els['np-viz-name-pill'];
            if (!pill) return;
            if (name) {
                let t = pill.querySelector('.np-pill-text');
                if (!t) {
                    pill.textContent = '';
                    t = document.createElement('span');
                    t.className = 'np-pill-text';
                    pill.appendChild(t);
                }
                t.textContent = name;
                pill.classList.add('visible');
            } else {
                pill.classList.remove('visible');
            }
            this.refreshPillBadge();
        },

        refreshPillBadge() {
            const pill = this.els['np-viz-name-pill'];
            if (!pill) return;
            let badge = pill.querySelector('.viz-count-badge');
            const eng = this.multiPresetEngine();
            const n = eng ? eng.presetCount() : 0;
            if (n > 1) {
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'viz-count-badge';
                    pill.appendChild(badge);
                }
                badge.textContent = String(n);
                badge.title = n + ' presets';
            } else if (badge) badge.remove();
        },

        multiPresetEngine() {
            const b = this.active && this.active.type === 'builtin' ? this.active.builtin : null;
            if (!b || !b.engine || !b.engine.presetCount) return null;
            return b.engine.presetCount() > 1 ? b.engine : null;
        },

        updateMultiNamePill() {
            const eng = this.multiPresetEngine();
            if (!eng) return;
            try { this.setNamePill(this.active.name + ' · ' + eng.currentName()); } catch (e) {}
        },

        // ---------------- Multi-preset tip ----------------
        maybeShowPresetTip() {
            try {
                if (!this.multiPresetEngine()) return;
                if (localStorage.getItem('np-viz-preset-tip') === 'gone') return;
                if (sessionStorage.getItem('np-viz-preset-tip-seen')) return;
                const tip = document.getElementById('np-viz-tip');
                if (!tip) return;
                const cb = document.getElementById('np-tip-dontshow');
                if (cb) cb.checked = false;
                sessionStorage.setItem('np-viz-preset-tip-seen', '1');
                tip.classList.add('open');
                clearTimeout(this._tipTimer);
                this._tipTimer = setTimeout(() => this.dismissPresetTip(), 9000);
            } catch (e) {}
        },

        dismissPresetTip() {
            const tip = document.getElementById('np-viz-tip');
            if (tip) tip.classList.remove('open');
            clearTimeout(this._tipTimer);
            try {
                const cb = document.getElementById('np-tip-dontshow');
                if (cb && cb.checked) localStorage.setItem('np-viz-preset-tip', 'gone');
            } catch (e) {}
        },

        wirePresetTip() {
            const tip = document.getElementById('np-viz-tip');
            if (!tip) return;
            tip.addEventListener('click', () => this.dismissPresetTip());
            document.addEventListener('click', (e) => {
                const t = document.getElementById('np-viz-tip');
                if (!t || !t.classList.contains('open')) return;
                if (t.contains(e.target)) return;
                this.dismissPresetTip();
            }, true);
        },

        setDefault(on) {
            this.wantDefault = !!on;
            if (!on) { this.deactivate(); return; }
            if (!this.active) this.select(WmpHost.ready ? 'alchemy' : 'neon-bars').catch(() => {});
        },

        onViewChanged(isNowPlaying) {
            if (!isNowPlaying) {
                clearTimeout(this.idleTimer);
                this.idleOn = false;
                this.view.classList.remove('np-idle');
                this.closePopup();
                return;
            }
            if (!this.active && this.wantDefault) this.select(WmpHost.ready ? 'alchemy' : 'neon-bars').catch(() => {});
            this.bumpIdle();
        },

        onTrackPlayStateChange() { /* handled inline via audioPlayer reads */ },

        // ---------------- Popup menu ----------------
        wirePopup() {
            const btn = document.getElementById('np-viz-btn');
            const wrap = this.els['np-viz-btn-wrap'];
            const backdrop = this.els['np-viz-backdrop'];
            if (!btn || !backdrop) return;
            btn.addEventListener('click', () => { try { AudioManager.playMusicClickUI(); } catch (e) {} this.openPopup(); });
            backdrop.addEventListener('click', () => this.closePopup());
            wrap.addEventListener('wheel', (e) => { /* reserved */ }, { passive: true });
        },

        openPopup() {
            this.popupOpen = true;
            this.bumpIdle();
            this.buildGrid();
            this.els['np-viz-popup'].classList.add('open');
            this.els['np-viz-backdrop'].classList.add('open');
        },

        closePopup() {
            this.popupOpen = false;
            this.els['np-viz-popup'].classList.remove('open');
            this.els['np-viz-backdrop'].classList.remove('open');
        },

        buildGrid() {
            const grid = this.els['np-viz-grid'];
            grid.innerHTML = '';
            const entries = this.entries();
            for (const en of entries) {
                const pill = document.createElement('div');
                pill.className = 'viz-pill' + (en.type === 'wmp' ? '' : ' builtin') + (this.active && this.active.id === en.id ? ' active' : '');
                const mask = document.createElement('div');
                mask.className = 'viz-pill-mask';
                const label = document.createElement('span');
                label.className = 'viz-pill-label';
                label.textContent = en.name;
                mask.appendChild(label);
                pill.appendChild(mask);
                pill.addEventListener('click', () => { try { AudioManager.playMusicClickUI(); } catch (e) {} this.select(en.id); this.closePopup(); });
                pill.addEventListener('wheel', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const max = Math.max(0, label.offsetWidth - mask.clientWidth + 4);
                    if (max <= 0) return;
                    const cur = parseFloat(label.dataset.off || '0');
                    const next = Math.max(0, Math.min(max, cur + (e.deltaY || 0)));
                    label.dataset.off = String(next);
                    label.style.transform = 'translateX(' + (-next) + 'px)';
                }, { passive: false });
                grid.appendChild(pill);
                if (label.offsetWidth > mask.clientWidth) pill.classList.add('overflow');
            }
            const none = document.createElement('div');
            none.className = 'viz-pill none' + (!this.active ? ' active' : '');
            const nm = document.createElement('div'); nm.className = 'viz-pill-mask';
            const nl = document.createElement('span'); nl.className = 'viz-pill-label'; nl.textContent = 'None';
            nm.appendChild(nl); none.appendChild(nm);
            none.addEventListener('click', () => { try { AudioManager.playMusicClickUI(); } catch (e) {} this.deactivate(); this.closePopup(); });
            grid.appendChild(none);
        },

        // ---------------- Idle fade / reveal ----------------
        wireIdle() {
            const bump = () => { if (this.view.classList.contains('active-view')) this.bumpIdle(); };
            document.addEventListener('mousemove', bump);
            document.addEventListener('mousedown', bump);
        },

        bumpIdle() {
            clearTimeout(this.idleTimer);
            if (this.idleOn) {
                this.idleOn = false;
                this.view.classList.remove('np-idle');
                this.view.classList.add('np-reveal-top', 'np-reveal-bottom');
                setTimeout(() => this.view.classList.remove('np-reveal-top', 'np-reveal-bottom'), 380);
            }
            this.idleTimer = setTimeout(() => {
                if (this.popupOpen || !this.view.classList.contains('active-view')) return;
                this.idleOn = true;
                this.view.classList.add('np-idle');
            }, 5000);
        },

        // ---------------- Keys ----------------
        wireKeys() {
            document.addEventListener('keydown', (e) => {
                if (e.ctrlKey && (e.key === 'g' || e.key === 'G')) {
                    if (!this.view.classList.contains('active-view')) return;
                    e.preventDefault();
                    this.gridVisible = !this.gridVisible;
                    this.els['np-dot-grid'].style.opacity = this.gridVisible ? '' : '0';
                }
            });
        },
    };

    window.NPViz = NPViz;
    window.NPWmpHost = WmpHost;
    window.BatteryViz = BatteryViz;
})();
