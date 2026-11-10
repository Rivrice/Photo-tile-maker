import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './style.css';
import { COMP_LABELS, rgbToHsl } from './analyze';
import { LAYOUTS, getLayout, pointInTile } from './layouts';
import { ACCEPT, MAX_PHOTOS, extractRegion, loadPhoto, makeSamples } from './photos';
import { IS_IOS, canvasToBlob, cropFor, drawScene, effectiveComp, type Crop } from './render';
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
type Mode = 'swap' | 'pan';
let mode: Mode = 'swap';

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
  tiles = computeTiles(items);
  const box = stage.getBoundingClientRect();
  const pad = 2;
  const availW = Math.max(50, box.width - pad * 2 - parseFloat(getComputedStyle(stage).paddingLeft) * 2);
  const availH = Math.max(50, box.height - pad * 2 - parseFloat(getComputedStyle(stage).paddingTop) * 2);
  const cssScale = Math.min(availW / dims.W, availH / dims.H);
  const cssW = dims.W * cssScale, cssH = dims.H * cssScale;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const k = cssScale * dpr;
  preview.width = Math.round(dims.W * k);
  preview.height = Math.round(dims.H * k);
  preview.style.width = `${cssW}px`;
  preview.style.height = `${cssH}px`;
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
  const def = getLayout(settings.layout);
  const out = outSize();
  $('#meta').textContent = usingSamples()
    ? `サンプル表示中 ・ 写真を追加するとここに並びます（最大${MAX_PHOTOS}枚）`
    : `${items.length}枚 ・ ${def.name} ・ 書き出し ${out.w}×${out.h}px`;
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

// ---------- プレビュー上の操作（入れ替え・位置調整） ----------

function toLayout(e: PointerEvent | WheelEvent) {
  const r = preview.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * dims.W, y: ((e.clientY - r.top) / r.height) * dims.H };
}
function tileAt(x: number, y: number): Tile | null {
  for (let i = tiles.length - 1; i >= 0; i--) if (pointInTile(tiles[i], x, y)) return tiles[i];
  return null;
}

(() => {
  let st: {
    tile: Tile;
    pid: number;
    x: number;
    y: number;
    active: boolean;
    startPan?: { x: number; y: number };
    crop?: Crop;
  } | null = null;
  const ghost = $('#ghost');

  preview.addEventListener('pointerdown', (e) => {
    const pt = toLayout(e);
    const t = tileAt(pt.x, pt.y);
    if (!t) {
      if (selectedId) select('');
      return;
    }
    preview.setPointerCapture(e.pointerId);
    st = { tile: t, pid: e.pointerId, x: e.clientX, y: e.clientY, active: false };
    if (mode === 'pan') {
      const p = list()[t.idx];
      const crop = cropFor(p, t.w, t.h, settings.smartCrop);
      st.crop = crop;
      st.startPan = { x: (crop.sx + crop.sw / 2) / p.width, y: (crop.sy + crop.sh / 2) / p.height };
      if (p.id !== selectedId) select(p.id);
    }
  });
  preview.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return;
    const dist = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (!st.active && dist < 6) return;
    const items = list();
    if (mode === 'pan') {
      st.active = true;
      const p = items[st.tile.idx];
      const r = preview.getBoundingClientRect();
      const du = ((e.clientX - st.x) / r.width) * dims.W; // レイアウト単位
      const dv = ((e.clientY - st.y) / r.height) * dims.H;
      const c = st.crop!;
      p.pan = {
        x: st.startPan!.x - (du / st.tile.w) * (c.sw / p.width),
        y: st.startPan!.y - (dv / st.tile.h) * (c.sh / p.height),
      };
      render();
      return;
    }
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
    if (!st || e.pointerId !== st.pid) return;
    const s = st;
    st = null;
    ghost.hidden = true;
    document.body.classList.remove('dragging');
    const items = list();
    if (!s.active) {
      if (e.type === 'pointerup') {
        const p = items[s.tile.idx];
        if (p) select(selectedId === p.id && mode === 'swap' ? '' : p.id);
      }
      return;
    }
    if (mode === 'swap' && dragState) {
      const { src, target } = dragState;
      dragState = null;
      if (target != null) {
        [items[src], items[target]] = [items[target], items[src]];
        if (!usingSamples()) renderList();
        else renderLayoutThumbs();
      }
      render();
    }
  };
  preview.addEventListener('pointerup', end);
  preview.addEventListener('pointercancel', end);
  preview.addEventListener('contextmenu', (e) => e.preventDefault());
  // ホイールでズーム（位置調整モード）
  preview.addEventListener(
    'wheel',
    (e) => {
      if (mode !== 'pan') return;
      const pt = toLayout(e);
      const t = tileAt(pt.x, pt.y);
      if (!t) return;
      e.preventDefault();
      const p = list()[t.idx];
      p.zoom = Math.min(3, Math.max(1, p.zoom * Math.exp(-e.deltaY * 0.0015)));
      if (p.id !== selectedId) select(p.id);
      else renderSelPanel();
      render();
    },
    { passive: false },
  );
})();

$$('#modeSeg button').forEach((b) =>
  b.addEventListener('click', () => {
    mode = b.dataset.mode as Mode;
    $$('#modeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    document.body.classList.toggle('mode-pan', mode === 'pan');
    toast(mode === 'pan' ? '写真をドラッグしてトリミング位置を調整できます' : '写真をドラッグして別の写真の上で離すと入れ替わります', 2400);
  }),
);

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
fileInput.accept = ACCEPT;
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
  const lum = (p: PhotoItem) => p.stats.lum;
  // 無彩色に近い写真は色相順の最後に（明るさ順）
  const hueKey = (p: PhotoItem) => (p.stats.sat < 0.08 ? 1000 + (1 - p.stats.lum) * 100 : (p.stats.hue + 340) % 360);
  switch (kind) {
    case 'bright':
      items.sort((a, b) => lum(b) - lum(a));
      break;
    case 'dark':
      items.sort((a, b) => lum(a) - lum(b));
      break;
    case 'hue':
      items.sort((a, b) => hueKey(a) - hueKey(b));
      break;
    case 'sat':
      items.sort((a, b) => b.stats.sat - a.stats.sat);
      break;
    case 'tone': {
      // 平均色の近いものを順につなぐ（最も明るい写真から出発）
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
      items.splice(0, items.length, ...out);
      break;
    }
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
  renderList();
  render();
}
$$('#sorts button').forEach((b) => b.addEventListener('click', () => sortBy(b.dataset.sort!)));

/** タイルの縦横比と写真の縦横比が合うように割り当て直す */
function autoFit() {
  const items = list();
  if (items.length < 2) return;
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
  $<HTMLInputElement>('#selZoom').value = String(p.zoom);
  $('#selZoomOut').textContent = `${p.zoom.toFixed(2)}×`;
}
$('#selType').addEventListener('change', () => {
  const p = selected();
  if (!p) return;
  const v = $<HTMLSelectElement>('#selType').value;
  p.compOverride = v === 'auto' ? null : (v as CompType | 'none');
  if (!usingSamples()) renderList();
  render();
});
$('#selZoom').addEventListener('input', () => {
  const p = selected();
  if (!p) return;
  p.zoom = Number($<HTMLInputElement>('#selZoom').value);
  $('#selZoomOut').textContent = `${p.zoom.toFixed(2)}×`;
  render();
});
$('#selReset').addEventListener('click', () => {
  const p = selected();
  if (!p) return;
  p.pan = null;
  p.zoom = 1;
  renderSelPanel();
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
  none: '写真ごとに検出した構図を、タイルの中に図形として組み込めます。',
  guide: '検出した構図の補助線（円・三分割線・黄金スパイラル・対角線など）を細く重ねます。',
  accent: '構図の形を太いラインで描き、デザインのアクセントにします。',
  cutout: '構図の形（円・スパイラル・三角・アーチなど）で写真を切り抜きます。',
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
    const crop = cropFor(p, t.w, t.h, settings.smartCrop);
    const dw = Math.min(Math.ceil(t.w * k), Math.ceil(crop.sw));
    const dh = Math.min(Math.ceil(t.h * k), Math.ceil(crop.sh));
    // 元より大きくは引き伸ばさない（描画時に拡大される）
    const scale = Math.min(1, Math.max(dw / (t.w * k), dh / (t.h * k)));
    cache.set(t, await extractRegion(p, crop.sx, crop.sy, crop.sw, crop.sh, Math.max(1, t.w * k * scale), Math.max(1, t.h * k * scale)));
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
    if ((IS_IOS || isTouch) && canShareFiles()) {
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
    await navigator.share({ files: [new File([lastBlob], lastName, { type: lastBlob.type })] });
    $('#shareSheet').hidden = true;
  } catch {
    /* キャンセル */
  }
});
$('#shareDl').addEventListener('click', () => {
  if (lastBlob) download(lastBlob, lastName);
  $('#shareSheet').hidden = true;
});
$('#shareClose').addEventListener('click', () => ($('#shareSheet').hidden = true));
$('#aboutBtn').addEventListener('click', () => ($('#aboutSheet').hidden = false));
$('#aboutClose').addEventListener('click', () => ($('#aboutSheet').hidden = true));
$$('.sheet-backdrop').forEach((s) => s.addEventListener('click', (e) => e.target === s && (s.hidden = true)));

// ---------- 起動 ----------

buildLayoutButtons();
syncControls();
renderOvSwatches();
renderList();
renderSelPanel();
render();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
