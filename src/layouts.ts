// 自動レイアウト。各レイアウトは「写真の縦横比の配列」から、キャンバス上のタイル（凸多角形）を作る。
import type { Pt, Tile } from './types';

export interface LayoutInput {
  W: number;
  H: number;
  /** 各写真の 横/縦 */
  aspects: number[];
  gap: number;
  margin: number;
  columns: number;
  seed: number;
  slant: number;
}

export interface LayoutDef {
  id: string;
  name: string;
  /** 「列数」を使う */
  usesColumns?: boolean;
  /** 「別パターン」で変化する */
  usesSeed?: boolean;
  /** 「斜めカット」を使える */
  slantable?: boolean;
  /** 角丸を使える */
  rounded?: boolean;
  build: (inp: LayoutInput) => Tile[];
}

type Rect = { x: number; y: number; w: number; h: number };

// ---------- 共通 ----------

export function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rectPoly = (r: Rect): Pt[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

/** 凸多角形を内側に d だけ縮める */
export function insetPoly(poly: Pt[], d: number, miterLimit = Infinity): Pt[] {
  if (d <= 0) return poly;
  const n = poly.length;
  // 向き（時計回りかどうか）
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  const s = area > 0 ? 1 : -1;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // 内向き法線
    const nx = (-(b.y - a.y) / len) * s, ny = ((b.x - a.x) / len) * s;
    return { p: { x: a.x + nx * d, y: a.y + ny * d }, v: { x: b.x - a.x, y: b.y - a.y } };
  });
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i + n - 1) % n], l2 = lines[i];
    const den = l1.v.x * l2.v.y - l1.v.y * l2.v.x;
    if (Math.abs(den) < 1e-9) {
      out.push(l2.p);
      continue;
    }
    const t = ((l2.p.x - l1.p.x) * l2.v.y - (l2.p.y - l1.p.y) * l2.v.x) / den;
    const q = { x: l1.p.x + l1.v.x * t, y: l1.p.y + l1.v.y * t };
    // 鋭い角（凹んだ形の切り口など）で、点が遠くへ飛ばないようにする
    if (Math.hypot(q.x - poly[i].x, q.y - poly[i].y) > d * miterLimit) {
      // 角の両側の辺を d だけずらした点の中間を使う
      const m1 = { x: l1.p.x + l1.v.x, y: l1.p.y + l1.v.y };
      out.push({ x: (m1.x + l2.p.x) / 2, y: (m1.y + l2.p.y) / 2 });
      continue;
    }
    out.push(q);
  }
  return out;
}

function polyToTile(idx: number, poly: Pt[], frame?: number): Tile {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { idx, cx, cy, w: x1 - x0, h: y1 - y0, rot: 0, clip: poly.map((p) => ({ x: p.x - cx, y: p.y - cy })), frame };
}

/** 枠内を隙間なく分割した長方形に、余白とすき間を適用してタイルにする */
function finish(inp: LayoutInput, rects: Rect[], slantable = true): Tile[] {
  const { W, H, gap, margin } = inp;
  const ox = margin - gap / 2, oy = margin - gap / 2;
  const iw = W - ox * 2, ih = H - oy * 2;
  const k = Math.tan((inp.slant * Math.PI) / 180);
  const eps = 0.5;
  // 斜めカット：内側の縦の境界線だけを傾ける
  const sl = (p: Pt): Pt => {
    if (!slantable || !k || p.x < ox + eps || p.x > ox + iw - eps) return p;
    const nx = p.x + (p.y - (oy + ih / 2)) * k;
    return { x: Math.min(ox + iw, Math.max(ox, nx)), y: p.y };
  };
  return rects.map((r, i) => {
    const poly = rectPoly({ x: ox + r.x * iw, y: oy + r.y * ih, w: r.w * iw, h: r.h * ih }).map(sl);
    return polyToTile(i, insetPoly(poly, gap / 2));
  });
}

/** 0..1 の枠内座標で、外枠の縦横比 */
const innerAspect = (inp: LayoutInput) => (inp.W - inp.margin * 2 + inp.gap) / (inp.H - inp.margin * 2 + inp.gap);

/** 数列を k 個の連続したグループに分け、各グループの合計をなるべく揃える */
function linearPartition(vals: number[], k: number): number[][] {
  const n = vals.length;
  if (k >= n) return vals.map((v) => [v]);
  if (k <= 1) return [vals.slice()];
  const pre = [0];
  for (const v of vals) pre.push(pre[pre.length - 1] + v);
  const cost: number[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(0));
  for (let i = 1; i <= n; i++) cost[i][1] = pre[i];
  for (let j = 2; j <= k; j++)
    for (let i = j; i <= n; i++)
      for (let x = j - 1; x < i; x++) {
        const c = Math.max(cost[x][j - 1], pre[i] - pre[x]);
        if (c < cost[i][j]) {
          cost[i][j] = c;
          cut[i][j] = x;
        }
      }
  const out: number[][] = [];
  let i = n;
  for (let j = k; j >= 1; j--) {
    const x = j === 1 ? 0 : cut[i][j];
    out.unshift(vals.slice(x, i));
    i = x;
  }
  return out;
}

// ---------- レイアウト ----------

function grid(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  const A = innerAspect(inp);
  const med = [...inp.aspects].sort((a, b) => a - b)[Math.floor(n / 2)] || 1;
  let cols = inp.columns;
  if (!cols) {
    let best = Infinity;
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const cell = A / c / (1 / r);
      const empty = c * r - n;
      const cost = Math.abs(Math.log(cell / med)) + empty * 0.12;
      if (cost < best) {
        best = cost;
        cols = c;
      }
    }
  }
  cols = Math.min(cols, n);
  const rows = Math.ceil(n / cols);
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const c = i - r * cols;
    rects.push({ x: c / inRow, y: r / rows, w: 1 / inRow, h: 1 / rows });
  }
  return finish(inp, rects);
}

function justified(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  const A = innerAspect(inp);
  let best: number[][] = [inp.aspects];
  let bestCost = Infinity;
  for (let k = 1; k <= n; k++) {
    const rows = linearPartition(inp.aspects, k);
    // 各行の高さ（幅1に揃えたとき）= 1/Σaspect、全体の高さ = Σ
    const hsum = rows.reduce((s, r) => s + 1 / r.reduce((a, b) => a + b, 0), 0);
    const cost = Math.abs(Math.log(hsum * A));
    if (cost < bestCost) {
      bestCost = cost;
      best = rows;
    }
  }
  const hs = best.map((r) => 1 / r.reduce((a, b) => a + b, 0));
  const total = hs.reduce((a, b) => a + b, 0);
  const rects: Rect[] = [];
  let y = 0;
  best.forEach((row, ri) => {
    const rh = hs[ri] / total;
    const sum = row.reduce((a, b) => a + b, 0);
    let x = 0;
    for (const a of row) {
      rects.push({ x, y, w: a / sum, h: rh });
      x += a / sum;
    }
    y += rh;
  });
  return finish(inp, rects);
}

function masonry(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  const A = innerAspect(inp);
  let cols = inp.columns;
  if (!cols) {
    const avg = inp.aspects.reduce((a, b) => a + b, 0) / n;
    // 1列あたり n/cols 枚、縦に積んだ高さが全体に合う列数
    let best = Infinity;
    for (let c = 1; c <= n; c++) {
      const hh = (n / c) * (1 / c / avg) * A;
      const cost = Math.abs(Math.log(hh));
      if (cost < best) {
        best = cost;
        cols = c;
      }
    }
  }
  cols = Math.min(cols, n);
  const colItems: number[][] = Array.from({ length: cols }, () => []);
  const colH = new Array(cols).fill(0);
  inp.aspects.forEach((a, i) => {
    let c = 0;
    for (let j = 1; j < cols; j++) if (colH[j] < colH[c] - 1e-9) c = j;
    colItems[c].push(i);
    colH[c] += 1 / a;
  });
  const rects: Rect[] = new Array(n);
  colItems.forEach((items, c) => {
    let y = 0;
    for (const i of items) {
      const h = 1 / inp.aspects[i] / colH[c];
      rects[i] = { x: c / cols, y, w: 1 / cols, h };
      y += h;
    }
  });
  return finish(inp, rects);
}

/** 縦横比に合わせて再帰的に二分割するモザイク */
function mosaicRects(aspects: number[], box: Rect, seed: number, boxAspect: number): Rect[] {
  const rand = rng(seed);
  const memo = new Map<string, { cost: number; split: number; dir: 'h' | 'v' }>();
  // 分割位置の候補（seed で揺らす）
  const jitter = aspects.map(() => rand());
  const solve = (lo: number, hi: number, ar: number): number => {
    const n = hi - lo;
    if (n === 1) return Math.abs(Math.log(ar / aspects[lo])) ** 1.5;
    const key = `${lo},${hi},${ar.toFixed(3)}`;
    const m = memo.get(key);
    if (m) return m.cost;
    let best = { cost: Infinity, split: lo + 1, dir: 'v' as 'h' | 'v' };
    const mid = lo + n / 2;
    const cands = new Set([Math.floor(mid), Math.ceil(mid), Math.round(lo + n * (0.3 + jitter[lo] * 0.4))]);
    for (const s of cands) {
      if (s <= lo || s >= hi) continue;
      const f = (s - lo) / n;
      for (const dir of ['v', 'h'] as const) {
        // v: 左右に分割、h: 上下に分割。面積は枚数に比例
        const a1 = dir === 'v' ? ar * f : ar / f;
        const a2 = dir === 'v' ? ar * (1 - f) : ar / (1 - f);
        const c = solve(lo, s, a1) * f + solve(s, hi, a2) * (1 - f) + jitter[(s + (dir === 'v' ? 1 : 0)) % n] * 0.05;
        if (c < best.cost) best = { cost: c, split: s, dir };
      }
    }
    memo.set(key, best);
    return best.cost;
  };
  const out: Rect[] = new Array(aspects.length);
  const place = (lo: number, hi: number, r: Rect, ar: number) => {
    if (hi - lo === 1) {
      out[lo] = r;
      return;
    }
    solve(lo, hi, ar);
    const m = memo.get(`${lo},${hi},${ar.toFixed(3)}`)!;
    const f = (m.split - lo) / (hi - lo);
    if (m.dir === 'v') {
      place(lo, m.split, { x: r.x, y: r.y, w: r.w * f, h: r.h }, ar * f);
      place(m.split, hi, { x: r.x + r.w * f, y: r.y, w: r.w * (1 - f), h: r.h }, ar * (1 - f));
    } else {
      place(lo, m.split, { x: r.x, y: r.y, w: r.w, h: r.h * f }, ar / f);
      place(m.split, hi, { x: r.x, y: r.y + r.h * f, w: r.w, h: r.h * (1 - f) }, ar / (1 - f));
    }
  };
  place(0, aspects.length, box, boxAspect);
  return out;
}

function mosaic(inp: LayoutInput): Tile[] {
  return finish(inp, mosaicRects(inp.aspects, { x: 0, y: 0, w: 1, h: 1 }, inp.seed, innerAspect(inp)));
}

function hero(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  if (n === 1) return finish(inp, [{ x: 0, y: 0, w: 1, h: 1 }]);
  const A = innerAspect(inp);
  const rest = inp.aspects.slice(1);
  const f = n <= 3 ? 0.6 : n <= 8 ? 0.64 : 0.55;
  let rects: Rect[];
  if (A >= 1) {
    const sub = mosaicRects(rest, { x: f, y: 0, w: 1 - f, h: 1 }, inp.seed, A * (1 - f));
    rects = [{ x: 0, y: 0, w: f, h: 1 }, ...sub];
  } else {
    const sub = mosaicRects(rest, { x: 0, y: f, w: 1, h: 1 - f }, inp.seed, A / (1 - f));
    rects = [{ x: 0, y: 0, w: 1, h: f }, ...sub];
  }
  return finish(inp, rects);
}

/** 黄金比で切り出していくスパイラル */
function spiral(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  const rects: Rect[] = [];
  let r: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const A = innerAspect(inp);
  const PHI = 0.6180339887;
  // 小さくなりすぎないよう、スパイラルにする枚数を制限して残りはモザイクに。
  // 面積は黄金比で小さくなり、残りのグループは枚数に応じた面積を確保する
  const spiralCount = Math.min(n - 1, 5);
  const PHI_L = 1 / PHI;
  const weights = Array.from({ length: spiralCount }, (_, i) => PHI_L ** (spiralCount - i));
  const restWeight = Math.max(1, (n - spiralCount) * 0.9);
  for (let i = 0; i < spiralCount; i++) {
    const remain = weights.slice(i).reduce((a, b) => a + b, 0) + restWeight;
    const f = weights[i] / remain;
    const dir = i % 4; // 0:左 1:上 2:右 3:下
    // 実寸での縦横比
    const ra = (r.w * A) / r.h;
    const horizontalCut = dir === 0 || dir === 2 ? ra >= 0.5 : ra > 2;
    if (horizontalCut) {
      const w = r.w * f;
      if (dir === 2) {
        rects.push({ x: r.x + r.w - w, y: r.y, w, h: r.h });
        r = { ...r, w: r.w - w };
      } else {
        rects.push({ x: r.x, y: r.y, w, h: r.h });
        r = { ...r, x: r.x + w, w: r.w - w };
      }
    } else {
      const h = r.h * f;
      if (dir === 3) {
        rects.push({ x: r.x, y: r.y + r.h - h, w: r.w, h });
        r = { ...r, h: r.h - h };
      } else {
        rects.push({ x: r.x, y: r.y, w: r.w, h });
        r = { ...r, y: r.y + h, h: r.h - h };
      }
    }
  }
  const rest = inp.aspects.slice(spiralCount);
  rects.push(...mosaicRects(rest, r, inp.seed, (r.w * A) / r.h));
  return finish(inp, rects);
}

function honeycomb(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  const { W, H, margin, gap } = inp;
  const iw = W - margin * 2, ih = H - margin * 2;
  const S3 = Math.sqrt(3);
  let best = { R: 0, cols: 1, rows: n };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    // 尖った頂点が上下のヘキサゴン：幅 √3R、高さ 2R、行間 1.5R
    const wNeed = S3 * (cols + (rows > 1 ? 0.5 : 0));
    const hNeed = 2 + 1.5 * (rows - 1);
    const R = Math.min(iw / wNeed, ih / hNeed);
    if (R > best.R) best = { R, cols, rows };
  }
  const { R, cols, rows } = best;
  const hw = (S3 * R) / 2;
  const totalH = R * (2 + 1.5 * (rows - 1));
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const odd = row % 2 === 1;
    const rowW = S3 * R * inRow + (rows > 1 && odd ? 0 : 0);
    const fullW = S3 * R * (cols + (rows > 1 ? 0.5 : 0));
    const x0 = margin + (iw - fullW) / 2 + (odd ? hw : 0) + (inRow < cols ? (S3 * R * cols - rowW) / 2 : 0);
    const cx = x0 + hw + (i - row * cols) * S3 * R;
    const cy = margin + (ih - totalH) / 2 + R + row * 1.5 * R;
    const poly: Pt[] = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3 - Math.PI / 2;
      poly.push({ x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R });
    }
    tiles.push(polyToTile(i, insetPoly(poly, gap / 2)));
  }
  return tiles;
}

/** 写真をテーブルに散らしたようなレイアウト（白フチ・回転付き、写真の比率を保つ） */
function scatter(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  const { W, H, margin } = inp;
  const rand = rng(inp.seed + 7);
  const iw = W - margin * 2, ih = H - margin * 2;
  // 格子状に配置し、少しずらして回転
  let cols = 1;
  let bestC = Infinity;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const cost = Math.abs(Math.log(iw / c / (ih / r)));
    if (cost < bestC) {
      bestC = cost;
      cols = c;
    }
  }
  const rows = Math.ceil(n / cols);
  const cw = iw / cols, ch = ih / rows;
  const tiles: Tile[] = [];
  const order = inp.aspects.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const c = i - r * cols;
    const a = inp.aspects[order[i]];
    // セルより一回り大きく（重なりを作る）
    const scale = n === 1 ? 0.92 : 1.18;
    let w = cw * scale, h = w / a;
    if (h > ch * scale) {
      h = ch * scale;
      w = h * a;
    }
    const frame = Math.min(w, h) * 0.045;
    const rowOff = (iw - inRow * cw) / 2;
    const cx = margin + rowOff + cw * (c + 0.5) + (rand() - 0.5) * cw * 0.18;
    const cy = margin + ch * (r + 0.5) + (rand() - 0.5) * ch * 0.18;
    const rot = n === 1 ? 0 : ((rand() - 0.5) * 16 * Math.PI) / 180;
    // 回転後もキャンバス内に収まるように縮める
    const ext = (ww: number, hh: number) => ({
      x: (Math.abs(Math.cos(rot)) * ww + Math.abs(Math.sin(rot)) * hh) / 2 + frame,
      y: (Math.abs(Math.sin(rot)) * ww + Math.abs(Math.cos(rot)) * hh) / 2 + frame,
    });
    let e = ext(w, h);
    const lim = Math.min(
      (cx - margin * 0.5) / e.x,
      (W - margin * 0.5 - cx) / e.x,
      (cy - margin * 0.5) / e.y,
      (H - margin * 0.5 - cy) / e.y,
      1,
    );
    w *= lim;
    h *= lim;
    e = ext(w, h);
    tiles.push({
      idx: order[i],
      cx,
      cy,
      w,
      h,
      rot,
      clip: rectPoly({ x: -w / 2, y: -h / 2, w, h }),
      frame: frame * lim,
    });
  }
  return tiles;
}

/** 写真の比率のまま、円の中に収める「ドット」レイアウト */
function circles(inp: LayoutInput): Tile[] {
  const n = inp.aspects.length;
  const { W, H, margin, gap } = inp;
  const iw = W - margin * 2, ih = H - margin * 2;
  // 大小の円：先頭ほど大きく
  const rand = rng(inp.seed + 3);
  const weights = inp.aspects.map((_, i) => 1 / Math.sqrt(1 + i * 0.35) * (0.85 + rand() * 0.3));
  const wsum = weights.reduce((a, b) => a + b * b, 0);
  // 面積の 62% 程度を埋める
  const k = Math.sqrt((iw * ih * 0.62) / (Math.PI * wsum));
  const radii = weights.map((w) => w * k);
  const placed: { x: number; y: number; r: number }[] = new Array(n);
  const list: { x: number; y: number; r: number }[] = [];
  const order = radii.map((_, i) => i).sort((a, b) => radii[b] - radii[a]);
  for (const i of order) {
    let r = radii[i];
    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      let best: { x: number; y: number; d: number } | null = null;
      for (let t = 0; t < 600; t++) {
        const x = margin + r + rand() * Math.max(0, iw - 2 * r);
        const y = margin + r + rand() * Math.max(0, ih - 2 * r);
        let ok = true;
        let near = Infinity;
        for (const p of list) {
          const d = Math.hypot(p.x - x, p.y - y) - p.r - r - gap;
          if (d < 0) {
            ok = false;
            break;
          }
          near = Math.min(near, d);
        }
        if (!ok) continue;
        // 中心寄り・他の円に寄せる
        const score = (list.length ? near : 0) + Math.hypot(x - W / 2, y - H / 2) * 0.15;
        if (!best || score < best.d) best = { x, y, d: score };
      }
      if (best) {
        placed[i] = { x: best.x, y: best.y, r };
        list.push(placed[i]);
        done = true;
      } else r *= 0.85;
    }
    if (!done) placed[i] = { x: W / 2, y: H / 2, r: r * 0.5 };
  }
  return placed.map((p, i) => {
    const poly: Pt[] = [];
    const seg = 48;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      poly.push({ x: Math.cos(a) * p.r, y: Math.sin(a) * p.r });
    }
    return { idx: i, cx: p.x, cy: p.y, w: p.r * 2, h: p.r * 2, rot: 0, clip: poly };
  });
}

export const LAYOUTS: LayoutDef[] = [
  { id: 'mosaic', name: 'モザイク', build: mosaic, usesSeed: true, slantable: true, rounded: true },
  { id: 'justified', name: '行そろえ', build: justified, slantable: true, rounded: true },
  { id: 'grid', name: 'グリッド', build: grid, usesColumns: true, slantable: true, rounded: true },
  { id: 'masonry', name: 'マソンリー', build: masonry, usesColumns: true, rounded: true },
  { id: 'hero', name: '主役＋脇役', build: hero, usesSeed: true, slantable: true, rounded: true },
  { id: 'spiral', name: '黄金スパイラル', build: spiral, usesSeed: true, slantable: true, rounded: true },
  { id: 'honeycomb', name: 'ハニカム', build: honeycomb, rounded: true },
  { id: 'circles', name: 'ドット', build: circles, usesSeed: true },
  { id: 'scatter', name: '散らし', build: scatter, usesSeed: true },
];

export const getLayout = (id: string): LayoutDef => {
  if (id.startsWith('custom:')) {
    const c = getCustom(id.slice(7));
    if (c) return customDef(c);
  }
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
};

export function pointInTile(t: Tile, x: number, y: number) {
  const c = Math.cos(-t.rot), s = Math.sin(-t.rot);
  const dx = x - t.cx, dy = y - t.cy;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  let inside = false;
  const p = t.clip;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (p[i].y > ly !== p[j].y > ly && lx < ((p[j].x - p[i].x) * (ly - p[i].y)) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
  }
  return inside;
}

// ---------- カスタムレイアウト ----------

/** 自分で作ったレイアウト。マスは外枠（余白の内側）を 0..1 とした凸多角形 */
export interface CustomLayout {
  id: string;
  name: string;
  cells: Pt[][];
}

const CUSTOM_KEY = 'photo-tile-maker:custom-layouts';
let customs: CustomLayout[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.cells)) : [];
  } catch {
    return [];
  }
})();
function storeCustoms() {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customs));
  } catch {
    /* 保存できない環境では、このページを開いている間だけ使える */
  }
}
export const customLayouts = () => customs;
export const getCustom = (id: string) => customs.find((c) => c.id === id) ?? null;
export function saveCustom(c: CustomLayout) {
  const i = customs.findIndex((x) => x.id === c.id);
  if (i >= 0) customs[i] = c;
  else customs.push(c);
  storeCustoms();
}
export function deleteCustom(id: string) {
  customs = customs.filter((c) => c.id !== id);
  storeCustoms();
}

/** マス（0..1）を、余白とすき間を付けたタイルにする */
export function cellsToTiles(cells: Pt[][], inp: Pick<LayoutInput, 'W' | 'H' | 'gap' | 'margin'>): Tile[] {
  const { W, H, gap, margin } = inp;
  const ox = margin - gap / 2, oy = margin - gap / 2;
  const iw = W - ox * 2, ih = H - oy * 2;
  return cells.map((cell, i) => {
    const poly = cell.map((p) => ({ x: ox + p.x * iw, y: oy + p.y * ih }));
    // 外枠に接する辺は余白の位置ちょうどになるよう、すき間の半分だけ縮める
    return polyToTile(i, insetPoly(poly, gap / 2, isConvex(poly) ? Infinity : 3));
  });
}

/** 凸多角形かどうか */
function isConvex(poly: Pt[]) {
  let sign = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

export function customDef(c: CustomLayout): LayoutDef {
  return { id: `custom:${c.id}`, name: c.name, rounded: true, build: (inp) => cellsToTiles(c.cells, inp) };
}

/** 既定のレイアウトと自作のレイアウト */
export const allLayouts = (): LayoutDef[] => [...LAYOUTS, ...customs.map(customDef)];

/** 既存のレイアウトを、すき間・余白なしのマス（0..1）に直す（カスタム作成のひな形用） */
export function layoutToCells(def: LayoutDef, aspects: number[], W: number, H: number, seed: number, columns: number): Pt[][] {
  const ts = def.build({ W, H, aspects, gap: 0, margin: 0, columns: def.usesColumns ? columns : 0, seed, slant: 0 });
  return ts.map((t) => {
    const c = Math.cos(t.rot), s = Math.sin(t.rot);
    return t.clip.map((p) => ({ x: (t.cx + p.x * c - p.y * s) / W, y: (t.cy + p.x * s + p.y * c) / H }));
  });
}
