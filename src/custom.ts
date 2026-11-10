// カスタムレイアウトの作成画面。
// ペイントソフトのように、マスを置いたり、なぞって区切ったり（ダイレクトレイアウト）できる。
import { cellsToTiles, deleteCustom, getCustom, saveCustom } from './layouts';
import { drawScene } from './render';
import type { PhotoItem, Pt, Settings } from './types';

type Tool = 'select' | 'knife' | 'rect' | 'circle' | 'tri' | 'hex';
type ShapeKind = Exclude<Tool, 'select' | 'knife'>;

export interface EditorDeps {
  photos: () => PhotoItem[];
  settings: () => Settings;
  dims: () => { W: number; H: number };
  /** ひな形の候補（既存のレイアウト・自作のレイアウト） */
  templates: () => { id: string; name: string }[];
  /** ひな形のマス（0..1） */
  templateCells: (id: string) => Pt[][];
  maxCells: number;
  toast: (msg: string) => void;
  onSaved: (layoutId: string) => void;
  onDeleted: (layoutId: string) => void;
}

const ICON: Record<string, string> = {
  select: '<path d="M6 3l12 9-5.5 1.2L15 20l-2.6 1.1-2.6-6.6L6 18z"/>',
  knife: '<path d="M4 20 20 4"/><path d="M4 20l3-1M20 4l-1 3" />',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  tri: '<path d="M12 4 21 20H3z"/>',
  hex: '<path d="M7.5 4h9L21 12l-4.5 8h-9L3 12z"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12h-2" transform="translate(0 -6)"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M20 12H10a6 6 0 0 0 0 12h2" transform="translate(0 -6)"/>',
  dup: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  rot: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  del: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const svg = (k: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

const TOOLS: { id: Tool; name: string }[] = [
  { id: 'select', name: '選択' },
  { id: 'knife', name: '区切る' },
  { id: 'rect', name: '四角' },
  { id: 'circle', name: '円' },
  { id: 'tri', name: '三角' },
  { id: 'hex', name: '六角' },
];
const HINTS: Record<Tool, string> = {
  select: 'マスをタップして選び、ドラッグで移動。右下の丸をドラッグで大きさを変えます。',
  knife: 'なぞった線に沿って、マスを区切ります。曲がった線なら、折れ線で区切ります。',
  rect: 'ドラッグした範囲に置きます。長い線や曲線をなぞると、線に沿って並べます。',
  circle: 'ドラッグした範囲に置きます。長い線や曲線をなぞると、線に沿って並べます。',
  tri: 'ドラッグした範囲に置きます。長い線や曲線をなぞると、線に沿って並べます。',
  hex: 'ドラッグした範囲に置きます。長い線や曲線をなぞると、線に沿って並べます。',
};

// ---------- 幾何 ----------

function area(poly: Pt[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
function centroid(poly: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}
function bbox(poly: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}
function inside(poly: Pt[], x: number, y: number) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}
/** 凸多角形を、直線 AB の左右に分ける */
function splitPoly(poly: Pt[], a: Pt, b: Pt): [Pt[], Pt[]] {
  const side = (p: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const L: Pt[] = [], R: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp >= 0) L.push(p);
    if (sp <= 0) R.push(p);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq);
      const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      L.push(m);
      R.push(m);
    }
  }
  return [L, R];
}
function segCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
/** 線分 AB が多角形の内側を通る長さの割合（0..1）。端をかすめただけの線では区切らないために使う */
function segInside(poly: Pt[], a: Pt, b: Pt) {
  let hit = inside(poly, a.x, a.y) || inside(poly, b.x, b.y);
  for (let i = 0; !hit && i < poly.length; i++) if (segCross(a, b, poly[i], poly[(i + 1) % poly.length])) hit = true;
  if (!hit) return 0;
  const N = 48;
  let n = 0;
  for (let i = 0; i <= N; i++) if (inside(poly, a.x + ((b.x - a.x) * i) / N, a.y + ((b.y - a.y) * i) / N)) n++;
  return n / (N + 1);
}
/** 折れ線の単純化（Ramer–Douglas–Peucker） */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let far = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / len;
    if (d > far) {
      far = d;
      idx = i;
    }
  }
  if (far <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}
function pathLen(pts: Pt[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}
/** 折れ線上に、一定間隔で点を取る */
function resample(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  let next = step / 2, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    while (next <= acc + l) {
      const t = (next - acc) / (l || 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      next += step;
    }
    acc += l;
  }
  return out;
}
/** 図形（ピクセル座標の枠 cx, cy, w, h に収める） */
function makeShape(kind: ShapeKind, cx: number, cy: number, w: number, h: number): Pt[] {
  const hw = w / 2, hh = h / 2;
  switch (kind) {
    case 'rect':
      return [
        { x: cx - hw, y: cy - hh },
        { x: cx + hw, y: cy - hh },
        { x: cx + hw, y: cy + hh },
        { x: cx - hw, y: cy + hh },
      ];
    case 'tri':
      return [
        { x: cx, y: cy - hh },
        { x: cx + hw, y: cy + hh },
        { x: cx - hw, y: cy + hh },
      ];
    case 'hex':
      return [0, 1, 2, 3, 4, 5].map((i) => ({ x: cx + Math.cos((i * Math.PI) / 3) * hw, y: cy + Math.sin((i * Math.PI) / 3) * hh }));
    case 'circle':
      return Array.from({ length: 40 }, (_, i) => ({ x: cx + Math.cos((i / 40) * Math.PI * 2) * hw, y: cy + Math.sin((i / 40) * Math.PI * 2) * hh }));
  }
}

// ---------- 画面 ----------

export function initCustomEditor(deps: EditorDeps) {
  const root = document.createElement('div');
  root.className = 'editor';
  root.id = 'editor';
  root.hidden = true;
  root.innerHTML = `
    <header class="ed-head">
      <button class="ed-icon" id="edClose" aria-label="閉じる">${svg('close')}</button>
      <input id="edName" maxlength="20" aria-label="レイアウトの名前" />
      <button class="btn-primary ed-save" id="edSave">保存</button>
    </header>
    <div class="ed-sub">
      <label class="ed-tpl"><span>ひな形</span><select id="edTpl"></select></label>
      <span class="ed-count" id="edCount"></span>
      <button class="ed-remove" id="edRemove" hidden>削除</button>
    </div>
    <div class="ed-stage" id="edStage"><canvas id="edCanvas"></canvas></div>
    <p class="ed-hint" id="edHint"></p>
    <div class="ed-opts">
      <label class="ed-size" id="edSizeRow"><span>並べる大きさ</span><input id="edSize" type="range" min="0.06" max="0.5" step="0.01" /></label>
      <div class="ed-acts">
        <button class="ed-icon" id="edUndo" aria-label="元に戻す">${svg('undo')}</button>
        <button class="ed-icon" id="edRedo" aria-label="やり直す">${svg('redo')}</button>
        <button class="ed-icon" id="edDup" aria-label="複製">${svg('dup')}</button>
        <button class="ed-icon" id="edRot" aria-label="15度回転">${svg('rot')}</button>
        <button class="ed-icon danger" id="edDel" aria-label="マスを削除">${svg('del')}</button>
      </div>
    </div>
    <nav class="ed-tools" id="edTools">
      ${TOOLS.map((t) => `<button data-tool="${t.id}">${svg(t.id)}<span>${t.name}</span></button>`).join('')}
    </nav>`;
  document.body.appendChild(root);
  const q = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector(s) as T;
  const canvas = q<HTMLCanvasElement>('#edCanvas');
  const stageEl = q('#edStage');

  let cells: Pt[][] = [];
  let sel = -1;
  let tool: Tool = 'knife';
  let size = 0.2;
  let past: string[] = [];
  let future: string[] = [];
  let editingId: string | null = null;
  let dirty = false;
  // 描画中の線（0..1）
  let stroke: Pt[] | null = null;
  // キャンバス上の配置（CSS px）
  let view = { x: 0, y: 0, w: 1, h: 1, cw: 1, ch: 1, k: 1 };

  const frame = () => {
    const { W, H } = deps.dims();
    const st = deps.settings();
    const ox = st.margin - st.gap / 2, oy = st.margin - st.gap / 2;
    return { W, H, ox, oy, iw: W - ox * 2, ih: H - oy * 2 };
  };
  // 0..1（マスの座標） ⇔ 画面の CSS px
  const toScreen = (p: Pt) => {
    const f = frame();
    return { x: ((f.ox + p.x * f.iw) / f.W) * view.cw, y: ((f.oy + p.y * f.ih) / f.H) * view.ch };
  };
  const fromEvent = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvas.getBoundingClientRect();
    const f = frame();
    const lx = ((e.clientX - r.left) / r.width) * f.W, ly = ((e.clientY - r.top) / r.height) * f.H;
    return { x: (lx - f.ox) / f.iw, y: (ly - f.oy) / f.ih };
  };
  // 0..1 ⇔ 縦横比をそろえた座標（回転・円などに使う）
  const toPx = (p: Pt) => {
    const f = frame();
    return { x: p.x * f.iw, y: p.y * f.ih };
  };
  const fromPx = (p: Pt) => {
    const f = frame();
    return { x: p.x / f.iw, y: p.y / f.ih };
  };

  const snapshot = () => JSON.stringify(cells);
  const commit = (before: string) => {
    if (before === snapshot()) return;
    past.push(before);
    if (past.length > 80) past.shift();
    future = [];
    dirty = true;
    syncUI();
  };

  function syncUI() {
    root.querySelectorAll<HTMLButtonElement>('#edTools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    q('#edHint').textContent = HINTS[tool];
    q('#edSizeRow').hidden = tool === 'select' || tool === 'knife';
    q<HTMLButtonElement>('#edUndo').disabled = !past.length;
    q<HTMLButtonElement>('#edRedo').disabled = !future.length;
    for (const id of ['#edDup', '#edRot', '#edDel']) q<HTMLButtonElement>(id).disabled = sel < 0;
    const n = deps.photos().length;
    q('#edCount').textContent = `マス ${cells.length} ／ 写真 ${n}枚`;
    q('#edCount').classList.toggle('warn', cells.length < n);
    draw();
  }

  function layoutCanvas() {
    const { W, H } = deps.dims();
    const box = stageEl.getBoundingClientRect();
    const s = Math.min((box.width - 24) / W, (box.height - 24) / H);
    const cw = Math.max(10, W * s), ch = Math.max(10, H * s);
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    view = { x: 0, y: 0, w: cw, h: ch, cw, ch, k: dpr };
  }

  function draw() {
    if (root.hidden) return;
    const { W, H } = deps.dims();
    const st = deps.settings();
    const x = canvas.getContext('2d')!;
    const kk = (view.cw * view.k) / W;
    x.setTransform(1, 0, 0, 1, 0, 0);
    const photos = deps.photos();
    const tiles = cellsToTiles(cells, { W, H, gap: st.gap, margin: st.margin });
    drawScene(x, {
      W,
      H,
      k: kk,
      tiles,
      photos,
      settings: { ...st, overlay: 'none', showLabel: false },
      rounded: true,
      image: (_t, p, crop) => {
        const s = p.preview.width / p.width;
        return { img: p.preview, crop: { sx: crop.sx * s, sy: crop.sy * s, sw: crop.sw * s, sh: crop.sh * s } };
      },
    });
    // 写真の入らないマス
    x.save();
    x.scale(kk, kk);
    for (const t of tiles) {
      if (t.idx < photos.length) continue;
      x.beginPath();
      t.clip.forEach((p, i) => (i ? x.lineTo(t.cx + p.x, t.cy + p.y) : x.moveTo(t.cx + p.x, t.cy + p.y)));
      x.closePath();
      x.fillStyle = 'rgba(120,120,120,.18)';
      x.fill();
    }
    x.restore();
    // マスの輪郭と番号（CSS px で描く）
    x.setTransform(view.k, 0, 0, view.k, 0, 0);
    cells.forEach((c, i) => {
      const pts = c.map(toScreen);
      x.beginPath();
      pts.forEach((p, j) => (j ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
      x.closePath();
      x.lineWidth = i === sel ? 2.5 : 1;
      x.strokeStyle = i === sel ? '#e8792b' : 'rgba(255,255,255,.85)';
      x.setLineDash(i === sel ? [] : [4, 3]);
      x.stroke();
      x.setLineDash([]);
      const c0 = toScreen(centroid(c));
      x.fillStyle = i === sel ? '#e8792b' : 'rgba(20,20,22,.6)';
      x.beginPath();
      x.arc(c0.x, c0.y, 10, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = '#fff';
      x.font = "600 11px Inter, 'Noto Sans JP Variable', sans-serif";
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(String(i + 1), c0.x, c0.y + 0.5);
    });
    // 選択中のマスの大きさ変更ハンドル
    if (sel >= 0 && cells[sel]) {
      const h = handlePos();
      x.beginPath();
      x.arc(h.x, h.y, 9, 0, Math.PI * 2);
      x.fillStyle = '#fff';
      x.fill();
      x.lineWidth = 2.5;
      x.strokeStyle = '#e8792b';
      x.stroke();
    }
    // なぞっている線
    if (stroke && stroke.length > 1) {
      const pts = stroke.map(toScreen);
      x.beginPath();
      pts.forEach((p, j) => (j ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
      x.lineWidth = 3;
      x.lineCap = 'round';
      x.lineJoin = 'round';
      x.strokeStyle = 'rgba(255,255,255,.9)';
      x.stroke();
      x.lineWidth = 1.6;
      x.strokeStyle = '#e8792b';
      x.setLineDash(tool === 'knife' ? [6, 4] : []);
      x.stroke();
      x.setLineDash([]);
      // 図形の仮置き
      if (tool !== 'knife' && tool !== 'select') {
        for (const shp of shapesFor(stroke)) {
          const sp = shp.map(toScreen);
          x.beginPath();
          sp.forEach((p, j) => (j ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
          x.closePath();
          x.fillStyle = 'rgba(232,121,43,.22)';
          x.fill();
          x.lineWidth = 1.5;
          x.strokeStyle = '#e8792b';
          x.stroke();
        }
      }
    }
  }

  function handlePos() {
    const b = bbox(cells[sel]);
    return toScreen({ x: b.x1, y: b.y1 });
  }

  /** なぞった線から、置く図形を決める（0..1 の多角形） */
  function shapesFor(path: Pt[]): Pt[][] {
    const kind = tool as ShapeKind;
    const f = frame();
    const px = path.map(toPx);
    const L = pathLen(px);
    const a = px[0], b = px[px.length - 1];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const unit = size * Math.min(f.iw, f.ih);
    const bb = bbox(px);
    const bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
    // 短いタップ：既定の大きさで1つ
    if (L < Math.min(f.iw, f.ih) * 0.03) return [makeShape(kind, a.x, a.y, unit, unit).map(fromPx)];
    // 曲線や細長い線：線に沿って並べる
    const along = L > chord * 1.25 || (Math.min(bw, bh) < Math.max(bw, bh) * 0.4 && L > unit * 1.6);
    if (along) return resample(px, unit * 1.08).map((p) => makeShape(kind, p.x, p.y, unit, unit).map(fromPx));
    // それ以外：なぞった範囲に1つ
    return [makeShape(kind, (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, Math.max(bw, unit * 0.2), Math.max(bh, unit * 0.2)).map(fromPx)];
  }

  /** なぞった線でマスを区切る */
  function knife(path: Pt[]) {
    const f = frame();
    const px = path.map(toPx);
    if (pathLen(px) < Math.min(f.iw, f.ih) * 0.04) return 0;
    const segs = simplify(px, Math.min(f.iw, f.ih) * 0.025).map(fromPx);
    let made = 0;
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i];
      const segLen = Math.hypot((b.x - a.x) * f.iw, (b.y - a.y) * f.ih);
      if (segLen < 4) continue;
      // マスの中を通る長さが、短辺の 3% 未満なら区切らない（線の端がはみ出しただけ）
      const minIn = Math.min(f.iw, f.ih) * 0.03;
      const out: Pt[][] = [];
      let count = cells.length;
      for (const c of cells) {
        if (count >= deps.maxCells || segInside(c, a, b) * segLen < minIn) {
          out.push(c);
          continue;
        }
        const [l, r] = splitPoly(c, a, b);
        const tiny = Math.abs(area(c)) * 0.01;
        if (Math.abs(area(l)) > tiny && Math.abs(area(r)) > tiny) {
          out.push(l, r);
          count++;
          made++;
        } else out.push(c);
      }
      cells = out;
    }
    return made;
  }

  // ---------- 操作 ----------

  type Drag =
    | { kind: 'draw'; pid: number; before: string }
    | { kind: 'move'; pid: number; before: string; start: Pt; orig: Pt[] }
    | { kind: 'scale'; pid: number; before: string; start: Pt; orig: Pt[]; c: Pt };
  let drag: Drag | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (drag) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 合成イベントなど */
    }
    const p = fromEvent(e);
    const before = snapshot();
    if (tool === 'select') {
      const r = canvas.getBoundingClientRect();
      if (sel >= 0) {
        const h = handlePos();
        if (Math.hypot(e.clientX - r.left - h.x, e.clientY - r.top - h.y) < 20) {
          const b = bbox(cells[sel]);
          drag = { kind: 'scale', pid: e.pointerId, before, start: p, orig: cells[sel].map((v) => ({ ...v })), c: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } };
          return;
        }
      }
      sel = -1;
      for (let i = cells.length - 1; i >= 0; i--)
        if (inside(cells[i], p.x, p.y)) {
          sel = i;
          break;
        }
      if (sel >= 0) drag = { kind: 'move', pid: e.pointerId, before, start: p, orig: cells[sel].map((v) => ({ ...v })) };
      syncUI();
      return;
    }
    stroke = [p];
    drag = { kind: 'draw', pid: e.pointerId, before };
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const p = fromEvent(e);
    if (drag.kind === 'draw') {
      stroke!.push(p);
    } else if (drag.kind === 'move') {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      cells[sel] = drag.orig.map((v) => ({ x: v.x + dx, y: v.y + dy }));
    } else {
      const { c, start, orig } = drag;
      const fx = (v: number, s: number, o: number) => {
        const d0 = s - o;
        return Math.abs(d0) < 1e-4 ? 1 : Math.min(8, Math.max(0.08, (v - o) / d0));
      };
      const sx = fx(p.x, start.x, c.x), sy = fx(p.y, start.y, c.y);
      cells[sel] = orig.map((v) => ({ x: c.x + (v.x - c.x) * sx, y: c.y + (v.y - c.y) * sy }));
    }
    draw();
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    if (d.kind === 'draw' && stroke) {
      const path = stroke;
      stroke = null;
      if (e.type === 'pointerup') {
        if (tool === 'knife') {
          const n = knife(path);
          if (!n && path.length > 2) deps.toast(cells.length >= deps.maxCells ? `マスは最大${deps.maxCells}個までです` : '区切るマスがありませんでした');
        } else {
          const add = shapesFor(path);
          const room = deps.maxCells - cells.length;
          if (room <= 0) deps.toast(`マスは最大${deps.maxCells}個までです`);
          else {
            if (add.length > room) deps.toast(`マスは最大${deps.maxCells}個までなので、${room}個だけ置きました`);
            cells.push(...add.slice(0, room));
          }
        }
      }
    }
    commit(d.before);
    syncUI();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  root.querySelectorAll<HTMLButtonElement>('#edTools button').forEach((b) =>
    b.addEventListener('click', () => {
      tool = b.dataset.tool as Tool;
      if (tool !== 'select') sel = -1;
      syncUI();
    }),
  );
  const act = (fn: () => void) => () => {
    const before = snapshot();
    fn();
    commit(before);
    syncUI();
  };
  q('#edUndo').addEventListener('click', undo);
  q('#edRedo').addEventListener('click', redo);
  function undo() {
    const s = past.pop();
    if (s == null) return;
    future.push(snapshot());
    cells = JSON.parse(s);
    sel = -1;
    dirty = true;
    syncUI();
  }
  function redo() {
    const s = future.pop();
    if (s == null) return;
    past.push(snapshot());
    cells = JSON.parse(s);
    sel = -1;
    dirty = true;
    syncUI();
  }
  q('#edDup').addEventListener(
    'click',
    act(() => {
      if (sel < 0) return;
      if (cells.length >= deps.maxCells) return deps.toast(`マスは最大${deps.maxCells}個までです`);
      cells.push(cells[sel].map((p) => ({ x: p.x + 0.04, y: p.y + 0.04 })));
      sel = cells.length - 1;
    }),
  );
  q('#edRot').addEventListener(
    'click',
    act(() => {
      if (sel < 0) return;
      const px = cells[sel].map(toPx);
      const c = centroid(px);
      const a = Math.PI / 12, cs = Math.cos(a), sn = Math.sin(a);
      cells[sel] = px.map((p) => fromPx({ x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs }));
    }),
  );
  q('#edDel').addEventListener(
    'click',
    act(() => {
      if (sel < 0) return;
      cells.splice(sel, 1);
      sel = -1;
    }),
  );
  q<HTMLInputElement>('#edSize').addEventListener('input', () => {
    size = Number(q<HTMLInputElement>('#edSize').value);
  });
  q<HTMLSelectElement>('#edTpl').addEventListener('change', () => {
    const v = q<HTMLSelectElement>('#edTpl').value;
    if (!v) return;
    const before = snapshot();
    cells = v === 'blank' ? [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]] : v === 'empty' ? [] : deps.templateCells(v).slice(0, deps.maxCells);
    sel = -1;
    q<HTMLSelectElement>('#edTpl').value = '';
    commit(before);
    syncUI();
  });
  q('#edClose').addEventListener('click', () => {
    if (dirty && !confirm('保存せずに閉じますか？')) return;
    close();
  });
  q('#edSave').addEventListener('click', () => {
    if (!cells.length) return deps.toast('マスがありません。図形を置くか、ひな形を選んでください');
    const name = q<HTMLInputElement>('#edName').value.trim() || 'カスタム';
    const id = editingId ?? Date.now().toString(36);
    saveCustom({ id, name, cells: cells.map((c) => c.map((p) => ({ x: +p.x.toFixed(5), y: +p.y.toFixed(5) }))) });
    close();
    deps.onSaved(`custom:${id}`);
    deps.toast(`「${name}」を保存しました`);
  });
  q('#edRemove').addEventListener('click', () => {
    if (!editingId || !confirm('このレイアウトを削除しますか？')) return;
    deleteCustom(editingId);
    const id = editingId;
    close();
    deps.onDeleted(`custom:${id}`);
  });
  document.addEventListener('keydown', (e) => {
    if (root.hidden || (e.target as HTMLElement).tagName === 'INPUT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) {
      e.preventDefault();
      q('#edDel').click();
    } else if (e.key === 'Escape') q('#edClose').click();
  });
  new ResizeObserver(() => {
    if (root.hidden) return;
    layoutCanvas();
    draw();
  }).observe(stageEl);

  function close() {
    root.hidden = true;
    document.body.classList.remove('editing');
  }

  /** 開く：既存のカスタムを編集するか、ひな形（レイアウト id）から新しく作る */
  function open(opts: { editId?: string; fromLayout?: string } = {}) {
    const c = opts.editId ? getCustom(opts.editId) : null;
    editingId = c ? c.id : null;
    cells = c ? JSON.parse(JSON.stringify(c.cells)) : opts.fromLayout ? deps.templateCells(opts.fromLayout).slice(0, deps.maxCells) : [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]];
    past = [];
    future = [];
    sel = -1;
    dirty = false;
    tool = c ? 'select' : 'knife';
    q<HTMLInputElement>('#edName').value = c ? c.name : `カスタム ${new Date().getMonth() + 1}/${new Date().getDate()}`;
    q<HTMLInputElement>('#edSize').value = String(size);
    q('#edRemove').hidden = !c;
    const sel2 = q<HTMLSelectElement>('#edTpl');
    sel2.innerHTML =
      '<option value="">選んで置き換え…</option><option value="blank">1マス（全面）</option><option value="empty">空っぽ</option>' +
      deps
        .templates()
        .map((t) => `<option value="${t.id}"></option>`)
        .join('');
    // 名前は textContent で入れる（自作レイアウトの名前を HTML として扱わない）
    deps.templates().forEach((t, i) => (sel2.options[i + 3].textContent = t.name));
    root.hidden = false;
    document.body.classList.add('editing');
    layoutCanvas();
    syncUI();
  }

  return { open, isOpen: () => !root.hidden };
}
