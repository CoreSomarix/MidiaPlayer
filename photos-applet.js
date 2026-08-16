/**
 * Midia Photos / Albums Applet
 */
(function () {
    'use strict';

    const PhotosAppState = {
        folderPath: null,
        folderLinked: false,
        photos: [],
        newPhotoCount: 0,
        newPhotoPaths: new Set(),
        currentPhoto: null,
        libraryReady: false,
        puzzleSize: 3,
        puzzleStartTime: null
    };

    const DOODLE_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#000000', '#ffffff', '#a855f7', '#f97316'];
    const STICKER_EMOJIS = ['😀', '😎', '❤️', '⭐', '🔥', '✨', '🎉', '🌈', '🐱', '🐶', '🍕', '🎮', '👍', '💯', '🌸', '🎵'];

    let deps = {};
    let doodleCtx = null;
    let doodleCanvas = null;
    let doodleBaseCanvas = null;
    let doodleBaseImage = null;
    let isDrawing = false;
    let currentTool = 'brush';
    let currentColor = '#ef4444';
    let brushSize = 8;
    let lastDrawPoint = null;
    let didStroke = false;
    let doodleUndoStack = [];
    let doodleRedoStack = [];

    const PhotosApplet = {
        applet: null,
        isOpen: false,
        views: {},
        activeBgm: null,

        init(shared) {
            deps = shared;
            this.applet = document.getElementById('photos-applet');
            this.views = {
                onboarding: document.getElementById('photos-onboarding-view'),
                scanning: document.getElementById('photos-scanning-view'),
                gallery: document.getElementById('photos-gallery-view'),
                options: document.getElementById('photos-options-view'),
                puzzle: document.getElementById('photos-puzzle-view'),
                doodle: document.getElementById('photos-doodle-view')
            };
            this.setupEvents();
            this.setupDoodleCanvas();

            return new Promise((resolve) => {
                if (!deps.ipcRenderer) {
                    this.showFirstLaunchOnboarding();
                    resolve();
                    return;
                }
                deps.ipcRenderer.invoke('load-photos-library').then((data) => {
                    const settingsFolder = deps.settings ? deps.settings.photos.folderPath : null;
                    const libFolder = data && data.folderPath;
                    const folderPath = settingsFolder || libFolder;
                    if (folderPath && deps.fs && deps.fs.existsSync(folderPath)) {
                        PhotosAppState.folderPath = folderPath;
                        PhotosAppState.folderLinked = true;
                        PhotosAppState.photos = (data.photos || []).map(p => ({
                            ...p,
                            doodlePath: p.doodlePath || null
                        }));
                        PhotosAppState.newPhotoCount = 0;
                        requestAnimationFrame(() => {
                            setTimeout(() => {
                                this.renderGallery();
                                this.navigateTo('gallery');
                                PhotosAppState.libraryReady = true;
                                setTimeout(() => {
                                    if (deps.fs && deps.fs.existsSync(folderPath)) {
                                        this.performSilentScan(folderPath);
                                    }
                                    resolve();
                                }, 300);
                            }, 50);
                        });
                    } else {
                        this.showFirstLaunchOnboarding();
                        resolve();
                    }
                }).catch(() => { this.showFirstLaunchOnboarding(); resolve(); });
            });
        },

        fileUrl(p) {
            if (!p) return '';
            return `file:///${p.replace(/\\/g, '/')}`;
        },

        getDisplayPath(photo) {
            return photo.doodlePath || photo.path;
        },

        showFirstLaunchOnboarding() {
            const settingsFolder = deps.settings ? deps.settings.photos.folderPath : null;
            PhotosAppState.folderPath = settingsFolder || null;
            PhotosAppState.folderLinked = false;
            const el = document.getElementById('photos-auto-folder-path');
            if (el) el.textContent = settingsFolder || 'No photo folder is linked yet.';
            this.navigateTo('onboarding');
        },

        setupEvents() {
            document.getElementById('photos-onboarding-home-btn')?.addEventListener('click', () => {
                this.promptExit();
            });
            document.getElementById('photos-onboarding-choose-btn')?.addEventListener('click', async () => {
                deps.PhotosSFX?.playClick();
                if (!deps.ipcRenderer) return;
                const folderPath = await deps.ipcRenderer.invoke('select-folder');
                if (!folderPath) return;
                PhotosAppState.folderPath = folderPath;
                if (deps.settings) {
                    deps.settings.photos.folderPath = folderPath;
                    try { deps.ipcRenderer.invoke('save-settings', deps.settings).catch(() => {}); } catch (e) {}
                }
                const el = document.getElementById('photos-auto-folder-path');
                if (el) el.textContent = folderPath;
                await deps.ipcRenderer.invoke('set-photos-folder', folderPath).catch(() => {});
                this.performScan(folderPath, true);
            });
            document.getElementById('photos-unlink-yes')?.addEventListener('click', () => this.doUnlink());
            document.getElementById('photos-unlink-no')?.addEventListener('click', () => {
                document.getElementById('photos-unlink-modal')?.classList.remove('active');
            });
            document.addEventListener('keydown', (e) => {
                const activeEl = document.activeElement;
                if (activeEl && activeEl.tagName === 'INPUT') return;
                if (this.isOpen && e.ctrlKey && (e.key === 'r' || e.key === 'R')) {
                    e.preventDefault();
                    this.promptUnlink();
                }
            });
            document.getElementById('photos-home-tab')?.addEventListener('click', () => this.promptExit());
            document.getElementById('photos-exit-menu-btn')?.addEventListener('click', () => {
                deps.PhotosSFX?.playClick();
                this.promptExit();
            });
            document.getElementById('photos-refresh-btn')?.addEventListener('click', () => {
                deps.PhotosSFX?.playClick();
                if (PhotosAppState.folderLinked) this.performScan(PhotosAppState.folderPath, false);
            });

            document.getElementById('photo-opt-doodle')?.addEventListener('click', () => {
                deps.PhotosSFX?.playUIClick();
                this.openDoodle();
            });
            document.getElementById('photo-opt-view')?.addEventListener('click', () => {
                deps.PhotosSFX?.playUIClick();
                this.openFullscreen();
            });
            document.getElementById('photo-opt-puzzle')?.addEventListener('click', () => {
                deps.PhotosSFX?.playUIClick();
                this.startPuzzle(3);
            });
            document.getElementById('photos-options-back')?.addEventListener('click', () => {
                deps.PhotosSFX?.playClick();
                this.navigateTo('gallery');
            });

            document.getElementById('puzzle-back-btn')?.addEventListener('click', () => {
                deps.PhotosSFX?.playClick();
                this.navigateTo('options');
            });
            document.getElementById('doodle-back-btn')?.addEventListener('click', () => {
                deps.PhotosSFX?.playClick();
                document.getElementById('photos-doodle-exit-modal')?.classList.add('active');
            });
            document.getElementById('doodle-save-btn')?.addEventListener('click', () => {
                deps.PhotosSFX?.playClick();
                document.getElementById('photos-doodle-save-modal')?.classList.add('active');
            });
            document.getElementById('doodle-exit-yes')?.addEventListener('click', () => {
                document.getElementById('photos-doodle-exit-modal')?.classList.remove('active');
                this.closeDoodle(false);
            });
            document.getElementById('doodle-exit-no')?.addEventListener('click', () => {
                document.getElementById('photos-doodle-exit-modal')?.classList.remove('active');
            });
            document.getElementById('doodle-save-yes')?.addEventListener('click', () => this.saveDoodle());
            document.getElementById('doodle-save-no')?.addEventListener('click', () => {
                document.getElementById('photos-doodle-save-modal')?.classList.remove('active');
            });
            document.getElementById('photos-exit-yes')?.addEventListener('click', () => {
                document.getElementById('photos-exit-modal')?.classList.remove('active');
                this.doClose();
            });
            document.getElementById('photos-exit-no')?.addEventListener('click', () => {
                document.getElementById('photos-exit-modal')?.classList.remove('active');
            });
            document.getElementById('puzzle-done-btn')?.addEventListener('click', () => {
                document.getElementById('photos-puzzle-win-modal')?.classList.remove('active');
                this.navigateTo('options');
            });

            document.querySelectorAll('.doodle-color').forEach(btn => {
                btn.addEventListener('click', () => {
                    deps.PhotosSFX?.playTool();
                    currentTool = btn.dataset.tool || 'brush';
                    currentColor = btn.dataset.color || currentColor;
                    document.querySelectorAll('.doodle-color').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });
            document.getElementById('doodle-eraser-btn')?.addEventListener('click', () => {
                deps.PhotosSFX?.playTool();
                currentTool = 'eraser';
                document.querySelectorAll('.doodle-color').forEach(b => b.classList.remove('active'));
                document.getElementById('doodle-eraser-btn')?.classList.add('active');
            });
            document.getElementById('doodle-sticker-btn')?.addEventListener('click', () => {
                deps.PhotosSFX?.playTool();
                currentTool = 'sticker';
                document.querySelectorAll('.doodle-color, #doodle-eraser-btn').forEach(b => b.classList.remove('active'));
                document.getElementById('doodle-sticker-btn')?.classList.add('active');
                document.getElementById('doodle-sticker-panel')?.classList.toggle('active');
            });
            document.querySelectorAll('.sticker-emoji').forEach(el => {
                el.addEventListener('click', () => {
                    deps.PhotosSFX?.playTool();
                    currentTool = 'sticker';
                    currentColor = el.dataset.emoji;
                });
            });
            document.getElementById('doodle-undo-btn')?.addEventListener('click', () => this.undoDoodle());
            document.getElementById('doodle-redo-btn')?.addEventListener('click', () => this.redoDoodle());
        },

        setupDoodleCanvas() {
            // doodle-base-canvas renders the photo underneath (non-interactive)
            // doodle-draw-canvas is the transparent layer the user actually draws on
            doodleCanvas = document.getElementById('doodle-draw-canvas');
            doodleBaseCanvas = document.getElementById('doodle-base-canvas');
            if (!doodleCanvas || !doodleBaseCanvas) return;
            doodleCtx = doodleCanvas.getContext('2d');

            const startDraw = (e) => {
                if (currentTool === 'sticker') return;
                isDrawing = true;
                const pt = this.getCanvasPoint(e);
                lastDrawPoint = pt;
                if (currentTool === 'bucket') {
                    deps.PhotosSFX?.playTool();
                    this.floodFill(pt.x, pt.y, currentColor);
                    isDrawing = false;
                    this.pushDoodleState();
                    return;
                }
                didStroke = false;
            };
            const draw = (e) => {
                if (!isDrawing || currentTool === 'sticker' || currentTool === 'bucket') return;
                const pt = this.getCanvasPoint(e);
                didStroke = true;
                doodleCtx.lineCap = 'round';
                doodleCtx.lineJoin = 'round';
                if (currentTool === 'eraser') {
                    doodleCtx.globalCompositeOperation = 'destination-out';
                    doodleCtx.lineWidth = brushSize * 2;
                    doodleCtx.strokeStyle = 'rgba(0,0,0,1)';
                } else {
                    doodleCtx.globalCompositeOperation = 'source-over';
                    doodleCtx.lineWidth = brushSize;
                    doodleCtx.strokeStyle = currentColor;
                }
                doodleCtx.beginPath();
                doodleCtx.moveTo(lastDrawPoint.x, lastDrawPoint.y);
                doodleCtx.lineTo(pt.x, pt.y);
                doodleCtx.stroke();
                lastDrawPoint = pt;
            };
            const endDraw = () => { isDrawing = false; lastDrawPoint = null; if (didStroke) { this.pushDoodleState(); didStroke = false; } };

            doodleCanvas.addEventListener('mousedown', startDraw);
            doodleCanvas.addEventListener('mousemove', draw);
            doodleCanvas.addEventListener('mouseup', endDraw);
            doodleCanvas.addEventListener('mouseleave', endDraw);
            doodleCanvas.addEventListener('click', (e) => {
                if (currentTool === 'sticker' && currentColor) {
                    deps.PhotosSFX?.playTool();
                    const pt = this.getCanvasPoint(e);
                    doodleCtx.font = `${brushSize * 4}px serif`;
                    doodleCtx.globalCompositeOperation = 'source-over';
                    doodleCtx.fillText(currentColor, pt.x - 16, pt.y + 8);
                    this.pushDoodleState();
                }
            });
        },

        getCanvasPoint(e) {
            const rect = doodleCanvas.getBoundingClientRect();
            const scaleX = doodleCanvas.width / rect.width;
            const scaleY = doodleCanvas.height / rect.height;
            return {
                x: (e.clientX - rect.left) * scaleX,
                y: (e.clientY - rect.top) * scaleY
            };
        },

        floodFill(startX, startY, fillColor) {
            const w = doodleCanvas.width;
            const h = doodleCanvas.height;
            const imgData = doodleCtx.getImageData(0, 0, w, h);
            const data = imgData.data;
            const startIdx = (Math.floor(startY) * w + Math.floor(startX)) * 4;
            const startR = data[startIdx], startG = data[startIdx + 1], startB = data[startIdx + 2], startA = data[startIdx + 3];
            const fill = this.hexToRgba(fillColor);
            if (startR === fill.r && startG === fill.g && startB === fill.b) return;
            const stack = [[Math.floor(startX), Math.floor(startY)]];
            const visited = new Uint8Array(w * h);
            while (stack.length) {
                const [x, y] = stack.pop();
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                const vi = y * w + x;
                if (visited[vi]) continue;
                const i = vi * 4;
                if (Math.abs(data[i] - startR) > 30 || Math.abs(data[i + 1] - startG) > 30 || Math.abs(data[i + 2] - startB) > 30) continue;
                visited[vi] = 1;
                data[i] = fill.r; data[i + 1] = fill.g; data[i + 2] = fill.b; data[i + 3] = 255;
                stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
            }
            doodleCtx.putImageData(imgData, 0, 0);
        },

        hexToRgba(hex) {
            const h = hex.replace('#', '');
            return {
                r: parseInt(h.substring(0, 2), 16),
                g: parseInt(h.substring(2, 4), 16),
                b: parseInt(h.substring(4, 6), 16)
            };
        },

        updatePhotosBadge() {
            const badge = document.getElementById('photos-new-badge');
            if (!badge) return;
            badge.classList.toggle('visible', PhotosAppState.newPhotoCount > 0);
        },

        mergeNewPhotos(fileList) {
            const existing = new Set(PhotosAppState.photos.map(p => p.path));
            const toAdd = [];
            fileList.forEach(p => {
                if (!existing.has(p.path)) {
                    toAdd.push(p);
                    PhotosAppState.newPhotoPaths.add(p.path);
                }
            });
            if (toAdd.length) PhotosAppState.photos.unshift(...toAdd);
            return toAdd.length;
        },

        performSilentScan(folderPath) {
            if (!folderPath || !deps.ipcRenderer) return;
            const knownPaths = PhotosAppState.photos.map(p => p.path);
            const handler = (e, fileList) => {
                deps.ipcRenderer.removeListener('photos-scan-complete', handler);
                const n = this.mergeNewPhotos(fileList);
                if (n === 0) return;
                PhotosAppState.newPhotoCount = n;
                this.updatePhotosBadge();
                deps.ipcRenderer.invoke('save-photos-library', {
                    folderPath,
                    photos: PhotosAppState.photos,
                    onboardingCompleted: true
                }).catch(() => {});
                this.renderGallery();
            };
            deps.ipcRenderer.on('photos-scan-complete', handler);
            deps.ipcRenderer.send('scan-photos-folder', { folderPath, knownPaths, incremental: true });
        },

        performScan(folderPath, initial) {
            if (!folderPath) return;
            this.navigateTo('scanning');
            document.getElementById('photos-scan-status').textContent = initial
                ? 'Scanning your photos...' : 'Checking for new photos...';
            document.getElementById('photos-scan-count').textContent = '0';

            const progressHandler = (e, count) => {
                document.getElementById('photos-scan-count').textContent = count;
            };
            deps.ipcRenderer.on('photos-scan-progress', progressHandler);

            const completeHandler = (e, fileList) => {
                deps.ipcRenderer.removeListener('photos-scan-progress', progressHandler);
                deps.ipcRenderer.removeListener('photos-scan-complete', completeHandler);

                if (initial) {
                    PhotosAppState.folderPath = folderPath;
                    PhotosAppState.folderLinked = true;
                    PhotosAppState.photos = fileList;
                    PhotosAppState.newPhotoCount = 0;
                } else {
                    const n = this.mergeNewPhotos(fileList);
                    if (n > 0) {
                        PhotosAppState.newPhotoCount = n;
                        this.updatePhotosBadge();
                    }
                }

                deps.ipcRenderer.invoke('save-photos-library', {
                    folderPath,
                    photos: PhotosAppState.photos,
                    onboardingCompleted: true
                }).then(() => {
                    setTimeout(() => {
                        this.renderGallery();
                        this.navigateTo('gallery');
                    }, 500);
                });
            };
            deps.ipcRenderer.on('photos-scan-complete', completeHandler);
            deps.ipcRenderer.send('scan-photos-folder', {
                folderPath,
                knownPaths: initial ? [] : PhotosAppState.photos.map(p => p.path),
                incremental: !initial
            });
        },

        renderGallery() {
            const grid = document.getElementById('photos-grid');
            const countEl = document.getElementById('photos-count-label');
            const newEl = document.getElementById('photos-new-label');
            if (!grid) return;

            const photos = PhotosAppState.photos;
            if (countEl) countEl.textContent = `${photos.length} image${photos.length !== 1 ? 's' : ''} loaded`;
            if (newEl) newEl.textContent = PhotosAppState.newPhotoPaths.size > 0
                ? `${PhotosAppState.newPhotoPaths.size} new` : '';

            if (!photos.length) {
                grid.innerHTML = '<div class="photos-empty">No photos found. Add screenshots to your folder!</div>';
                return;
            }

            grid.innerHTML = photos.map(photo => {
                const url = this.fileUrl(this.getDisplayPath(photo));
                const isNew = PhotosAppState.newPhotoPaths.has(photo.path);
                const doodled = !!photo.doodlePath;
                return `<div class="photo-tile${isNew ? ' is-new' : ''}" data-path="${photo.path}">
                    <div class="photo-thumb-wrap">
                        <img class="photo-thumb" src="${url}" alt="" loading="lazy">
                        ${doodled ? '<img class="photo-doodle-badge" src="assets/photos/paintbrush-icon.png" alt="Doodled">' : ''}
                        ${isNew ? '<span class="photo-new-dot"></span>' : ''}
                    </div>
                </div>`;
            }).join('');

            grid.querySelectorAll('.photo-tile').forEach(tile => {
                tile.addEventListener('mouseenter', () => deps.PhotosSFX?.playHover());
                tile.addEventListener('click', () => {
                    deps.PhotosSFX?.playClick();
                    const photo = PhotosAppState.photos.find(p => p.path === tile.dataset.path);
                    if (photo) this.openPhotoOptions(photo);
                });
            });
        },

        openPhotoOptions(photo) {
            PhotosAppState.currentPhoto = photo;
            PhotosAppState.newPhotoPaths.delete(photo.path);
            if (PhotosAppState.newPhotoCount > 0) PhotosAppState.newPhotoCount = PhotosAppState.newPhotoPaths.size;
            this.updatePhotosBadge();

            const preview = document.getElementById('photos-options-preview');
            const badge = document.getElementById('photos-options-doodle-badge');
            const nameEl = document.getElementById('photos-options-name');
            const dateEl = document.getElementById('photos-options-date');
            const countEl = document.getElementById('photos-options-count-label');

            if (preview) preview.src = this.fileUrl(this.getDisplayPath(photo));
            if (badge) badge.style.display = photo.doodlePath ? 'block' : 'none';

            // Screenshot display name: use photo.name, or extract filename from path
            if (nameEl) {
                const raw = photo.name || (photo.path ? photo.path.split(/[\\/]/).pop() : '');
                nameEl.textContent = raw.replace(/\.[^.]+$/, '') || 'Screenshot';
            }
            // Date: use the stored added/dateModified timestamp, or show a dash
            if (dateEl) {
                const ts = photo.added || photo.dateModified || null;
                if (ts) {
                    const d = new Date(ts);
                    dateEl.textContent = 'Date Taken: ' + d.toLocaleDateString('en-US', {
                        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
                    });
                } else {
                    dateEl.textContent = 'Date Taken: —';
                }
            }
            if (countEl) countEl.textContent = `All Screenshots: ${PhotosAppState.photos.length}`;

            this.navigateTo('options');
        },

        startPuzzle(size) {
            PhotosAppState.puzzleSize = size;
            PhotosAppState.puzzleStartTime = Date.now();
            this.navigateTo('puzzle');
            this.buildPuzzle(size);
        },

        buildPuzzle(size) {
            const board = document.getElementById('puzzle-board');
            const photo = PhotosAppState.currentPhoto;
            if (!board || !photo) return;

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const side = Math.min(img.width, img.height);
                const sx = (img.width - side) / 2;
                const sy = (img.height - side) / 2;
                const pieces = [];
                for (let r = 0; r < size; r++) {
                    for (let c = 0; c < size; c++) {
                        pieces.push({ r, c, correct: r * size + c });
                    }
                }
                this.shufflePuzzle(pieces);
                board.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
                board.innerHTML = '';
                pieces.forEach((piece, idx) => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 120;
                    canvas.height = 120;
                    const ctx = canvas.getContext('2d');
                    const pw = side / size;
                    ctx.drawImage(img, sx + piece.c * pw, sy + piece.r * pw, pw, pw, 0, 0, 120, 120);
                    const div = document.createElement('div');
                    div.className = 'puzzle-piece';
                    div.dataset.idx = idx;
                    div.dataset.correct = piece.correct;
                    div.appendChild(canvas);
                    div.addEventListener('click', () => this.onPuzzlePieceClick(div));
                    board.appendChild(div);
                });
                this.puzzleSelected = null;
            };
            img.src = this.fileUrl(photo.path);
        },

        shufflePuzzle(pieces) {
            for (let i = pieces.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
            }
        },

        onPuzzlePieceClick(el) {
            deps.PhotosSFX?.playUIClick();
            if (!this.puzzleSelected) {
                this.puzzleSelected = el;
                el.classList.add('selected');
                return;
            }
            if (this.puzzleSelected === el) {
                el.classList.remove('selected');
                this.puzzleSelected = null;
                return;
            }
            const parent = el.parentNode;
            const a = this.puzzleSelected;
            const b = el;
            const aNext = a.nextSibling;
            const bNext = b.nextSibling;
            parent.insertBefore(a, bNext);
            parent.insertBefore(b, aNext);
            a.classList.remove('selected');
            this.puzzleSelected = null;
            this.checkPuzzleComplete();
        },

        checkPuzzleComplete() {
            const pieces = document.querySelectorAll('#puzzle-board .puzzle-piece');
            let correct = true;
            pieces.forEach((el, idx) => {
                if (parseInt(el.dataset.correct, 10) !== idx) correct = false;
            });
            if (!correct) return;

            const elapsed = Math.floor((Date.now() - PhotosAppState.puzzleStartTime) / 1000);
            const title = document.getElementById('puzzle-win-title');
            const timeEl = document.getElementById('puzzle-win-time');
            const actions = document.getElementById('puzzle-win-actions');
            if (title) title.textContent = 'CONGRADULATIONS';
            if (timeEl) {
                if (elapsed >= 60) {
                    const mins = Math.floor(elapsed / 60);
                    const secs = elapsed % 60;
                    timeEl.textContent = `You finished the puzzle in ${mins} minute${mins !== 1 ? 's' : ''} and ${secs} second${secs !== 1 ? 's' : ''}!!!`;
                } else {
                    timeEl.textContent = `You finished the puzzle in ${elapsed} second${elapsed !== 1 ? 's' : ''}!`;
                }
            }
            if (actions) {
                const size = PhotosAppState.puzzleSize;
                actions.innerHTML = '';
                if (size === 3) {
                    actions.innerHTML = `<button class="modal-btn modal-btn-yes" id="puzzle-6x6-btn">Try 6×6 mode</button><button class="modal-btn modal-btn-no" id="puzzle-done-btn">I'm done</button>`;
                    document.getElementById('puzzle-6x6-btn')?.addEventListener('click', () => {
                        document.getElementById('photos-puzzle-win-modal')?.classList.remove('active');
                        this.startPuzzle(6);
                    });
                } else if (size === 6) {
                    actions.innerHTML = `<button class="modal-btn modal-btn-yes" id="puzzle-6x6-btn">Try 6×6 again</button><button class="modal-btn modal-btn-silver" id="puzzle-12x12-btn">Play again in 12×12 mode</button><button class="modal-btn modal-btn-no" id="puzzle-done-btn">I'm done</button>`;
                    document.getElementById('puzzle-6x6-btn')?.addEventListener('click', () => {
                        document.getElementById('photos-puzzle-win-modal')?.classList.remove('active');
                        this.startPuzzle(6);
                    });
                    document.getElementById('puzzle-12x12-btn')?.addEventListener('click', () => {
                        document.getElementById('photos-puzzle-win-modal')?.classList.remove('active');
                        this.startPuzzle(12);
                    });
                } else {
                    actions.innerHTML = `<button class="modal-btn modal-btn-silver" id="puzzle-12x12-btn">Play again in 12×12 mode</button><button class="modal-btn modal-btn-no" id="puzzle-done-btn">I'm done</button>`;
                    document.getElementById('puzzle-12x12-btn')?.addEventListener('click', () => {
                        document.getElementById('photos-puzzle-win-modal')?.classList.remove('active');
                        this.startPuzzle(12);
                    });
                }
                document.getElementById('puzzle-done-btn')?.addEventListener('click', () => {
                    document.getElementById('photos-puzzle-win-modal')?.classList.remove('active');
                    this.navigateTo('options');
                });
            }
            document.getElementById('photos-puzzle-win-modal')?.classList.add('active');
        },

        doodleSnapshot() {
            if (!doodleCtx || !doodleCanvas) return null;
            return doodleCtx.getImageData(0, 0, doodleCanvas.width, doodleCanvas.height);
        },

        pushDoodleState() {
            const snap = this.doodleSnapshot();
            if (!snap) return;
            doodleUndoStack.push(snap);
            if (doodleUndoStack.length > 50) doodleUndoStack.shift();
            doodleRedoStack = [];
            this.updateDoodleButtons();
        },

        updateDoodleButtons() {
            const undoBtn = document.getElementById('doodle-undo-btn');
            const redoBtn = document.getElementById('doodle-redo-btn');
            if (undoBtn) undoBtn.disabled = doodleUndoStack.length <= 1;
            if (redoBtn) redoBtn.disabled = doodleRedoStack.length === 0;
        },

        undoDoodle() {
            if (doodleUndoStack.length <= 1) return;
            deps.PhotosSFX?.playUIClick();
            doodleRedoStack.push(doodleUndoStack.pop());
            const snap = doodleUndoStack[doodleUndoStack.length - 1];
            if (snap) doodleCtx.putImageData(snap, 0, 0);
            this.updateDoodleButtons();
        },

        redoDoodle() {
            if (doodleRedoStack.length === 0) return;
            deps.PhotosSFX?.playUIClick();
            const snap = doodleRedoStack.pop();
            doodleUndoStack.push(snap);
            if (snap) doodleCtx.putImageData(snap, 0, 0);
            this.updateDoodleButtons();
        },

        openDoodle() {
            const photo = PhotosAppState.currentPhoto;
            if (!photo) return;
            this.navigateTo('doodle');
            deps.AudioManager?.crossfadeTo('doodle');

            const img = new Image();
            img.onload = () => {
                const maxW = 900, maxH = 500;
                let w = img.width, h = img.height;
                const ratio = Math.min(maxW / w, maxH / h, 1);
                w = Math.floor(w * ratio);
                h = Math.floor(h * ratio);
                // Both canvases get the same dimensions so they stack perfectly
                doodleBaseCanvas.width = w;
                doodleBaseCanvas.height = h;
                doodleCanvas.width = w;
                doodleCanvas.height = h;
                // Photo goes on the base canvas, draw canvas stays transparent
                const baseCtx = doodleBaseCanvas.getContext('2d');
                baseCtx.clearRect(0, 0, w, h);
                baseCtx.drawImage(img, 0, 0, w, h);
                doodleCtx.clearRect(0, 0, w, h);
                doodleBaseImage = img;
                doodleUndoStack = [];
                doodleRedoStack = [];
                this.pushDoodleState();
                this.updateDoodleButtons();
            };
            img.src = this.fileUrl(this.getDisplayPath(photo));
        },

        closeDoodle(saveFirst) {
            document.getElementById('photos-doodle-exit-modal')?.classList.remove('active');
            if (saveFirst) return;
            deps.AudioManager?.crossfadeTo('photos');
            this.navigateTo('options');
        },

        async saveDoodle() {
            document.getElementById('photos-doodle-save-modal')?.classList.remove('active');
            const photo = PhotosAppState.currentPhoto;
            if (!photo || !doodleCanvas) return;
            // Flatten base photo + drawing layer into a single PNG for saving
            const composite = document.createElement('canvas');
            composite.width = doodleBaseCanvas.width;
            composite.height = doodleBaseCanvas.height;
            const compCtx = composite.getContext('2d');
            compCtx.drawImage(doodleBaseCanvas, 0, 0);
            compCtx.drawImage(doodleCanvas, 0, 0);
            const dataUrl = composite.toDataURL('image/png');
            const doodlePath = await deps.ipcRenderer.invoke('save-doodle', {
                dataUrl,
                originalPath: photo.path
            });
            if (doodlePath) {
                photo.doodlePath = doodlePath;
                deps.PhotosSFX?.playSave();
                await deps.ipcRenderer.invoke('save-photos-library', {
                    folderPath: PhotosAppState.folderPath,
                    photos: PhotosAppState.photos,
                    onboardingCompleted: true
                });
                deps.AudioManager?.crossfadeTo('photos');
                this.renderGallery();
                this.navigateTo('options');
                const preview = document.getElementById('photos-options-preview');
                const badge = document.getElementById('photos-options-doodle-badge');
                if (preview) preview.src = this.fileUrl(doodlePath);
                if (badge) badge.style.display = 'block';
            }
        },

        openFullscreen() {
            const photo = PhotosAppState.currentPhoto;
            if (!photo) return;
            const overlay = document.getElementById('photos-fullscreen');
            const img = document.getElementById('photos-fullscreen-img');
            const preview = document.getElementById('photos-options-preview');
            if (!overlay || !img) return;

            const rect = preview?.getBoundingClientRect();
            img.src = this.fileUrl(this.getDisplayPath(photo));
            overlay.classList.add('active', 'zoom-in');
            if (rect) {
                img.style.setProperty('--fs-x', `${rect.left + rect.width / 2}px`);
                img.style.setProperty('--fs-y', `${rect.top + rect.height / 2}px`);
            }
            overlay.onclick = () => {
                overlay.classList.remove('zoom-in');
                overlay.classList.add('zoom-out');
                setTimeout(() => {
                    overlay.classList.remove('active', 'zoom-out');
                }, 400);
            };
        },

        navigateTo(viewId) {
            Object.values(this.views).forEach(v => v?.classList.remove('active-view'));
            const map = {
                onboarding: 'onboarding',
                scanning: 'scanning',
                gallery: 'gallery',
                options: 'options',
                puzzle: 'puzzle',
                doodle: 'doodle'
            };
            const el = this.views[map[viewId]];
            if (el) el.classList.add('active-view');
        },

        promptExit() {
            document.getElementById('photos-exit-modal')?.classList.add('active');
        },

        promptUnlink() {
            document.getElementById('photos-unlink-modal')?.classList.add('active');
        },

        doUnlink() {
            PhotosAppState.folderLinked = false;
            PhotosAppState.folderPath = null;
            PhotosAppState.photos = [];
            PhotosAppState.newPhotoCount = 0;
            PhotosAppState.newPhotoPaths.clear();
            PhotosAppState.currentPhoto = null;
            this.updatePhotosBadge();
            if (deps.ipcRenderer) deps.ipcRenderer.invoke('reset-photos-library').catch(() => {});
            if (deps.settings) {
                deps.settings.photos.folderPath = null;
                try { deps.ipcRenderer?.invoke('save-settings', deps.settings).catch(() => {}); } catch (e) {}
            }
            document.getElementById('photos-unlink-modal')?.classList.remove('active');
            this.showFirstLaunchOnboarding();
        },

        open() {
            if (this.isOpen) return;
            this.isOpen = true;
            const ipcRenderer = deps && deps.ipcRenderer;
            try { if (ipcRenderer) ipcRenderer.send('log:append', '[photos:log] open'); } catch (e) {}
            PhotosAppState.newPhotoCount = 0;
            this.updatePhotosBadge();
            document.body.classList.add('photos-applet-open');
            deps.AudioManager?.crossfadeTo('photos');
            this.applet?.classList.add('visible');
            if (PhotosAppState.folderLinked) {
                this.navigateTo('gallery');
                this.renderGallery();
            } else {
                this.navigateTo('onboarding');
            }
        },

        async doClose() {
            if (!this.isOpen) return;
            const ipcRenderer = deps && deps.ipcRenderer;
            try { if (ipcRenderer) ipcRenderer.send('log:append', '[photos:log] close'); } catch (e) {}
            if (PhotosAppState.folderPath && deps.ipcRenderer && PhotosAppState.folderLinked) {
                try {
                    await deps.ipcRenderer.invoke('save-photos-library', {
                        folderPath: PhotosAppState.folderPath,
                        photos: PhotosAppState.photos,
                        onboardingCompleted: true
                    });
                } catch (e) {}
            }
            this.isOpen = false;
            document.body.classList.remove('photos-applet-open');
            this.applet?.classList.remove('visible');
            deps.AudioManager?.crossfadeTo('menu');
            deps.BootManager?.play();
        },

        getBubbleText() {
            if (PhotosAppState.newPhotoCount > 0) {
                return `${PhotosAppState.newPhotoCount} new photos are ready to display!`;
            }
            return 'View your collection of photos';
        }
    };

    window.PhotosApplet = PhotosApplet;
    window.PhotosAppState = PhotosAppState;
})();
