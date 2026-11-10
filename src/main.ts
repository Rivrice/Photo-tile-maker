import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
// 日本語は端末によって書体がばらつくので、Noto Sans JP を同梱して統一する
import '@fontsource-variable/noto-sans-jp/wght.css';
import './style.css';
import { COMP_LABELS, rgbToHsl } from './analyze';
import { LAYOUTS, getLayout, pointInTile } from './layouts';
import { ACCEPT, MAX_PHOTOS, extractRegion, loadPhoto, makeSamples } from './photos';
import { IS_IOS, canvasToBlob, cropFor, drawScene, effectiveComp, photoBox, type Crop } from './render';
import { IS_NATIVE, nativeSave, nativeShare, onBackButton } from './native';
import type { CompType, OverlayMode, PhotoItem, Settings, Tile } from './types';

// ---------- 設定 ----------

const STORAGE_KEY = 'photo-tile-settings-v1';
const DEFAULTS: Settings = {
  layout: 'mosaic',
  aspect: '4:5',
  columns: 0,
  gap: 10,
  margin: 24,
  radius: 0,
  slant: 0,
  seed: 1,
  bg: '#ffffff',
  overlay: 'none',
  overlayColor: '#ffffff',
  showLabel: false,
  smartCrop: true,
  format: 'image/jpeg',
  quality: 0.92,
  outEdge: 2048,
  gradKey: 'bright',
  gradDir: 'lr',
  gradRev: false,
};

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}
const settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* noop */
  }
}

// ---------- 状態 ----------

let photos: PhotoItem[] = [];
let samples: PhotoItem[] | null = null;
let selectedId = '';
let tiles: Tile[] = [];
let dims = { W: 1000, H: 1000 };
/** プレビュー全体の拡大（倍率と、中央からのずれ px） */
const stageView = { z: 1, x: 0, y: 0 };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll(sel)] as T[];

function toast(msg: string, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((t as any)._timer);
  (t as any)._timer = setTimeout(() => (t.hidden = true), ms);
}

const usingSamples = () => photos.length === 0;
function list(): PhotoItem[] {
  if (photos.length) return photos;
  samples ??= makeSamples();
  return samples;
}
const selected = () => list().find((p) => p.id === selectedId) ?? null;

// ---------- レイアウト計算 ----------

function canvasDims(aspect: string) {
  const [a, b] = aspect.split(':').map(Number);
  const r = a / b;
  return r >= 1 ? { W: 1000, H: 1000 / r } : { W: 1000 * r, H: 1000 };
}

function computeTiles(items: PhotoItem[] = list()): Tile[] {
  const def = getLayout(settings.layout);
  dims = canvasDims(settings.aspect);
  if (!items.length) return [];
  return def.build({
    W: dims.W,
    H: dims.H,
    aspects: items.map((p) => p.width / p.height),
    gap: settings.gap,
    margin: settings.margin,
    columns: def.usesColumns ? settings.columns : 0,
    seed: settings.seed,
    slant: def.slantable ? settings.slant : 0,
  });
}

// ---------- プレビュー描画 ----------

const preview = $<HTMLCanvasElement>('#preview');
const stage = $('#stage');
let dragState: { src: number; target: number | null } | null = null;
let raf = 0;

function previewImage(_t: Tile, p: PhotoItem, crop: Crop) {
  const k = p.preview.width / p.width;
  return { img: p.preview, crop: { sx: crop.sx * k, sy: crop.sy * k, sw: crop.sw * k, sh: crop.sh * k } };
}

function render() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(draw);
}

function draw() {
  const items = list();
  if (gradActive && gradSig !== layoutSig()) {
    applyGradient();
    if (!usingSamples()) renderList();
  }
  tiles = computeTiles(items);
  const box = stage.getBoundingClientRect();
  const pad = 2;
  const availW = Math.max(50, box.width - pad * 2 - parseFloat(getComputedStyle(stage).paddingLeft) * 2);
  const availH = Math.max(50, box.height - pad * 2 - parseFloat(getComputedStyle(stage).paddingTop) * 2);
  const cssScale = Math.min(availW / dims.W, availH / dims.H) * stageView.z;
  const cssW = dims.W * cssScale, cssH = dims.H * cssScale;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  // 拡大中もくっきり描く（ただし大きくなりすぎないよう長辺 4096px まで）
  const k = Math.min(cssScale * dpr, 4096 / Math.max(dims.W, dims.H));
  preview.width = Math.round(dims.W * k);
  preview.height = Math.round(dims.H * k);
  preview.style.width = `${cssW}px`;
  preview.style.height = `${cssH}px`;
  clampViewOffset();
  applyStageTransform();
  const ctx = preview.getContext('2d')!;
  const sel = items.findIndex((p) => p.id === selectedId);
  drawScene(ctx, {
    W: dims.W,
    H: dims.H,
    k,
    tiles,
    photos: items,
    settings,
    rounded: !!getLayout(settings.layout).rounded,
    image: previewImage,
    selected: sel >= 0 ? sel : undefined,
    dropTarget: dragState?.target ?? undefined,
    dragging: dragState ? dragState.src : undefined,
  });
  if (selectedId) renderAdjPanel();
  const def = getLayout(settings.layout);
  const out = outSize();
  $('#meta').textContent = usingSamples()
    ? `サンプル表示中 ・ 写真を追加するとここに並びます（最大${MAX_PHOTOS}枚）`
    : `${items.length}枚　${def.name}　書き出し ${out.w} × ${out.h} px`;
}

function applyStageTransform(extra = 1) {
  preview.style.transform = `translate(${stageView.x}px, ${stageView.y}px)${extra !== 1 ? ` scale(${extra})` : ''}`;
  $('#zoomReset').hidden = stageView.z <= 1.001;
}

function outSize() {
  const k = settings.outEdge / 1000;
  return { w: Math.round(dims.W * k), h: Math.round(dims.H * k) };
}

new ResizeObserver(() => render()).observe(stage);

// ---------- レイアウト一覧（サムネイル） ----------

let thumbTimer = 0;
function renderLayoutThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => {
    const items = list();
    const d = canvasDims(settings.aspect);
    for (const def of LAYOUTS) {
      const c = document.querySelector<HTMLCanvasElement>(`#layouts [data-layout="${def.id}"] canvas`);
      if (!c) continue;
      const size = 120;
      const k = size / Math.max(d.W, d.H);
      c.width = Math.round(d.W * k);
      c.height = Math.round(d.H * k);
      const ts = def.build({
        W: d.W,
        H: d.H,
        aspects: items.map((p) => p.width / p.height),
        gap: Math.max(settings.gap, 14),
        margin: Math.max(settings.margin, 20),
        columns: def.usesColumns ? settings.columns : 0,
        seed: settings.seed,
        slant: def.slantable ? settings.slant : 0,
      });
      drawScene(c.getContext('2d')!, {
        W: d.W,
        H: d.H,
        k,
        tiles: ts,
        photos: items,
        settings: { ...settings, overlay: 'none', showLabel: false },
        rounded: !!def.rounded,
        image: (_t, p, crop) => {
          const s = p.mini.width / p.width;
          return { img: p.mini, crop: { sx: crop.sx * s, sy: crop.sy * s, sw: crop.sw * s, sh: crop.sh * s } };
        },
      });
    }
  }, 60);
}

function buildLayoutButtons() {
  const host = $('#layouts');
  host.innerHTML = '';
  for (const def of LAYOUTS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.layout = def.id;
    b.innerHTML = `<div class="pv"><canvas></canvas></div><span>${def.name}</span>`;
    b.addEventListener('click', () => {
      settings.layout = def.id;
      saveSettings();
      syncControls();
      render();
    });
    host.appendChild(b);
  }
}

// ---------- 写真一覧 ----------

const listEl = $<HTMLUListElement>('#list');

function renderList() {
  listEl.innerHTML = '';
  photos.forEach((p, i) => {
    const li = document.createElement('li');
    li.dataset.id = p.id;
    if (p.id === selectedId) li.classList.add('active');
    const type = effectiveComp(p);
    const comp = type === 'none' ? '図形なし' : COMP_LABELS[type];
    li.innerHTML = `
      <span class="pl-num">${i + 1}</span>
      <img src="${p.thumbUrl}" alt="" draggable="false" />
      <div class="pl-text"><span class="pl-name"></span><span class="pl-sub"><i class="pl-chip" style="background:${p.stats.palette[0] ?? '#888'}"></i>${comp}</span></div>
      <button class="pl-del" aria-label="削除">×</button>`;
    li.querySelector('.pl-name')!.textContent = p.name;
    li.querySelector('.pl-del')!.addEventListener('click', (e) => {
      e.stopPropagation();
      removePhoto(p.id);
    });
    listEl.appendChild(li);
  });
  $('#count').textContent = `${photos.length} / ${MAX_PHOTOS}枚`;
  ($('.add-tile') as HTMLElement).style.display = photos.length >= MAX_PHOTOS ? 'none' : '';
  renderBgSwatches();
  renderLayoutThumbs();
}

function select(id: string) {
  selectedId = id;
  $$('#list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  renderSelPanel();
  renderAdjPanel();
  render();
}

function removePhoto(id: string) {
  photos = photos.filter((p) => p.id !== id);
  if (selectedId === id) selectedId = '';
  renderList();
  renderSelPanel();
  render();
}

// 一覧のドラッグ並べ替え（マウスはそのまま、タッチは長押ししてから）
(() => {
  let st: {
    id: string;
    li: HTMLLIElement;
    x: number;
    y: number;
    pid: number;
    active: boolean;
    timer: number;
    insert: number;
    touch: boolean;
  } | null = null;
  const ghost = $('#ghost');
  const horizontal = () => getComputedStyle(listEl).flexDirection === 'row';

  const clearMarks = () => $$('#list li').forEach((l) => l.classList.remove('drop-before', 'drop-after', 'drag-src'));

  const begin = () => {
    if (!st) return;
    st.active = true;
    st.li.classList.add('drag-src');
    document.body.classList.add('dragging');
    const p = photos.find((q) => q.id === st!.id);
    ghost.querySelector('img')!.src = p?.thumbUrl ?? '';
    ghost.hidden = false;
    moveGhost(st.x, st.y);
    navigator.vibrate?.(12);
  };
  const moveGhost = (x: number, y: number) => {
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
  };

  listEl.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest('li') as HTMLLIElement | null;
    if (!li || (e.target as HTMLElement).closest('.pl-del')) return;
    const touch = e.pointerType !== 'mouse';
    st = { id: li.dataset.id!, li, x: e.clientX, y: e.clientY, pid: e.pointerId, active: false, timer: 0, insert: -1, touch };
    if (touch) st.timer = window.setTimeout(begin, 320);
  });
  // ドラッグ中はスクロールさせない
  listEl.addEventListener(
    'touchmove',
    (e) => {
      if (st?.active) e.preventDefault();
    },
    { passive: false },
  );
  window.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const dist = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (!st.active) {
      if (st.touch) {
        if (dist > 10) {
          clearTimeout(st.timer);
          st = null;
        }
        return;
      }
      if (dist < 6) return;
      begin();
    }
    st.x = e.clientX;
    st.y = e.clientY;
    moveGhost(e.clientX, e.clientY);
    const hor = horizontal();
    const lis = $$<HTMLLIElement>('#list li');
    let insert = lis.length;
    for (let i = 0; i < lis.length; i++) {
      const r = lis[i].getBoundingClientRect();
      const mid = hor ? r.left + r.width / 2 : r.top + r.height / 2;
      if ((hor ? e.clientX : e.clientY) < mid) {
        insert = i;
        break;
      }
    }
    st.insert = insert;
    $$('#list li').forEach((l) => l.classList.remove('drop-before', 'drop-after'));
    if (insert < lis.length) lis[insert].classList.add('drop-before');
    else lis[lis.length - 1]?.classList.add('drop-after');
    // 端に近づいたら自動スクロール
    const lr = listEl.getBoundingClientRect();
    if (hor) {
      if (e.clientX < lr.left + 30) listEl.scrollLeft -= 12;
      else if (e.clientX > lr.right - 30) listEl.scrollLeft += 12;
    }
  });
  const end = (e: PointerEvent) => {
    if (!st || e.pointerId !== st.pid) return;
    clearTimeout(st.timer);
    const s = st;
    st = null;
    ghost.hidden = true;
    document.body.classList.remove('dragging');
    clearMarks();
    if (!s.active) {
      if (e.type === 'pointerup') select(selectedId === s.id ? '' : s.id);
      return;
    }
    const from = photos.findIndex((p) => p.id === s.id);
    if (from < 0 || s.insert < 0) return;
    gradActive = null;
    syncGradUI();
    const [item] = photos.splice(from, 1);
    const to = s.insert > from ? s.insert - 1 : s.insert;
    photos.splice(to, 0, item);
    renderList();
    render();
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  listEl.addEventListener('contextmenu', (e) => e.preventDefault());
})();

// ---------- プレビュー上の操作（入れ替え・全体の拡大） ----------

function toLayout(e: { clientX: number; clientY: number }) {
  const r = preview.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * dims.W, y: ((e.clientY - r.top) / r.height) * dims.H };
}
function tileAt(x: number, y: number): Tile | null {
  for (let i = tiles.length - 1; i >= 0; i--) if (pointInTile(tiles[i], x, y)) return tiles[i];
  return null;
}

const MAX_ZOOM = 4;

/** 倍率1のときに写真の見える幅・高さ（0..1） */
function baseView(p: PhotoItem, t: Tile) {
  const { bw, bh } = photoBox(p, t.w, t.h);
  const s1 = Math.max(bw / p.width, bh / p.height);
  return { sw1: Math.min(1, bw / s1 / p.width), sh1: Math.min(1, bh / s1 / p.height) };
}

/** 写真の中心位置 (cx, cy) と倍率 z が、タイルに収まる範囲になるよう調整する */
function clampView(p: PhotoItem, t: Tile, cx: number, cy: number, z: number) {
  const { sw1, sh1 } = baseView(p, t);
  z = Math.min(MAX_ZOOM, Math.max(1, z));
  const hw = sw1 / z / 2, hh = sh1 / z / 2;
  return { x: Math.min(1 - hw, Math.max(hw, cx)), y: Math.min(1 - hh, Math.max(hh, cy)), z };
}

/**
 * 位置を「動かせる範囲の中の割合」(0..1) で扱う。サイズ（倍率）は変えない。
 * 動かせる幅がない方向は can が false になる。
 */
function getPos(p: PhotoItem, t: Tile) {
  const { sw1, sh1 } = baseView(p, t);
  const z = Math.min(MAX_ZOOM, Math.max(1, p.zoom));
  const rx = 1 - sw1 / z, ry = 1 - sh1 / z;
  const c = currentView(p, t).c;
  const canX = rx > 0.002, canY = ry > 0.002;
  const f = (c: number, r: number, ok: boolean) => (ok ? Math.min(1, Math.max(0, (c - (1 - r) / 2) / r)) : 0.5);
  return { u: f(c.x, rx, canX), v: f(c.y, ry, canY), canX, canY, rx, ry };
}
function setPos(p: PhotoItem, t: Tile, u: number, v: number) {
  const { rx, ry } = getPos(p, t);
  const cl = (n: number) => Math.min(1, Math.max(0, n));
  p.pan = { x: (1 - rx) / 2 + cl(u) * Math.max(0, rx), y: (1 - ry) / 2 + cl(v) * Math.max(0, ry) };
}

/** いま見えている範囲の中心（0..1）と、その時の切り出し範囲 */
function currentView(p: PhotoItem, t: Tile) {
  const { bw, bh } = photoBox(p, t.w, t.h);
  const crop = cropFor(p, bw, bh, settings.smartCrop);
  return { crop, c: { x: (crop.sx + crop.sw / 2) / p.width, y: (crop.sy + crop.sh / 2) / p.height } };
}

// プレビュー全体の拡大（2本指・ホイール）
const VIEW_MAX = 5;
function clampViewOffset() {
  const box = stage.getBoundingClientRect();
  const r = { w: parseFloat(preview.style.width) || 0, h: parseFloat(preview.style.height) || 0 };
  const mx = Math.max(0, (r.w - box.width) / 2 + 16), my = Math.max(0, (r.h - box.height) / 2 + 16);
  stageView.x = Math.min(mx, Math.max(-mx, stageView.x));
  stageView.y = Math.min(my, Math.max(-my, stageView.y));
}
/** 画面上の点 (px, py) を固定したまま、全体の倍率を z にする */
function zoomStageAt(px: number, py: number, z: number) {
  z = Math.min(VIEW_MAX, Math.max(1, z));
  const box = stage.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  stageView.x = px - cx - ((px - cx - stageView.x) * z) / stageView.z;
  stageView.y = py - cy - ((py - cy - stageView.y) * z) / stageView.z;
  stageView.z = z;
  if (z === 1) stageView.x = stageView.y = 0;
}
function resetStageZoom() {
  stageView.z = 1;
  stageView.x = stageView.y = 0;
  render();
}
$('#zoomReset').addEventListener('click', resetStageZoom);

(() => {
  type Pointer = { x: number; y: number };
  const pts = new Map<number, Pointer>();
  let st: { tile: Tile; pid: number; x: number; y: number; active: boolean; timer: number } | null = null;
  let pinch: { d0: number; z0: number; mid0: Pointer; x0: number; y0: number; scale0: number } | null = null;
  const ghost = $('#ghost');

  const cancelDrag = () => {
    if (!st) return;
    clearTimeout(st.timer);
    st = null;
    ghost.hidden = true;
    document.body.classList.remove('dragging');
    if (dragState) {
      dragState = null;
      render();
    }
  };

  preview.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      preview.setPointerCapture(e.pointerId);
    } catch {
      /* 合成イベントなど */
    }
    // 2本目の指：プレビュー全体を拡大・移動
    if (pts.size === 2) {
      cancelDrag();
      const [a, b] = [...pts.values()];
      pinch = {
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        z0: stageView.z,
        mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        x0: stageView.x,
        y0: stageView.y,
        scale0: stageView.z,
      };
      return;
    }
    if (pts.size > 2 || pinch) return;
    const pt = toLayout(e);
    const t = tileAt(pt.x, pt.y);
    if (!t) {
      if (selectedId) select('');
      return;
    }
    st = { tile: t, pid: e.pointerId, x: e.clientX, y: e.clientY, active: false, timer: 0 };
    // 長押しで全画面表示
    st.timer = window.setTimeout(() => {
      if (!st || st.active || pinch) return;
      const p = list()[st.tile.idx];
      cancelDrag();
      if (p) openPhotoViewer(p);
    }, 550);
  });
  preview.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 指の中点を基準に拡大し、中点の移動で全体を動かす
      stageView.z = pinch.z0;
      stageView.x = pinch.x0;
      stageView.y = pinch.y0;
      zoomStageAt(pinch.mid0.x, pinch.mid0.y, pinch.z0 * (d / pinch.d0));
      stageView.x += mid.x - pinch.mid0.x;
      stageView.y += mid.y - pinch.mid0.y;
      // 操作中は描き直さず、CSS の拡大だけで追従する（指を離したら高画質で描き直す）
      applyStageTransform(stageView.z / pinch.scale0);
      return;
    }
    if (!st || e.pointerId !== st.pid) return;
    const dist = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (!st.active && dist < 8) return;
    clearTimeout(st.timer);
    const items = list();
    if (!st.active) {
      st.active = true;
      document.body.classList.add('dragging');
      ghost.querySelector('img')!.src = items[st.tile.idx]?.thumbUrl ?? '';
      ghost.hidden = false;
      dragState = { src: st.tile.idx, target: null };
    }
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
    const pt = toLayout(e);
    const t = tileAt(pt.x, pt.y);
    const target = t && t.idx !== st.tile.idx ? t.idx : null;
    if (dragState && dragState.target !== target) {
      dragState.target = target;
      render();
    }
  });
  const end = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size === 0) {
        pinch = null;
        render();
      }
      return;
    }
    if (!st || e.pointerId !== st.pid) return;
    clearTimeout(st.timer);
    const s = st;
    st = null;
    ghost.hidden = true;
    document.body.classList.remove('dragging');
    const items = list();
    if (!s.active) {
      if (e.type === 'pointerup') {
        const p = items[s.tile.idx];
        if (p) select(selectedId === p.id ? '' : p.id);
      }
      return;
    }
    if (dragState) {
      const { src, target } = dragState;
      dragState = null;
      if (target != null) {
        [items[src], items[target]] = [items[target], items[src]];
        gradActive = null;
        syncGradUI();
        if (!usingSamples()) renderList();
        else renderLayoutThumbs();
      }
      render();
    }
  };
  preview.addEventListener('pointerup', end);
  preview.addEventListener('pointercancel', end);
  preview.addEventListener('contextmenu', (e) => e.preventDefault());
  // ホイール（トラックパッドのピンチを含む）で全体を拡大
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // Ctrl＋ホイール（トラックパッドのピンチ）か、等倍のときは拡大。拡大中のスクロールは移動
      if (e.ctrlKey || stageView.z <= 1) zoomStageAt(e.clientX, e.clientY, stageView.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else {
        stageView.x -= e.deltaX;
        stageView.y -= e.deltaY;
      }
      render();
    },
    { passive: false },
  );
})();

// ---------- 全画面表示（長押し） ----------

const viewer = $('#viewer');
const viewerCanvas = $<HTMLCanvasElement>('#viewerCanvas');
let vw = { s: 1, x: 0, y: 0, fit: 1 };
function layoutViewer() {
  const W = viewer.clientWidth, H = viewer.clientHeight;
  const cw = viewerCanvas.width, ch = viewerCanvas.height;
  vw.fit = Math.min((W - 24) / cw, (H - 24) / ch);
  vw.s = vw.fit;
  vw.x = (W - cw * vw.s) / 2;
  vw.y = (H - ch * vw.s) / 2;
  applyViewer();
}
function applyViewer() {
  // 縮小しすぎ・はみ出しすぎを防ぐ
  const W = viewer.clientWidth, H = viewer.clientHeight;
  const cw = viewerCanvas.width * vw.s, ch = viewerCanvas.height * vw.s;
  vw.x = cw <= W ? (W - cw) / 2 : Math.min(0, Math.max(W - cw, vw.x));
  vw.y = ch <= H ? (H - ch) / 2 : Math.min(0, Math.max(H - ch, vw.y));
  viewerCanvas.style.transform = `translate(${vw.x}px, ${vw.y}px) scale(${vw.s})`;
}
function openViewer(src: CanvasImageSource & { width: number; height: number }, title: string) {
  viewerCanvas.width = src.width;
  viewerCanvas.height = src.height;
  viewerCanvas.getContext('2d')!.drawImage(src, 0, 0);
  $('#viewerTitle').textContent = title;
  viewer.hidden = false;
  document.body.classList.add('viewing');
  navigator.vibrate?.(10);
  layoutViewer();
}
function openPhotoViewer(p: PhotoItem) {
  openViewer(p.preview, p.name);
}
function openCollageViewer() {
  // プレビュー用の縮小画像から、長辺 2048px で全体を描く
  const items = list();
  const k = 2048 / Math.max(dims.W, dims.H);
  const c = document.createElement('canvas');
  c.width = Math.round(dims.W * k);
  c.height = Math.round(dims.H * k);
  drawScene(c.getContext('2d')!, {
    W: dims.W,
    H: dims.H,
    k,
    tiles: computeTiles(items),
    photos: items,
    settings,
    rounded: !!getLayout(settings.layout).rounded,
    image: previewImage,
  });
  openViewer(c, '全体');
  c.width = 0;
}
function closeViewer() {
  viewer.hidden = true;
  document.body.classList.remove('viewing');
  viewerCanvas.width = 0;
}
$('#viewerClose').addEventListener('click', closeViewer);
$('#fullBtn').addEventListener('click', openCollageViewer);
window.addEventListener('resize', () => !viewer.hidden && layoutViewer());
(() => {
  const vp = new Map<number, { x: number; y: number }>();
  let start: { s: number; x: number; y: number; d: number; mx: number; my: number } | null = null;
  let lastTap = 0;
  let moved = false;
  const snapshot = () => {
    const ps = [...vp.values()];
    const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length, my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    const d = ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
    start = { s: vw.s, x: vw.x, y: vw.y, d, mx, my };
  };
  viewer.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    viewer.setPointerCapture(e.pointerId);
    vp.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    snapshot();
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!vp.has(e.pointerId) || !start) return;
    vp.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...vp.values()];
    const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length, my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
    if (Math.hypot(mx - start.mx, my - start.my) > 6) moved = true;
    let s = start.s;
    if (ps.length > 1 && start.d) {
      s = Math.min(vw.fit * 8, Math.max(vw.fit, start.s * (Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) / start.d)));
      moved = true;
    }
    // 指の中点を基準に拡大
    vw.s = s;
    vw.x = mx - ((start.mx - start.x) / start.s) * s;
    vw.y = my - ((start.my - start.y) / start.s) * s;
    applyViewer();
  });
  const up = (e: PointerEvent) => {
    if (!vp.has(e.pointerId)) return;
    vp.delete(e.pointerId);
    if (vp.size) return snapshot();
    start = null;
    if (moved || e.type !== 'pointerup') return;
    // ダブルタップで拡大・元に戻す
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      const z = vw.s > vw.fit * 1.05 ? vw.fit : vw.fit * 2.5;
      vw.x = e.clientX - ((e.clientX - vw.x) / vw.s) * z;
      vw.y = e.clientY - ((e.clientY - vw.y) / vw.s) * z;
      vw.s = z;
      applyViewer();
    } else lastTap = now;
  };
  viewer.addEventListener('pointerup', up);
  viewer.addEventListener('pointercancel', up);
  viewer.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const z = Math.min(vw.fit * 8, Math.max(vw.fit, vw.s * Math.exp(-e.deltaY * 0.002)));
      vw.x = e.clientX - ((e.clientX - vw.x) / vw.s) * z;
      vw.y = e.clientY - ((e.clientY - vw.y) / vw.s) * z;
      vw.s = z;
      applyViewer();
    },
    { passive: false },
  );
})();


// ---------- 写真の調整（サイズ・回転・位置） ----------

/** 選択中の写真と、それが入っているタイル */
function selectedTile(): { p: PhotoItem; t: Tile } | null {
  const items = list();
  const i = items.findIndex((p) => p.id === selectedId);
  const t = tiles.find((x) => x.idx === i);
  return i >= 0 && t ? { p: items[i], t } : null;
}

function renderAdjPanel() {
  const p = selected();
  $('#adjEmpty').hidden = !!p;
  $('#adjBody').hidden = !p;
  if (!p) return;
  $<HTMLImageElement>('#adjThumb').src = p.thumbUrl;
  $('#adjName').textContent = p.name;
  $<HTMLInputElement>('#adjZoom').value = String(p.zoom);
  $('#adjZoomOut').textContent = `${Math.round(p.zoom * 100)}%`;
  $<HTMLInputElement>('#adjAngle').value = String(p.angle);
  $('#adjAngleOut').textContent = `${p.angle > 0 ? '+' : ''}${p.angle}°`;
  const st = selectedTile();
  const pos = st ? getPos(st.p, st.t) : { u: 0.5, v: 0.5, canX: false, canY: false };
  const ax = $<HTMLInputElement>('#adjX'), ay = $<HTMLInputElement>('#adjY');
  ax.value = String(pos.u);
  ay.value = String(pos.v);
  ax.disabled = !pos.canX;
  ay.disabled = !pos.canY;
  // トラックパッドの点：動かせる範囲の中で、いまどこにいるか
  const dot = $('#tpDot');
  dot.style.left = `${pos.u * 100}%`;
  dot.style.top = `${pos.v * 100}%`;
  const msg = pos.canX && pos.canY
    ? 'なぞって位置を調整'
    : pos.canX
      ? '左右に動かせます（上下はサイズを上げると動かせます）'
      : pos.canY
        ? '上下に動かせます（左右はサイズを上げると動かせます）'
        : 'サイズを上げると動かせます';
  $('#tpHint').textContent = msg;
  $('#trackpad').classList.toggle('lock-x', !pos.canX);
  $('#trackpad').classList.toggle('lock-y', !pos.canY);
}

$('#adjZoom').addEventListener('input', () => {
  const st = selectedTile();
  if (!st) return;
  const { p, t } = st;
  const c = currentView(p, t).c;
  const v = clampView(p, t, c.x, c.y, Number($<HTMLInputElement>('#adjZoom').value));
  p.zoom = v.z;
  p.pan = { x: v.x, y: v.y };
  renderAdjPanel();
  render();
});
$('#adjAngle').addEventListener('input', () => {
  const st = selectedTile();
  if (!st) return;
  const { p, t } = st;
  let a = Number($<HTMLInputElement>('#adjAngle').value);
  // 0°・±90°・±180° の近くでは吸着
  for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(a - s) <= 2) a = s;
  const c = currentView(p, t).c;
  p.angle = a;
  const v = clampView(p, t, c.x, c.y, p.zoom);
  p.pan = { x: v.x, y: v.y };
  renderAdjPanel();
  render();
});
for (const axis of ['X', 'Y'] as const) {
  $(`#adj${axis}`).addEventListener('input', () => {
    const st = selectedTile();
    if (!st) return;
    const { p, t } = st;
    const pos = getPos(p, t);
    const v = Number($<HTMLInputElement>(`#adj${axis}`).value);
    setPos(p, t, axis === 'X' ? v : pos.u, axis === 'Y' ? v : pos.v);
    renderAdjPanel();
    render();
  });
}
$('#adjReset').addEventListener('click', () => {
  const p = selected();
  if (!p) return;
  p.pan = null;
  p.zoom = 1;
  p.angle = 0;
  renderAdjPanel();
  render();
});
$('#adjView').addEventListener('click', () => {
  const p = selected();
  if (p) openPhotoViewer(p);
});
$$('[data-step]').forEach((b) =>
  b.addEventListener('click', () => {
    const el = $<HTMLInputElement>(`#${b.dataset.for}`);
    el.value = String(Number(el.value) + Number(b.dataset.step));
    el.dispatchEvent(new Event('input'));
  }),
);

// トラックパッド（スマホ）：点が指の動きに付いていく。サイズは変えない
/** 指の移動量に対する点の移動量（1 未満で細かく動かせる） */
const PAD_GAIN = 0.4;
(() => {
  const pad = $('#trackpad');
  let st: { pid: number; x: number; y: number; u: number; v: number } | null = null;
  pad.addEventListener('pointerdown', (e) => {
    const s = selectedTile();
    if (!s) return;
    try {
      pad.setPointerCapture(e.pointerId);
    } catch {
      /* 合成イベントなど */
    }
    const pos = getPos(s.p, s.t);
    st = { pid: e.pointerId, x: e.clientX, y: e.clientY, u: pos.u, v: pos.v };
    pad.classList.add('active');
  });
  pad.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const s = selectedTile();
    if (!s) return;
    const r = pad.getBoundingClientRect();
    // 指と同じ向きへ、指の移動の PAD_GAIN 倍だけ点が動く（端まで行ったら指の基準を付け直す）
    let u = st.u + ((e.clientX - st.x) / r.width) * PAD_GAIN;
    let v = st.v + ((e.clientY - st.y) / r.height) * PAD_GAIN;
    if (u < 0 || u > 1) {
      u = Math.min(1, Math.max(0, u));
      st.u = u;
      st.x = e.clientX;
    }
    if (v < 0 || v > 1) {
      v = Math.min(1, Math.max(0, v));
      st.v = v;
      st.y = e.clientY;
    }
    setPos(s.p, s.t, u, v);
    renderAdjPanel();
    render();
  });
  const end = (e: PointerEvent) => {
    if (!st || e.pointerId !== st.pid) return;
    st = null;
    pad.classList.remove('active');
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
})();

// ---------- 写真の追加 ----------

async function addFiles(files: FileList | File[]) {
  const arr = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name));
  if (!arr.length) return;
  const room = MAX_PHOTOS - photos.length;
  if (room <= 0) {
    toast(`追加できるのは最大${MAX_PHOTOS}枚までです`);
    return;
  }
  const take = arr.slice(0, room);
  const busy = $('#busy');
  busy.hidden = false;
  const errors: string[] = [];
  let ok = 0;
  for (const [i, f] of take.entries()) {
    busy.textContent = `読み込み中… ${i + 1}/${take.length}`;
    try {
      const p = await loadPhoto(f);
      photos.push(p);
      ok++;
      if (ok === 1 || i === take.length - 1 || i % 3 === 2) {
        renderList();
        render();
      }
    } catch {
      errors.push(f.name);
    }
  }
  busy.hidden = true;
  renderList();
  render();
  let msg = '';
  if (ok) msg += `${ok}枚読み込みました`;
  if (arr.length > take.length) msg += `${msg ? '\n' : ''}最大${MAX_PHOTOS}枚のため ${arr.length - take.length}枚は追加しませんでした`;
  if (errors.length) msg += `${msg ? '\n' : ''}${errors.length}枚読み込めませんでした（${errors.slice(0, 2).join('、')}）`;
  if (msg) toast(msg, errors.length ? 6000 : 3000);
}

const fileInput = $<HTMLInputElement>('#file');
fileInput.accept = IS_NATIVE ? '' : ACCEPT; // Androidアプリでは拡張子指定が効かないため全ファイルを許可
fileInput.addEventListener('change', () => {
  if (fileInput.files) addFiles(fileInput.files);
  fileInput.value = '';
});
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && (e as DragEvent).relatedTarget) return;
    drop.classList.remove('over');
  }),
);
document.addEventListener('drop', (e) => {
  const fs = (e as DragEvent).dataTransfer?.files;
  if (fs?.length) addFiles(fs);
});
$('#clear').addEventListener('click', () => {
  if (!photos.length || !confirm('すべての写真を削除しますか？')) return;
  photos = [];
  selectedId = '';
  renderList();
  renderSelPanel();
  render();
});

// ---------- 並べ替え ----------

const COMP_ORDER: (CompType | 'none')[] = ['center', 'symmetry', 'thirds', 'golden', 'diagonal', 'horizon', 'none'];

function sortBy(kind: string) {
  const items = list();
  gradActive = null;
  switch (kind) {
    case 'comp':
      items.sort((a, b) => COMP_ORDER.indexOf(effectiveComp(a)) - COMP_ORDER.indexOf(effectiveComp(b)) || b.comp.score - a.comp.score);
      break;
    case 'date':
      items.sort((a, b) => a.date - b.date);
      break;
    case 'name':
      items.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
      break;
    case 'shuffle':
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      break;
    case 'reverse':
      items.reverse();
      break;
  }
  syncGradUI();
  renderList();
  render();
}
$$('#sorts button').forEach((b) => b.addEventListener('click', () => sortBy(b.dataset.sort!)));

// ---------- グラデーション配置 ----------
// 写真を色や明るさの順に並べ、画面上の位置（方向）の順に割り当てる。
// レイアウトによってタイルの番号と位置の関係はばらばらなので、位置で割り当てることで見た目がグラデーションになる。

type GradKey = Settings['gradKey'];
type GradDir = Settings['gradDir'];
/** 適用中のグラデーション（手で並べ替えると解除） */
let gradActive: { key: GradKey; dir: GradDir; rev: boolean } | null = null;
let gradSig = '';

function colorOrder(items: PhotoItem[], key: GradKey): PhotoItem[] {
  const lum = (p: PhotoItem) => p.stats.lum;
  switch (key) {
    case 'bright':
      return [...items].sort((a, b) => lum(b) - lum(a));
    case 'sat':
      return [...items].sort((a, b) => b.stats.sat - a.stats.sat || lum(b) - lum(a));
    case 'hue': {
      // 色みのある写真を色相順に。色相環のいちばん大きな切れ目から始めて、虹がつながるように
      const chroma = items.filter((p) => p.stats.sat >= 0.08);
      const gray = items.filter((p) => p.stats.sat < 0.08).sort((a, b) => lum(b) - lum(a));
      chroma.sort((a, b) => a.stats.hue - b.stats.hue);
      let cut = 0, gap = -1;
      for (let i = 0; i < chroma.length; i++) {
        const h1 = chroma[i].stats.hue, h0 = chroma[(i + chroma.length - 1) % chroma.length].stats.hue;
        const g = chroma.length === 1 ? 360 : (h1 - h0 + 360) % 360;
        if (g > gap) {
          gap = g;
          cut = i;
        }
      }
      return [...chroma.slice(cut), ...chroma.slice(0, cut), ...gray];
    }
    case 'tone': {
      // 平均色の近いものを順につなぐ（いちばん明るい写真から出発）
      const rest = [...items].sort((a, b) => lum(b) - lum(a));
      const out = [rest.shift()!];
      const dist = (a: PhotoItem, b: PhotoItem) => {
        const [h1, s1, l1] = rgbToHsl(...a.stats.avg);
        const [h2, s2, l2] = rgbToHsl(...b.stats.avg);
        const dh = Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2)) / 180;
        return dh * Math.min(s1, s2) * 1.5 + Math.abs(s1 - s2) * 0.6 + Math.abs(l1 - l2) * 1.2;
      };
      while (rest.length) {
        const last = out[out.length - 1];
        let bi = 0;
        for (let i = 1; i < rest.length; i++) if (dist(last, rest[i]) < dist(last, rest[bi])) bi = i;
        out.push(rest.splice(bi, 1)[0]);
      }
      return out;
    }
  }
}

/** タイルの位置を、選んだ方向に沿った値にする（小さいほど始点側） */
function along(t: Tile, dir: GradDir) {
  const u = t.cx / dims.W, v = t.cy / dims.H;
  switch (dir) {
    case 'lr':
      return u + v * 0.08;
    case 'tb':
      return v + u * 0.08;
    case 'tlbr':
      return u + v;
    case 'bltr':
      return u + (1 - v);
    case 'radial':
      return Math.hypot((u - 0.5) * dims.W, (v - 0.5) * dims.H) / Math.max(dims.W, dims.H);
  }
}

/** 配置が変わる設定のまとめ（変わったらグラデーションを掛け直す） */
function layoutSig() {
  return [settings.layout, settings.aspect, settings.columns, settings.seed, settings.gap, settings.margin, settings.slant, list().length].join('|');
}

function applyGradient() {
  gradSig = layoutSig();
  if (!gradActive) return;
  const items = list();
  if (items.length < 2) return;
  const { key, dir, rev } = gradActive;
  let order = colorOrder(items, key);
  if (rev) order = order.reverse();
  // タイルの形は写真の比率で変わることがあるので、落ち着くまで数回くり返す
  for (let pass = 0; pass < 4; pass++) {
    const ts = computeTiles(items);
    const slots = [...ts].sort((a, b) => along(a, dir) - along(b, dir));
    const next: PhotoItem[] = new Array(items.length);
    slots.forEach((t, i) => (next[t.idx] = order[i]));
    const same = next.every((p, i) => p === items[i]);
    items.splice(0, items.length, ...next);
    if (same) break;
  }
}

function setGradient(key: GradKey, dir: GradDir, rev: boolean) {
  settings.gradKey = key;
  settings.gradDir = dir;
  settings.gradRev = rev;
  saveSettings();
  gradActive = { key, dir, rev };
  applyGradient();
  syncGradUI();
  if (!usingSamples()) renderList();
  else renderLayoutThumbs();
  render();
}
function syncGradUI() {
  $$('#gradKey button').forEach((b) => b.classList.toggle('active', !!gradActive && b.dataset.key === settings.gradKey));
  $$('#gradDir button').forEach((b) => b.classList.toggle('active', b.dataset.dir === settings.gradDir));
  $('#gradRev').classList.toggle('active', settings.gradRev);
  $('#gradHint').textContent = gradActive
    ? 'グラデーションで配置しています。写真を手で入れ替えると解除されます。'
    : '基準を選ぶと、画面全体がグラデーションになるように写真を配置します。';
}
$$('#gradKey button').forEach((b) => b.addEventListener('click', () => setGradient(b.dataset.key as GradKey, settings.gradDir, settings.gradRev)));
$$('#gradDir button').forEach((b) => b.addEventListener('click', () => setGradient(settings.gradKey, b.dataset.dir as GradDir, settings.gradRev)));
$('#gradRev').addEventListener('click', () => setGradient(settings.gradKey, settings.gradDir, !settings.gradRev));

/** タイルの縦横比と写真の縦横比が合うように割り当て直す */
function autoFit() {
  const items = list();
  if (items.length < 2) return;
  gradActive = null;
  syncGradUI();
  for (let pass = 0; pass < 3; pass++) {
    const ts = computeTiles(items);
    const slots = ts.map((t) => ({ idx: t.idx, a: t.w / t.h, area: t.w * t.h }));
    // 面積の大きいタイルほど、構図がはっきりした写真を優先
    const bySlot = [...slots].sort((a, b) => a.a - b.a);
    const byPhoto = [...items].sort((a, b) => a.width / a.height - b.width / b.height);
    const next: PhotoItem[] = new Array(items.length);
    bySlot.forEach((s, i) => (next[s.idx] = byPhoto[i]));
    // 同じ比率の写真同士は、元の順番を保つ
    const same = next.every((p, i) => p === items[i]);
    items.splice(0, items.length, ...next);
    if (same) break;
  }
  renderList();
  render();
  toast('タイルの形に合わせて並べ直しました');
}
$('#autoFit').addEventListener('click', autoFit);

// ---------- 選択中の写真 ----------

function renderSelPanel() {
  const p = selected();
  $('#selEmpty').hidden = !!p;
  $('#selBody').hidden = !p;
  if (!p) return;
  $<HTMLImageElement>('#selThumb').src = p.thumbUrl;
  $('#selName').textContent = p.name;
  const auto = COMP_LABELS[p.comp.type];
  const pct = Math.round(p.comp.score * 100);
  $('#selComp').innerHTML = `${auto}<small>検出の確かさ ${pct}%</small>`;
  $('#selColors').innerHTML = p.stats.palette.map((c) => `<i style="background:${c}"></i>`).join('');
  $<HTMLSelectElement>('#selType').value = p.compOverride ?? 'auto';
}
$('#selType').addEventListener('change', () => {
  const p = selected();
  if (!p) return;
  const v = $<HTMLSelectElement>('#selType').value;
  p.compOverride = v === 'auto' ? null : (v as CompType | 'none');
  if (!usingSamples()) renderList();
  render();
});
$('#selDelete').addEventListener('click', () => {
  const p = selected();
  if (!p) return;
  if (usingSamples()) return toast('サンプルは削除できません。写真を追加すると置き換わります');
  removePhoto(p.id);
});

// ---------- コントロール ----------

const OVERLAY_HINTS: Record<OverlayMode, string> = {
  none: '写真ごとに検出した構図を、図形としてタイルに組み込めます。',
  guide: '検出した構図の補助線（円・三分割線・黄金分割線・対角線など）を細く重ねます。',
  accent: '構図の要となる線と点を太く描き、デザインのアクセントにします。',
  cutout: '構図の形（円・長方形・三角・半円・アーチ）の窓で写真を切り抜きます。',
};

const BG_BASE = ['#ffffff', '#f3f2ef', '#e9e7e2', '#1d1d1f', '#000000', '#e8792b'];
const OV_COLORS = ['#ffffff', '#1d1d1f', '#e8792b', '#f4d35e', '#4a90e2'];

function swatch(color: string, active: boolean, onPick: () => void) {
  const b = document.createElement('button');
  b.className = 'swatch' + (active ? ' active' : '');
  b.style.background = color;
  b.title = color;
  b.setAttribute('aria-label', color);
  b.addEventListener('click', onPick);
  return b;
}

function renderBgSwatches() {
  const base = $('#bgBase');
  base.innerHTML = '';
  for (const c of BG_BASE) base.appendChild(swatch(c, settings.bg === c, () => setBg(c)));
  const ph = $('#bgPhoto');
  ph.innerHTML = '';
  if (photos.length) {
    // 写真の主要色から、互いに離れた色を最大8色
    const cands = photos.flatMap((p) => p.stats.palette.slice(0, 2));
    const picked: string[] = [];
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    for (const c of cands) {
      const a = rgb(c);
      if (picked.every((q) => Math.hypot(...rgb(q).map((v, i) => v - a[i])) > 48)) picked.push(c);
      if (picked.length >= 8) break;
    }
    for (const c of picked) ph.appendChild(swatch(c, settings.bg === c, () => setBg(c)));
  }
  $<HTMLInputElement>('#bgCustom').value = settings.bg;
}
function setBg(c: string) {
  settings.bg = c;
  saveSettings();
  renderBgSwatches();
  render();
  renderLayoutThumbs();
}
$('#bgCustom').addEventListener('input', () => setBg($<HTMLInputElement>('#bgCustom').value));

function renderOvSwatches() {
  const host = $('#ovSwatches');
  host.innerHTML = '';
  for (const c of OV_COLORS)
    host.appendChild(
      swatch(c, settings.overlayColor === c, () => {
        settings.overlayColor = c;
        saveSettings();
        renderOvSwatches();
        render();
      }),
    );
}

type RangeKey = 'columns' | 'slant' | 'gap' | 'margin' | 'radius' | 'quality';
const fmt: Record<RangeKey, (v: number) => string> = {
  columns: (v) => (v ? `${v}列` : '自動'),
  slant: (v) => (v ? `${v}°` : 'なし'),
  gap: (v) => String(v),
  margin: (v) => String(v),
  radius: (v) => String(v),
  quality: (v) => `${Math.round(v * 100)}`,
};

function syncControls() {
  const def = getLayout(settings.layout);
  $$('#layouts .preset').forEach((b) => b.classList.toggle('active', b.dataset.layout === settings.layout));
  $<HTMLSelectElement>('#aspect').value = settings.aspect;
  for (const key of Object.keys(fmt) as RangeKey[]) {
    $<HTMLInputElement>(`#${key}`).value = String(settings[key]);
    $(`#${key}Out`).textContent = fmt[key](settings[key]);
  }
  $('#columnsField').hidden = !def.usesColumns;
  $('#slantField').hidden = !def.slantable;
  $('#radiusField').hidden = !def.rounded;
  $<HTMLButtonElement>('#reseed').hidden = !def.usesSeed;
  $$('#overlaySeg button').forEach((b) => b.classList.toggle('active', b.dataset.ov === settings.overlay));
  $('#overlayHint').textContent = OVERLAY_HINTS[settings.overlay];
  $<HTMLInputElement>('#showLabel').checked = settings.showLabel;
  $<HTMLInputElement>('#smartCrop').checked = settings.smartCrop;
  $<HTMLSelectElement>('#format').value = settings.format;
  $<HTMLSelectElement>('#outEdge').value = String(settings.outEdge);
  $('#qualityField').hidden = settings.format === 'image/png';
}

for (const key of Object.keys(fmt) as RangeKey[]) {
  const el = $<HTMLInputElement>(`#${key}`);
  el.addEventListener('input', () => {
    (settings as any)[key] = Number(el.value);
    $(`#${key}Out`).textContent = fmt[key](settings[key]);
    saveSettings();
    render();
    if (key !== 'quality') renderLayoutThumbs();
  });
}
$('#aspect').addEventListener('change', () => {
  settings.aspect = $<HTMLSelectElement>('#aspect').value;
  saveSettings();
  render();
  renderLayoutThumbs();
});
$('#reseed').addEventListener('click', () => {
  settings.seed = (settings.seed % 9973) + 1 + Math.floor(Math.random() * 50);
  saveSettings();
  render();
  renderLayoutThumbs();
});
$$('#overlaySeg button').forEach((b) =>
  b.addEventListener('click', () => {
    settings.overlay = b.dataset.ov as OverlayMode;
    saveSettings();
    syncControls();
    render();
  }),
);
$('#showLabel').addEventListener('change', () => {
  settings.showLabel = $<HTMLInputElement>('#showLabel').checked;
  saveSettings();
  render();
});
$('#smartCrop').addEventListener('change', () => {
  settings.smartCrop = $<HTMLInputElement>('#smartCrop').checked;
  saveSettings();
  render();
});
$('#format').addEventListener('change', () => {
  settings.format = $<HTMLSelectElement>('#format').value as Settings['format'];
  saveSettings();
  syncControls();
});
$('#outEdge').addEventListener('change', () => {
  settings.outEdge = Number($<HTMLSelectElement>('#outEdge').value);
  saveSettings();
  render();
});

// タブ（スマホ）
$$('#tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    document.body.dataset.tab = b.dataset.tab!;
    if (b.dataset.tab === 'adjust' && !selected() && list().length) select(list()[0].id);
    $$('#tabbar button').forEach((x) => x.classList.toggle('active', x === b));
    $('.panel.right').scrollTop = 0;
  }),
);

// 写真ストリップの開閉（スマホ）
const stripToggle = $('#stripToggle');
function refreshStripToggle() {
  const hidden = document.body.classList.contains('strip-hidden');
  stripToggle.innerHTML = hidden ? '<b>▴</b>写真の一覧を表示' : '<b>▾</b>隠す';
  stripToggle.setAttribute('aria-expanded', String(!hidden));
}
stripToggle.addEventListener('click', () => {
  document.body.classList.toggle('strip-hidden');
  refreshStripToggle();
  render();
});
refreshStripToggle();

// ---------- 書き出し ----------

let lastBlob: Blob | null = null;
let lastName = '';

function fileName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = settings.format === 'image/png' ? 'png' : settings.format === 'image/webp' ? 'webp' : 'jpg';
  return `photo-tile-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

async function exportImage(): Promise<Blob> {
  const items = list();
  const ts = computeTiles(items);
  const k = settings.outEdge / 1000;
  const out = document.createElement('canvas');
  out.width = Math.round(dims.W * k);
  out.height = Math.round(dims.H * k);
  // 各タイルの大きさに合わせて、元写真から必要な解像度だけ切り出す（1枚ずつ）
  const cache = new Map<Tile, HTMLCanvasElement>();
  const progress = $('#progress');
  for (const [i, t] of ts.entries()) {
    progress.textContent = `写真を配置中… ${i + 1}/${ts.length}`;
    const p = items[t.idx];
    const { bw, bh } = photoBox(p, t.w, t.h);
    const crop = cropFor(p, bw, bh, settings.smartCrop);
    const dw = Math.min(Math.ceil(bw * k), Math.ceil(crop.sw));
    const dh = Math.min(Math.ceil(bh * k), Math.ceil(crop.sh));
    // 元より大きくは引き伸ばさない（描画時に拡大される）
    const scale = Math.min(1, Math.max(dw / (bw * k), dh / (bh * k)));
    cache.set(t, await extractRegion(p, crop.sx, crop.sy, crop.sw, crop.sh, Math.max(1, bw * k * scale), Math.max(1, bh * k * scale)));
  }
  progress.textContent = '画像を書き出し中…';
  drawScene(out.getContext('2d')!, {
    W: dims.W,
    H: dims.H,
    k,
    tiles: ts,
    photos: items,
    settings,
    rounded: !!getLayout(settings.layout).rounded,
    image: (t) => {
      const c = cache.get(t)!;
      return { img: c, crop: { sx: 0, sy: 0, sw: c.width, sh: c.height } };
    },
  });
  for (const c of cache.values()) c.width = 0;
  const blob = await canvasToBlob(out, settings.format, settings.quality);
  out.width = 0;
  return blob;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const canShareFiles = () => {
  try {
    return !!navigator.canShare?.({ files: [new File([new Blob()], 'x.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
};

$('#save').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('#save');
  btn.disabled = true;
  const busy = $('#busy');
  busy.hidden = false;
  busy.textContent = '書き出し中…';
  try {
    lastBlob = await exportImage();
    lastName = fileName();
    const o = outSize();
    $('#progress').textContent = `${o.w}×${o.h}px ・ ${(lastBlob.size / 1024 / 1024).toFixed(1)}MB`;
    const isTouch = matchMedia('(pointer: coarse)').matches;
    if (IS_NATIVE || ((IS_IOS || isTouch) && canShareFiles())) {
      $('#shareDesc').textContent = `${o.w}×${o.h}px の画像を作成しました。`;
      $('#shareSheet').hidden = false;
    } else {
      download(lastBlob, lastName);
    }
  } catch (err) {
    console.error(err);
    toast('書き出しに失敗しました。長辺のサイズを小さくして再度お試しください', 5000);
    $('#progress').textContent = '';
  } finally {
    btn.disabled = false;
    busy.hidden = true;
  }
});
$('#shareBtn').addEventListener('click', async () => {
  if (!lastBlob) return;
  try {
    const file = new File([lastBlob], lastName, { type: lastBlob.type });
    if (IS_NATIVE) await nativeShare([file]);
    else await navigator.share({ files: [file] });
    $('#shareSheet').hidden = true;
  } catch {
    /* キャンセル */
  }
});
$('#shareDl').addEventListener('click', async () => {
  $('#shareSheet').hidden = true;
  if (!lastBlob) return;
  if (!IS_NATIVE) return download(lastBlob, lastName);
  try {
    const dir = await nativeSave([new File([lastBlob], lastName, { type: lastBlob.type })]);
    toast(`${dir} に保存しました`);
  } catch {
    toast('保存できませんでした。「保存・共有」からお試しください', 5000);
  }
});
if (IS_NATIVE) {
  document.body.classList.add('native');
  $('#shareBtn').textContent = '保存・共有（ギャラリー / Googleフォトなど）';
  $('#shareDl').textContent = '端末の Documents フォルダに保存';
}
// Androidの「戻る」ボタン：開いているシートを閉じる。何も無ければアプリを終了
onBackButton(() => {
  if (!viewer.hidden) {
    closeViewer();
    return true;
  }
  const open = $$('.sheet-backdrop').find((s) => !s.hidden);
  if (open) {
    open.hidden = true;
    return true;
  }
  return false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewer.hidden) closeViewer();
});
$('#shareClose').addEventListener('click', () => ($('#shareSheet').hidden = true));
$('#aboutBtn').addEventListener('click', () => ($('#aboutSheet').hidden = false));
$('#aboutClose').addEventListener('click', () => ($('#aboutSheet').hidden = true));
$$('.sheet-backdrop').forEach((s) => s.addEventListener('click', (e) => e.target === s && (s.hidden = true)));

// ---------- 起動 ----------

buildLayoutButtons();
syncControls();
syncGradUI();
renderOvSwatches();
renderList();
renderSelPanel();
renderAdjPanel();
render();

if (!IS_NATIVE && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
