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
  align: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
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
  select: 'マスをタップして選び、ドラッグで移動。右下の丸で大きさ、上の丸で角度を変えます。',
  knife: 'なぞった線に沿って、マスを区切ります。直線はまっすぐ、曲線はなぞった形のまま区切ります。',
  rect: 'ドラッグした範囲に置きます（タップで標準の大きさ）。置いたあとは「整列」でそろえられます。',
  circle: 'ドラッグした範囲に置きます（タップで標準の大きさ）。置いたあとは「整列」でそろえられます。',
  tri: 'ドラッグした範囲に置きます（タップで標準の大きさ）。置いたあとは「整列」でそろえられます。',
  hex: 'ドラッグした範囲に置きます（タップで標準の大きさ）。置いたあとは「整列」でそろえられます。',
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
/** 面積の重心（曲線で区切ったマスのように、点が片側に偏っていてもずれない） */
function centroid(poly: Pt[]): Pt {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const k = p.x * q.y - q.x * p.y;
    a += k;
    x += (p.x + q.x) * k;
    y += (p.y + q.y) * k;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (const p of poly) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / poly.length, y: sy / poly.length };
  }
  return { x: x / (3 * a), y: y / (3 * a) };
}
function distToEdges(poly: Pt[], x: number, y: number) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const vx = b.x - a.x, vy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy || 1)));
    d = Math.min(d, Math.hypot(a.x + vx * t - x, a.y + vy * t - y));
  }
  return d;
}
/** 番号を置く点：マスの内側で、なるべく縁から離れたところ */
function labelPoint(poly: Pt[]): Pt {
  const c = centroid(poly);
  const b = bbox(poly);
  const r = Math.min(b.x1 - b.x0, b.y1 - b.y0);
  if (inside(poly, c.x, c.y) && distToEdges(poly, c.x, c.y) > r * 0.3) return c;
  let best = c, bd = inside(poly, c.x, c.y) ? distToEdges(poly, c.x, c.y) : -1;
  const N = 14;
  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= N; j++) {
      const x = b.x0 + ((b.x1 - b.x0) * i) / N, y = b.y0 + ((b.y1 - b.y0) * j) / N;
      if (!inside(poly, x, y)) continue;
      const d = distToEdges(poly, x, y);
      if (d > bd) {
        bd = d;
        best = { x, y };
      }
    }
  return best;
}
/** かけらの太さの目安（2×面積÷周長。幅 w の細長い帯なら、ほぼ w） */
function thickness(poly: Pt[]) {
  let per = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    per += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return per ? (2 * Math.abs(area(poly))) / per : 0;
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
interface Cross {
  /** 線（折れ線）に沿った距離 */
  s: number;
  /** 多角形の外周上の位置（辺の番号 + 辺の中の割合） */
  pos: number;
  p: Pt;
}
/** 折れ線と多角形の外周の交点を、線に沿った順に並べる */
function crossings(poly: Pt[], path: Pt[]): Cross[] {
  const out: Cross[] = [];
  let acc = 0;
  const n = poly.length;
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segL = Math.hypot(dx, dy);
    for (let i = 0; i < n; i++) {
      const c = poly[i], d = poly[(i + 1) % n];
      const ex = d.x - c.x, ey = d.y - c.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      out.push({ s: acc + t * segL, pos: i + u, p: { x: a.x + dx * t, y: a.y + dy * t } });
    }
    acc += segL;
  }
  return out.sort((x, y) => x.s - y.s);
}
/** 外周を位置 a から b まで進むときに通る頂点 */
function walk(poly: Pt[], a: number, b: number): Pt[] {
  const n = poly.length;
  const end = b < a ? b + n : b;
  const out: Pt[] = [];
  for (let k = Math.floor(a) + 1; k <= end; k++) out.push(poly[k % n]);
  return out;
}
/** 折れ線上の距離 s の点 */
function pointAt(path: Pt[], s: number): Pt {
  let acc = 0;
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + l >= s) {
      const t = l ? (s - acc) / l : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += l;
  }
  return path[path.length - 1];
}
/** 折れ線の s1〜s2 の部分 */
function subPath(path: Pt[], s1: number, s2: number): Pt[] {
  const out = [pointAt(path, s1)];
  let acc = 0;
  for (let k = 0; k + 1 < path.length; k++) {
    acc += Math.hypot(path[k + 1].x - path[k].x, path[k + 1].y - path[k].y);
    if (acc > s1 && acc < s2) out.push(path[k + 1]);
  }
  out.push(pointAt(path, s2));
  return out;
}

interface CutOpts {
  /** なぞった線そのもの（延長部分を除く）の範囲 */
  from: number;
  to: number;
  /** マスの中を通る長さがこれ未満なら切らない */
  minIn: number;
  /** これより小さいかけらができるなら切らない */
  minArea: number;
  /** これより細いかけらができるなら切らない（端ぎりぎりを切ったときの細い帯） */
  minThick: number;
  /** 細すぎて切らなかったとき */
  onThin?: () => void;
}
/**
 * 多角形（凹でも可）を、線に沿って切る。線がマスを何度も横切るときは、続きの線でさらに切る。
 * 結果のかけらを返す（切れなければ元のまま）。
 */
function cutPoly(poly: Pt[], path: Pt[], o: CutOpts, depth = 0): Pt[][] {
  if (depth > 6) return [poly];
  const cs = crossings(poly, path);
  for (let j = 0; j + 1 < cs.length; j++) {
    const c1 = cs[j], c2 = cs[j + 1];
    if (c2.s - c1.s < 1e-6) continue;
    const mid = pointAt(path, (c1.s + c2.s) / 2);
    if (!inside(poly, mid.x, mid.y)) continue;
    // なぞった部分がマスの中を十分に通っているか
    const own = Math.min(c2.s, o.to) - Math.max(c1.s, o.from);
    if (own < o.minIn) continue;
    const sub = subPath(path, c1.s, c2.s);
    const A = [...sub, ...walk(poly, c2.pos, c1.pos)];
    const B = [...sub.slice().reverse(), ...walk(poly, c1.pos, c2.pos)];
    if (Math.abs(area(A)) < o.minArea || Math.abs(area(B)) < o.minArea) {
      o.onThin?.();
      continue;
    }
    if (thickness(A) < o.minThick || thickness(B) < o.minThick) {
      o.onThin?.();
      continue;
    }
    // 線の続きで、できたかけらをさらに切る
    const rest = { ...o, from: Math.max(o.from, c2.s) - c2.s, to: o.to - c2.s };
    const tail = subPath(path, c2.s, pathLen(path));
    if (rest.to - Math.max(0, rest.from) < o.minIn || tail.length < 2) return [A, B];
    return [...cutPoly(A, tail, rest, depth + 1), ...cutPoly(B, tail, rest, depth + 1)];
  }
  return [poly];
}
/** 線を滑らかにする（移動平均）。amount 0..1 */
function smooth(pts: Pt[], amount: number): Pt[] {
  const w = Math.round(amount * 10);
  if (w < 1 || pts.length < 3) return pts;
  return pts.map((_, i) => {
    if (i === 0 || i === pts.length - 1) return pts[i];
    const r = Math.min(w, i, pts.length - 1 - i);
    let x = 0, y = 0;
    for (let k = i - r; k <= i + r; k++) {
      x += pts[k].x;
      y += pts[k].y;
    }
    return { x: x / (r * 2 + 1), y: y / (r * 2 + 1) };
  });
}
/** 両端を、線の向きに長く延ばす（マスの端まで届かせる） */
function extend(pts: Pt[], len: number): Pt[] {
  const n = pts.length;
  const dir = (a: Pt, b: Pt) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  // 端の向きは、少し内側の点から取る（指のぶれを拾わない）
  const k = Math.min(n - 1, Math.max(1, Math.floor(n / 8)));
  const d0 = dir(pts[k], pts[0]), d1 = dir(pts[n - 1 - k], pts[n - 1]);
  return [{ x: pts[0].x + d0.x * len, y: pts[0].y + d0.y * len }, ...pts, { x: pts[n - 1].x + d1.x * len, y: pts[n - 1].y + d1.y * len }];
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

type Pattern = 'grid' | 'stagger' | 'ring' | 'mount' | 'wave';
const PATTERNS: { id: Pattern; name: string }[] = [
  { id: 'grid', name: '格子' },
  { id: 'stagger', name: '千鳥' },
  { id: 'ring', name: '円形' },
  { id: 'mount', name: '山形' },
  { id: 'wave', name: '波' },
];
/** 図形どうしの中心の間隔（図形の大きさ 1 に対して） */
const GAP = 1.16;
/** 行ごとの個数から、中央そろえの並びを作る（大きさ 1 の図形の中心） */
function rowsOf(counts: number[], dy: number, shift = 0): Pt[] {
  const out: Pt[] = [];
  counts.forEach((k, r) => {
    const off = shift && r % 2 ? shift : 0;
    for (let i = 0; i < k; i++) out.push({ x: (i - (k - 1) / 2) * GAP + off, y: r * dy });
  });
  return out;
}
/** 四角でも重ならないよう、どの2つも縦か横に GAP 以上離れるように広げる */
function spread(c: Pt[]): Pt[] {
  let d = Infinity;
  for (let i = 0; i < c.length; i++)
    for (let j = i + 1; j < c.length; j++) d = Math.min(d, Math.max(Math.abs(c[i].x - c[j].x), Math.abs(c[i].y - c[j].y)));
  const k = d > 1e-9 && d < Infinity ? GAP / d : 1;
  return c.map((p) => ({ x: p.x * k, y: p.y * k }));
}
/** 大きさ 1 の図形の並びを、枠いっぱい・中央に収める */
function fitInto(c: Pt[], w: number, h: number): { c: Pt[]; s: number } {
  const b = bbox(c);
  const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
  const k = Math.min((w * 0.92) / bw, (h * 0.92) / bh);
  const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
  return { c: c.map((p) => ({ x: w / 2 + (p.x - mx) * k, y: h / 2 + (p.y - my) * k })), s: k };
}
/** 候補の中から、図形がいちばん大きくなるものを選ぶ */
function best(cands: Pt[][], w: number, h: number) {
  let out = fitInto(cands[0], w, h);
  for (const c of cands.slice(1)) {
    const f = fitInto(c, w, h);
    if (f.s > out.s + 1e-9) out = f;
  }
  return out;
}
/** 格子の行ごとの個数（列数 cols。端数の行は真ん中に） */
function gridRows(n: number, cols: number) {
  const rows = Math.ceil(n / cols);
  return Array.from({ length: rows }, (_, r) => (r < rows - 1 ? cols : n - cols * (rows - 1)));
}
/** 規則的な配置：中心点と大きさ（幅 w・高さ h の枠の中。上下左右とも中央そろえ） */
function patternCenters(p: Pattern, n: number, w: number, h: number): { c: Pt[]; s: number } {
  if (n <= 1) return fitInto([{ x: 0, y: 0 }], w, h);
  const cols = Array.from({ length: n }, (_, i) => i + 1);
  switch (p) {
    case 'grid':
      return best(cols.map((k) => rowsOf(gridRows(n, k), GAP)), w, h);
    case 'stagger':
      // 1行おきに半分ずらす
      return best(cols.filter((k) => k < n).map((k) => rowsOf(gridRows(n, k), GAP * 0.87, GAP / 2)), w, h);
    case 'ring': {
      const c = Array.from({ length: n }, (_, i) => {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        return { x: Math.cos(a), y: Math.sin(a) };
      });
      return fitInto(spread(c), w, h);
    }
    case 'mount': {
      // 上から 1, 2, 3… と増やす（あまりは一番下の行へ）
      const table: Record<number, number[]> = { 2: [1, 1], 3: [1, 2], 4: [1, 3], 5: [2, 3], 6: [1, 2, 3] };
      const counts: number[] = table[n] ? [...table[n]] : [];
      let left = table[n] ? 0 : n;
      for (let k = 1; left > 0; k++) {
        if (left - k < k + 1 && left - k > 0) {
          counts.push(left);
          break;
        }
        counts.push(Math.min(k, left));
        left -= k;
      }
      return fitInto(rowsOf(counts, GAP * 0.87), w, h);
    }
    case 'wave': {
      // ジグザグに1列。枠の長い向きに並べる
      const line = spread(Array.from({ length: n }, (_, i) => ({ x: (i - (n - 1) / 2) * 0.6, y: i % 2 ? 0.5 : -0.5 })));
      return best([line, line.map((q) => ({ x: q.y, y: q.x }))], w, h);
    }
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
      <div class="ed-toolopt">
      <button class="ed-chip" id="edLock" aria-pressed="true" aria-label="縦横比ロック" title="縦横比ロック"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>縦横比</button>
      <div class="ed-auto" id="edSizeRow"><span>自動配置</span>${PATTERNS.map((p) => `<button data-pat="${p.id}">${p.name}</button>`).join('')}</div>
      <div class="ed-cut" id="edCutRow">
        <div class="seg2 ed-cutmode"><button data-cut="line">直線</button><button data-cut="curve">曲線</button></div>
        <label class="ed-size" id="edSmoothRow"><span>滑らかさ</span><input id="edSmooth" type="range" min="0" max="1" step="0.05" /></label>
      </div>
      </div>
      <div class="ed-acts">
        <button class="ed-icon" id="edAlign" aria-label="整列" title="整列">${svg('align')}</button>
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
  /** マスごとの角度（ラジアン）。大きさを変えるときに形がゆがまないよう、マスの向きで伸ばす */
  let rots: number[] = [];
  let sel = -1;
  /** 縦横比ロック（置くとき・大きさを変えるとき） */
  let lockAspect = true;
  let tool: Tool = 'knife';
  /** タップで置くときの大きさ（短辺比） */
  const size = 0.2;
  // 区切る線：直線か曲線か、曲線の滑らかさ
  let cutMode: 'line' | 'curve' = 'curve';
  let smoothness = 0.5;
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

  const snapshot = () => JSON.stringify({ c: cells, r: rots });
  const restore = (snap: string) => {
    const v = JSON.parse(snap);
    cells = v.c;
    rots = v.r;
  };
  const setCells = (cs: Pt[][]) => {
    cells = cs;
    rots = cs.map(() => 0);
  };
  const rotAround = (pts: Pt[], c: Pt, a: number) => {
    const cs = Math.cos(a), sn = Math.sin(a);
    return pts.map((p) => ({ x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs }));
  };
  /** 画面の 1px が、縦横比をそろえた座標でいくつか */
  const pxPerScreen = () => frame().W / view.cw;
  /** マスの向きにそろえた枠（中心 c・角度 a・向きをそろえたときの範囲 b） */
  function cellFrame(i: number) {
    const px = cells[i].map(toPx);
    const c = centroid(px);
    const a = rots[i] || 0;
    return { c, a, b: bbox(rotAround(px, c, -a)) };
  }
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
    q('#edLock').hidden = tool === 'knife';
    q('#edLock').classList.toggle('active', lockAspect);
    q('#edLock').setAttribute('aria-pressed', String(lockAspect));
    q<HTMLButtonElement>('#edAlign').disabled = cells.length < 2;
    q('#edCutRow').hidden = tool !== 'knife';
    q('#edSmoothRow').hidden = cutMode !== 'curve';
    root.querySelectorAll<HTMLButtonElement>('[data-cut]').forEach((b) => b.classList.toggle('active', b.dataset.cut === cutMode));
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
      const c0 = toScreen(labelPoint(c));
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
      const hs = handles();
      x.beginPath();
      x.moveTo(hs.top.x, hs.top.y);
      x.lineTo(hs.rot.x, hs.rot.y);
      x.lineWidth = 1.5;
      x.strokeStyle = '#e8792b';
      x.stroke();
      for (const h of [hs.scale, hs.rot]) {
        x.beginPath();
        x.arc(h.x, h.y, 9, 0, Math.PI * 2);
        x.fillStyle = '#fff';
        x.fill();
        x.lineWidth = 2.5;
        x.strokeStyle = '#e8792b';
        x.stroke();
      }
      // 角度のしるし（回る矢印）
      x.beginPath();
      x.arc(hs.rot.x, hs.rot.y, 4.5, -Math.PI * 0.2, Math.PI * 1.3);
      x.lineWidth = 1.5;
      x.stroke();
      if (drag?.kind === 'rot') {
        let deg = Math.round(((rots[sel] * 180) / Math.PI) % 360);
        if (deg > 180) deg -= 360;
        if (deg <= -180) deg += 360;
        x.font = "700 12px Inter, 'Noto Sans JP Variable', sans-serif";
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        const tx = hs.rot.x, ty = hs.rot.y - 22;
        x.fillStyle = 'rgba(20,20,22,.75)';
        x.beginPath();
        x.roundRect(tx - 22, ty - 10, 44, 20, 10);
        x.fill();
        x.fillStyle = '#fff';
        x.fillText(`${deg}°`, tx, ty + 0.5);
      }
    }
    // なぞっている線
    if (stroke && stroke.length > 1 && tool === 'knife') {
      const pts = cutPath(stroke).map(toScreen);
      x.beginPath();
      pts.forEach((p, j) => (j ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
      x.lineWidth = 3;
      x.lineCap = 'round';
      x.lineJoin = 'round';
      x.strokeStyle = 'rgba(255,255,255,.9)';
      x.stroke();
      x.lineWidth = 1.6;
      x.strokeStyle = '#e8792b';
      x.setLineDash([6, 4]);
      x.stroke();
      x.setLineDash([]);
    }
    // 図形の仮置き
    if (stroke && tool !== 'knife' && tool !== 'select') {
      const sp = shapeFor(stroke).map(toScreen);
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

  /** 選択中のマスのハンドル（画面の CSS px）：右下＝大きさ、上＝角度 */
  function handles() {
    const { c, a, b } = cellFrame(sel);
    const back = (p: Pt) => toScreen(fromPx(rotAround([p], c, a)[0]));
    const off = 30 * pxPerScreen();
    const mx = (b.x0 + b.x1) / 2;
    let top = back({ x: mx, y: b.y0 }), rot = back({ x: mx, y: b.y0 - off });
    // 画面の外に出るときは下側に出す
    if (rot.y < 10 || rot.x < 10 || rot.x > view.cw - 10 || rot.y > view.ch - 10) {
      top = back({ x: mx, y: b.y1 });
      rot = back({ x: mx, y: b.y1 + off });
    }
    return { scale: back({ x: b.x1, y: b.y1 }), rot, top };
  }

  /** ドラッグした範囲に置く図形（0..1 の多角形）。始点から今の指の位置までの四角に収める */
  function shapeFor(path: Pt[]): Pt[] {
    const kind = tool as ShapeKind;
    const f = frame();
    const m = Math.min(f.iw, f.ih);
    const a = toPx(path[0]), b = toPx(path[path.length - 1]);
    const unit = size * m;
    let dx = b.x - a.x, dy = b.y - a.y;
    // タップ：標準の大きさで1つ
    if (Math.hypot(dx, dy) < m * 0.03) return makeShape(kind, a.x, a.y, unit, unit).map(fromPx);
    if (lockAspect) {
      const k = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * k;
      dy = (dy < 0 ? -1 : 1) * k;
    }
    const min = m * 0.04;
    const w = Math.max(Math.abs(dx), min), h = Math.max(Math.abs(dy), min);
    return makeShape(kind, a.x + (dx < 0 ? -w : w) / 2, a.y + (dy < 0 ? -h : h) / 2, w, h).map(fromPx);
  }

  /** 区切りに使う線（0..1）：直線なら始点と終点、曲線なら滑らかにした線 */
  function cutPath(path: Pt[]): Pt[] {
    if (cutMode === 'line' || path.length < 3) return [path[0], path[path.length - 1]];
    const f = frame();
    const unit = Math.min(f.iw, f.ih);
    // 等間隔に取り直してから滑らかにし、点の数を減らす
    const px = path.map(toPx);
    const even = [px[0], ...resample(px, unit * 0.012), px[px.length - 1]];
    return simplify(smooth(even, smoothness), unit * 0.003).map(fromPx);
  }

  /** なぞった線でマスを区切る（1本の線につき、通ったマスを1回ずつ） */
  function knife(path: Pt[]) {
    const f = frame();
    const unit = Math.min(f.iw, f.ih);
    const px0 = cutPath(path).map(toPx);
    const L = pathLen(px0);
    if (L < unit * 0.04) return null;
    // 線の両端を延ばして、マスの端まで届かせる（ただし、なぞった部分が通ったマスだけを切る）
    const E = Math.max(f.iw, f.ih) * 3;
    const px = extend(px0, E);
    let thin = false;
    const opts: CutOpts = { from: E, to: E + L, minIn: unit * 0.06, minArea: f.iw * f.ih * 0.012, minThick: unit * 0.07, onThin: () => (thin = true) };
    const out: Pt[][] = [];
    const outR: number[] = [];
    let made = 0;
    for (const [ci, c] of cells.entries()) {
      const pieces = out.length + (cells.length - out.length) < deps.maxCells ? cutPoly(c.map(toPx), px, opts) : [c.map(toPx)];
      const room = deps.maxCells - (cells.length + made);
      const use = pieces.length - 1 <= room ? pieces : [c.map(toPx)];
      made += use.length - 1;
      out.push(...use.map((p) => p.map(fromPx)));
      outR.push(...use.map(() => (use.length > 1 ? 0 : rots[ci] || 0)));
    }
    cells = out;
    rots = outR;
    return { made, thin };
  }

  // ---------- 操作 ----------

  type Drag =
    | { kind: 'draw'; pid: number; before: string }
    | { kind: 'move'; pid: number; before: string; start: Pt; orig: Pt[] }
    | { kind: 'scale'; pid: number; before: string; start: Pt; loc: Pt[]; c: Pt; a: number; bc: Pt }
    | { kind: 'rot'; pid: number; before: string; orig: Pt[]; c: Pt; a0: number; s0: number };
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
        const hs = handles();
        const hit = (h: Pt) => Math.hypot(e.clientX - r.left - h.x, e.clientY - r.top - h.y) < 20;
        const { c, a, b } = cellFrame(sel);
        const pp = toPx(p);
        if (hit(hs.rot)) {
          drag = { kind: 'rot', pid: e.pointerId, before, orig: cells[sel].map(toPx), c, a0: a, s0: Math.atan2(pp.y - c.y, pp.x - c.x) };
          draw();
          return;
        }
        if (hit(hs.scale)) {
          const loc = rotAround(cells[sel].map(toPx), c, -a);
          drag = { kind: 'scale', pid: e.pointerId, before, start: rotAround([pp], c, -a)[0], loc, c, a, bc: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } };
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
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      // 枠の外へはみ出さないようにする（枠より大きいマスはそのまま）
      const b = bbox(drag.orig);
      const lim = (d: number, lo: number, hi: number) => (hi - lo > 1 ? d : Math.min(1 - hi, Math.max(-lo, d)));
      dx = lim(dx, b.x0, b.x1);
      dy = lim(dy, b.y0, b.y1);
      cells[sel] = drag.orig.map((v) => ({ x: v.x + dx, y: v.y + dy }));
    } else if (drag.kind === 'rot') {
      const { c, a0, s0, orig } = drag;
      const pp = toPx(p);
      let ang = a0 + Math.atan2(pp.y - c.y, pp.x - c.x) - s0;
      // 15度ごとに吸い付く
      const step = Math.PI / 12;
      const snap = Math.round(ang / step) * step;
      if (Math.abs(ang - snap) < (4 * Math.PI) / 180) ang = snap;
      cells[sel] = rotAround(orig, c, ang - a0).map(fromPx);
      rots[sel] = ang;
    } else {
      // マスの向きにそろえて伸ばす（回したマスもゆがまない）
      const { c, a, bc, start, loc } = drag;
      const pl = rotAround([toPx(p)], c, -a)[0];
      const fx = (v: number, s: number, o: number) => {
        const d0 = s - o;
        return Math.abs(d0) < 1e-4 ? 1 : Math.min(8, Math.max(0.08, (v - o) / d0));
      };
      let sx = fx(pl.x, start.x, bc.x), sy = fx(pl.y, start.y, bc.y);
      if (lockAspect) {
        const d0 = Math.hypot(start.x - bc.x, start.y - bc.y) || 1;
        sx = sy = Math.min(8, Math.max(0.08, Math.hypot(pl.x - bc.x, pl.y - bc.y) / d0));
      }
      const scaled = loc.map((v) => ({ x: bc.x + (v.x - bc.x) * sx, y: bc.y + (v.y - bc.y) * sy }));
      cells[sel] = rotAround(scaled, c, a).map(fromPx);
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
          const r = knife(path);
          if (r && !r.made && path.length > 2)
            deps.toast(cells.length >= deps.maxCells ? `マスは最大${deps.maxCells}個までです` : r.thin ? '細すぎるマスになるので区切りませんでした。もう少し内側をなぞってください' : '区切るマスがありませんでした');
        } else {
          if (cells.length >= deps.maxCells) deps.toast(`マスは最大${deps.maxCells}個までです`);
          else {
            cells.push(shapeFor(path));
            rots.push(0);
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
    restore(s);
    sel = -1;
    dirty = true;
    syncUI();
  }
  function redo() {
    const s = future.pop();
    if (s == null) return;
    past.push(snapshot());
    restore(s);
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
      rots.push(rots[sel] || 0);
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
      rots[sel] = (rots[sel] || 0) + a;
    }),
  );
  q('#edDel').addEventListener(
    'click',
    act(() => {
      if (sel < 0) return;
      cells.splice(sel, 1);
      rots.splice(sel, 1);
      sel = -1;
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-cut]').forEach((b) =>
    b.addEventListener('click', () => {
      cutMode = b.dataset.cut as 'line' | 'curve';
      syncUI();
    }),
  );
  q<HTMLInputElement>('#edSmooth').addEventListener('input', () => {
    smoothness = Number(q<HTMLInputElement>('#edSmooth').value);
  });
  q('#edLock').addEventListener('click', () => {
    lockAspect = !lockAspect;
    syncUI();
  });
  // 整列：いまのマスを、位置の順番はそのままに、同じ大きさで格子にそろえる
  q('#edAlign').addEventListener(
    'click',
    act(() => {
      const n = cells.length;
      if (n < 2) return;
      const f = frame();
      const { c: slots, s: sz } = patternCenters('grid', n, f.iw, f.ih);
      const px = cells.map((c) => c.map(toPx));
      const info = px.map((p, i) => {
        const b = bbox(p);
        return { i, b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 };
      });
      // 上から行ごとに分け、行の中は左から（格子の行の数に合わせる）
      const ys = [...new Set(slots.map((p) => Math.round(p.y)))];
      const counts = ys.map((y) => slots.filter((p) => Math.round(p.y) === y).length);
      const byY = [...info].sort((a, b) => a.cy - b.cy);
      const order: typeof info = [];
      let k = 0;
      for (const cnt of counts) {
        order.push(...byY.slice(k, k + cnt).sort((a, b) => a.cx - b.cx));
        k += cnt;
      }
      const next = cells.slice();
      order.forEach((o, j) => {
        const t = slots[j];
        const m = Math.max(o.b.x1 - o.b.x0, o.b.y1 - o.b.y0) || 1;
        const sc = sz / m;
        next[o.i] = px[o.i].map((p) => fromPx({ x: t.x + (p.x - o.cx) * sc, y: t.y + (p.y - o.cy) * sc }));
      });
      cells = next;
    }),
  );
  // 自動配置：写真の枚数ぶん、選んだ図形を規則的に並べる（いまのマスは置き換え）
  root.querySelectorAll<HTMLButtonElement>('[data-pat]').forEach((b) =>
    b.addEventListener(
      'click',
      act(() => {
        const kind = (tool === 'select' || tool === 'knife' ? 'circle' : tool) as ShapeKind;
        const f = frame();
        // 多すぎると図形が小さくなるので、4〜6個にしぼる
        const n = Math.max(1, Math.min(6, deps.photos().length));
        const { c, s: sz } = patternCenters(b.dataset.pat as Pattern, n, f.iw, f.ih);
        setCells(c.map((p) => makeShape(kind, p.x, p.y, sz, sz).map(fromPx)));
        sel = -1;
      }),
    ),
  );
  q<HTMLSelectElement>('#edTpl').addEventListener('change', () => {
    const v = q<HTMLSelectElement>('#edTpl').value;
    if (!v) return;
    const before = snapshot();
    setCells(v === 'blank' ? [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]] : v === 'empty' ? [] : deps.templateCells(v).slice(0, deps.maxCells));
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
    setCells(c ? JSON.parse(JSON.stringify(c.cells)) : opts.fromLayout ? deps.templateCells(opts.fromLayout).slice(0, deps.maxCells) : [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]]);
    past = [];
    future = [];
    sel = -1;
    dirty = false;
    tool = c ? 'select' : 'knife';
    q<HTMLInputElement>('#edName').value = c ? c.name : `カスタム ${new Date().getMonth() + 1}/${new Date().getDate()}`;
    q<HTMLInputElement>('#edSmooth').value = String(smoothness);
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
