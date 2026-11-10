// 写真の色・明るさと構図を、縮小画像（長辺 128px）から推定する。
import type { ColorStats, CompType, Composition, Pt } from './types';

export const COMP_LABELS: Record<CompType, string> = {
  center: '日の丸構図',
  thirds: '三分割構図',
  golden: '黄金比構図',
  diagonal: '対角線構図',
  horizon: '水平線構図',
  symmetry: 'シンメトリー構図',
};

const PHI = 0.6180339887;
const ANALYZE_EDGE = 128;

export interface Analysis {
  stats: ColorStats;
  comp: Composition;
}

function smallData(src: CanvasImageSource & { width: number; height: number }) {
  const s = ANALYZE_EDGE / Math.max(src.width, src.height);
  const w = Math.max(8, Math.round(src.width * s));
  const h = Math.max(8, Math.round(src.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, w, h);
  return { w, h, d: x.getImageData(0, 0, w, h).data };
}

export const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

// ---------- 色 ----------

function colorStats(w: number, h: number, d: Uint8ClampedArray): ColorStats {
  const n = w * h;
  let sr = 0, sg = 0, sb = 0, sl = 0, ss = 0;
  // 色相ヒストグラム（彩度で重み付け）
  const bins = new Float32Array(36);
  // 簡易パレット：RGB 各4段階のビン
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    sr += r;
    sg += g;
    sb += b;
    sl += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const [hh, s, l] = rgbToHsl(r, g, b);
    const ws = s * (1 - Math.abs(l - 0.5) * 2);
    ss += ws;
    bins[Math.floor(hh / 10) % 36] += ws;
    const key = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
    const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bk.n++;
    bk.r += r;
    bk.g += g;
    bk.b += b;
    buckets.set(key, bk);
  }
  // 色相：ピーク付近の加重平均（隣接ビンでなめらかに）
  let best = 0, bestV = -1;
  for (let i = 0; i < 36; i++) {
    const v = bins[(i + 35) % 36] * 0.5 + bins[i] + bins[(i + 1) % 36] * 0.5;
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  const palette = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((b) => toHex(b.r / b.n, b.g / b.n, b.b / b.n));
  return {
    lum: sl / n,
    hue: best * 10 + 5,
    sat: ss / n,
    avg: [sr / n, sg / n, sb / n],
    palette,
  };
}

// ---------- 構図 ----------

/** 箱型ぼかし（半径 r、縦横分離） */
function blur(a: Float32Array, w: number, h: number, r: number) {
  const t = new Float32Array(a.length);
  const o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let s = 0, c = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) {
      s += a[y * w + x];
      c++;
    }
    for (let x = 0; x < w; x++) {
      t[y * w + x] = s / c;
      const add = x + r + 1, rem = x - r;
      if (add < w) {
        s += a[y * w + add];
        c++;
      }
      if (rem >= 0) {
        s -= a[y * w + rem];
        c--;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) {
      s += t[y * w + x];
      c++;
    }
    for (let y = 0; y < h; y++) {
      o[y * w + x] = s / c;
      const add = y + r + 1, rem = y - r;
      if (add < h) {
        s += t[add * w + x];
        c++;
      }
      if (rem >= 0) {
        s -= t[rem * w + x];
        c--;
      }
    }
  }
  return o;
}

/** 値の分布の p 分位点 */
function quantile(a: Float32Array, p: number) {
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
}

/** sRGB → CIE Lab（L は 0..100） */
function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** 判別分析法（大津）でしきい値を求める（値は 0..1） */
function otsu(a: Float32Array) {
  const bins = new Float64Array(64);
  for (const v of a) bins[Math.min(63, Math.max(0, Math.floor(v * 64)))]++;
  const n = a.length;
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += i * bins[i];
  let wB = 0, sB = 0, best = 0, thr = 32;
  for (let i = 0; i < 64; i++) {
    wB += bins[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sB += i * bins[i];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) {
      best = v;
      thr = i;
    }
  }
  return (thr + 1) / 64;
}

interface Line {
  /** 線上の2点（ピクセル座標、画像の端から端まで） */
  a: Pt;
  b: Pt;
  /** 線の向き（ラジアン、0..π、0 = 水平） */
  angle: number;
  /** 線上でエッジが続いている長さ（ピクセル） */
  support: number;
  /** 画像内での線の長さ（ピクセル） */
  chord: number;
}

/** 直線 x·cosθ + y·sinθ = ρ を画像の矩形で切り取った両端 */
function clipLine(theta: number, rho: number, w: number, h: number): [Pt, Pt] | null {
  const c = Math.cos(theta), s = Math.sin(theta);
  const pts: Pt[] = [];
  const push = (x: number, y: number) => {
    if (x >= -1e-6 && x <= w + 1e-6 && y >= -1e-6 && y <= h + 1e-6 && !pts.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-3)) pts.push({ x, y });
  };
  if (Math.abs(s) > 1e-6) {
    push(0, rho / s);
    push(w, (rho - w * c) / s);
  }
  if (Math.abs(c) > 1e-6) {
    push(rho / c, 0);
    push((rho - h * s) / c, h);
  }
  if (pts.length < 2) return null;
  let best: [Pt, Pt] = [pts[0], pts[1]], bd = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > bd) {
        bd = d;
        best = [pts[i], pts[j]];
      }
    }
  return best;
}

/**
 * 簡易ハフ変換：長く続く直線を探す。
 * 各エッジ画素は、自分の勾配の向き（±1ビン）にだけ投票するので、ノイズに強い。
 */
function findLines(w: number, h: number, gx: Float32Array, gy: Float32Array, mag: Float32Array, thr: number): Line[] {
  const NT = 90;
  const diag = Math.ceil(Math.hypot(w, h));
  const NR = diag * 2 + 1;
  const acc = new Float32Array(NT * NR);
  const cs = Array.from({ length: NT }, (_, i) => Math.cos((i * Math.PI) / NT));
  const sn = Array.from({ length: NT }, (_, i) => Math.sin((i * Math.PI) / NT));
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      let phi = Math.atan2(gy[i], gx[i]);
      if (phi < 0) phi += Math.PI;
      const tb = Math.round((phi / Math.PI) * NT);
      for (let k = -1; k <= 1; k++) {
        const t = (((tb + k) % NT) + NT) % NT;
        const rho = (x + 0.5) * cs[t] + (y + 0.5) * sn[t];
        acc[t * NR + Math.round(rho) + diag] += k === 0 ? 1 : 0.5;
      }
    }
  // 近傍で最大の山を順に取り出す
  const lines: Line[] = [];
  for (let iter = 0; iter < 6; iter++) {
    let bi = -1, bv = 0;
    for (let i = 0; i < acc.length; i++) {
      // ρ方向に3つまとめて数える（輪郭がぼけて2〜3画素に分かれるため）
      const v = acc[i] + (i % NR ? acc[i - 1] * 0.5 : 0) + ((i + 1) % NR ? acc[i + 1] * 0.5 : 0);
      if (v > bv) {
        bv = v;
        bi = i;
      }
    }
    if (bi < 0 || bv < Math.min(w, h) * 0.25) break;
    const t = Math.floor(bi / NR), r = (bi % NR) - diag;
    const theta = (t * Math.PI) / NT;
    const seg = clipLine(theta, r, w, h);
    // 周辺を消す
    for (let dt = -4; dt <= 4; dt++)
      for (let dr = -4; dr <= 4; dr++) {
        const tt = (((t + dt) % NT) + NT) % NT;
        const rr = r + dr + diag;
        if (rr >= 0 && rr < NR) acc[tt * NR + rr] = 0;
      }
    if (!seg) continue;
    const chord = Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y);
    if (chord < 4) continue;
    // 線に沿って歩き、同じ向きのエッジが実際に続いている割合を数える
    const nx = Math.cos(theta), ny = Math.sin(theta);
    const steps = Math.floor(chord);
    let hits = 0;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const px = seg[0].x + (seg[1].x - seg[0].x) * t - 0.5, py = seg[0].y + (seg[1].y - seg[0].y) * t - 0.5;
      for (let o = -1.5; o <= 1.5; o += 0.75) {
        const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const i = y * w + x;
        if (mag[i] < thr) continue;
        // 勾配が線の法線と同じ向き（±17°）
        if (Math.abs(gx[i] * nx + gy[i] * ny) / mag[i] > 0.95) {
          hits++;
          break;
        }
      }
    }
    // 線の向きは法線（θ）に直交
    let angle = theta + Math.PI / 2;
    if (angle >= Math.PI) angle -= Math.PI;
    lines.push({ a: seg[0], b: seg[1], angle, support: hits, chord });
  }
  return lines;
}

function composition(w: number, h: number, d: Uint8ClampedArray): Composition {
  const n = w * h;
  const m = Math.min(w, h);
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = toLab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    L[i] = l;
    A[i] = a;
    B[i] = b;
  }
  const bl = blur(L, w, h, 1), ba = blur(A, w, h, 1), bb = blur(B, w, h, 1);

  // ---- 勾配（明るさ＋色） ----
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  const sob = (arr: Float32Array, i: number) => [
    arr[i + 1 - w] + 2 * arr[i + 1] + arr[i + 1 + w] - arr[i - 1 - w] - 2 * arr[i - 1] - arr[i - 1 + w],
    arr[i + w - 1] + 2 * arr[i + w] + arr[i + w + 1] - arr[i - w - 1] - 2 * arr[i - w] - arr[i - w + 1],
  ];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const [lx, ly] = sob(bl, i), [ax, ay] = sob(ba, i), [bx, by] = sob(bb, i);
      // 一番強いチャンネルの向きを採用（色だけが違う境界も拾う）
      const ml = Math.hypot(lx, ly), mc = Math.hypot(ax, ay) * 0.7, mb = Math.hypot(bx, by) * 0.7;
      if (ml >= mc && ml >= mb) {
        gx[i] = lx;
        gy[i] = ly;
        mag[i] = ml;
      } else if (mc >= mb) {
        gx[i] = ax;
        gy[i] = ay;
        mag[i] = mc;
      } else {
        gx[i] = bx;
        gy[i] = by;
        mag[i] = mb;
      }
    }

  // ---- 顕著性マップ ----
  // 1) 背景との差：画像の外周の色を背景の見本とし、どの見本とも違う所を目立つとする
  //    （空のグラデーションのように場所で色が変わる背景にも対応）
  const samples: [number, number, number][] = [];
  const perim: number[] = [];
  for (let x = 0; x < w; x++) perim.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) perim.push(y * w, y * w + w - 1);
  const stepS = Math.max(1, Math.floor(perim.length / 160));
  for (let k = 0; k < perim.length; k += stepS) {
    const i = perim[k];
    samples.push([bl[i], ba[i], bb[i]]);
  }
  const bgd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let mn = Infinity;
    const l0 = bl[i], a0 = ba[i], b0 = bb[i];
    for (const [l, a, b] of samples) {
      const dd = (l0 - l) * (l0 - l) * 0.64 + (a0 - a) * (a0 - a) + (b0 - b) * (b0 - b);
      if (dd < mn) mn = dd;
    }
    bgd[i] = Math.sqrt(mn);
  }
  // 2) 局所コントラスト：まわりとの色の差
  const sl = blur(L, w, h, 2), sa = blur(A, w, h, 2), sb = blur(B, w, h, 2);
  const ll = blur(L, w, h, Math.round(m / 6)), la = blur(A, w, h, Math.round(m / 6)), lb = blur(B, w, h, Math.round(m / 6));
  const loc = new Float32Array(n);
  for (let i = 0; i < n; i++) loc[i] = Math.hypot((sl[i] - ll[i]) * 0.8, sa[i] - la[i], sb[i] - lb[i]);
  // 3) 細部の密度（ピントの合った被写体は細かいエッジが多い）
  const det = blur(mag, w, h, 3);
  const norm = (a: Float32Array) => {
    const q = Math.max(1e-6, quantile(a, 0.98));
    for (let i = 0; i < a.length; i++) a[i] = Math.min(1, a[i] / q);
    return a;
  };
  norm(bgd);
  norm(loc);
  norm(det);
  let sal = new Float32Array(n);
  for (let i = 0; i < n; i++) sal[i] = bgd[i] * 0.5 + loc[i] * 0.3 + det[i] * 0.2;
  sal = blur(sal, w, h, 1);
  norm(sal);

  // ---- 主被写体：しきい値で切り出した領域のうち、最も目立つまとまり ----
  const thr = Math.max(otsu(sal), quantile(sal, 0.75));
  const label = new Int32Array(n).fill(-1);
  const blobs: { mass: number; sx: number; sy: number; area: number; minx: number; maxx: number; miny: number; maxy: number; border: number }[] = [];
  const stack: number[] = [];
  for (let i0 = 0; i0 < n; i0++) {
    if (label[i0] >= 0 || sal[i0] < thr) continue;
    const id = blobs.length;
    const bk = { mass: 0, sx: 0, sy: 0, area: 0, minx: w, maxx: 0, miny: h, maxy: 0, border: 0 };
    label[i0] = id;
    stack.push(i0);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      const v = sal[i] - thr * 0.5;
      bk.mass += v;
      bk.sx += v * (x + 0.5);
      bk.sy += v * (y + 0.5);
      bk.area++;
      if (x < bk.minx) bk.minx = x;
      if (x > bk.maxx) bk.maxx = x;
      if (y < bk.miny) bk.miny = y;
      if (y > bk.maxy) bk.maxy = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) bk.border++;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
        if (j >= 0 && label[j] < 0 && sal[j] >= thr) {
          label[j] = id;
          stack.push(j);
        }
    }
    blobs.push(bk);
  }
  // 画面の端に大きく接している領域（背景の一部であることが多い）は割り引く
  // 強く目立つまとまりを優先（平均の強さで重み付け）
  // 画面を端から端まで横切る帯（稜線や境界）は、主被写体ではなく線として扱う
  const blobScore = (b: (typeof blobs)[number]) => {
    const sp = Math.max((b.maxx - b.minx + 1) / w, (b.maxy - b.miny + 1) / h);
    return b.mass * (b.mass / b.area) ** 2 * (1 - Math.min(0.8, (b.border / (2 * (w + h))) * 3)) * (sp > 0.85 ? 0.25 : 1);
  };
  let main = blobs[0];
  for (const b of blobs) if (blobScore(b) > blobScore(main)) main = b;
  let fx = 0.5, fy = 0.5, spread = 0.3, area = 0, contrast = 1, touch = 1, span = 1;
  if (main && main.mass > 0) {
    fx = main.sx / main.mass / w;
    fy = main.sy / main.mass / h;
    area = main.area / n;
    touch = main.border / (2 * (w + h));
    span = Math.max((main.maxx - main.minx + 1) / w, (main.maxy - main.miny + 1) / h);
    let cxx = 0, cyy = 0, inS = 0, outS = 0, outN = 0;
    const id = blobs.indexOf(main);
    for (let i = 0; i < n; i++) {
      if (label[i] === id) {
        const x = (i % w) + 0.5 - fx * w, y = ((i / w) | 0) + 0.5 - fy * h;
        cxx += x * x;
        cyy += y * y;
        inS += sal[i];
      } else {
        outS += sal[i];
        outN++;
      }
    }
    spread = Math.sqrt((cxx + cyy) / main.area) / m;
    contrast = inS / main.area / Math.max(0.02, outS / Math.max(1, outN));
  }
  // 被写体がはっきりしている＝小さく、まわりより十分目立ち、画面の端にかからない
  const compact = area < 0.2 && contrast > 2.2 && touch < 0.08 && span < 0.75;

  // ---- 直線（水平線・対角線） ----
  const lines = findLines(w, h, gx, gy, mag, Math.max(quantile(mag, 0.8), 6));
  const tiltH = (l: Line) => Math.min(l.angle, Math.PI - l.angle);
  let horizonLine: Line | null = null, diagLine: Line | null = null;
  for (const l of lines) {
    const cover = l.support / l.chord;
    if (tiltH(l) < 0.12 && cover > 0.5 && l.chord > w * 0.85) {
      if (!horizonLine || l.support > horizonLine.support) horizonLine = l;
    }
    // 対角線：水平・垂直から十分傾いていて、画面を長く横切る線
    const tilt = Math.min(tiltH(l), Math.abs(l.angle - Math.PI / 2));
    if (tilt > 0.35 && cover > 0.45 && l.chord > Math.hypot(w, h) * 0.55) {
      if (!diagLine || l.support > diagLine.support) diagLine = l;
    }
  }
  const horizon = horizonLine ? (horizonLine.a.y + horizonLine.b.y) / 2 / h : undefined;
  const horizonCover = horizonLine ? horizonLine.support / horizonLine.chord : 0;
  const diagCover = diagLine ? Math.min(1, diagLine.support / diagLine.chord) : 0;
  // 線の向き：左上→右下 なら 1
  const diagSign = (l: Line): 1 | -1 => ((l.b.x - l.a.x) * (l.b.y - l.a.y) >= 0 ? 1 : -1);

  // ---- 左右対称（軸を少しずらしながら、色とエッジの鏡像差を測る） ----
  let symmetry = 0, axis = 0.5;
  {
    const mL = L.reduce((s, v) => s + v, 0) / n;
    let rowDev = 0, allDev = 0;
    for (let y = 0; y < h; y++) {
      let mr = 0;
      for (let x = 0; x < w; x++) mr += bl[y * w + x];
      mr /= w;
      for (let x = 0; x < w; x++) {
        rowDev += Math.abs(bl[y * w + x] - mr);
        allDev += Math.abs(bl[y * w + x] - mL);
      }
    }
    const lateral = allDev ? rowDev / allDev : 0;
    if (lateral > 0.35) {
      for (let k = -4; k <= 4; k++) {
        const ax = w / 2 + (k * w) / 100;
        let diff = 0, ref = 0;
        const cd = (i: number, j: number) => Math.hypot(bl[i] - bl[j], ba[i] - ba[j], bb[i] - bb[j]);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const mx = Math.round(2 * ax - x - 1);
            if (mx < 0 || mx >= w || mx <= x) continue;
            const i = y * w + x;
            diff += cd(i, y * w + mx);
            // 比較用：同じ行の無関係な位置との差
            ref += cd(i, y * w + ((x + (w >> 1)) % w));
          }
        const s = ref ? 1 - diff / ref : 0;
        if (s > symmetry) {
          symmetry = s;
          axis = ax / w;
        }
      }
    }
  }

  // ---- 判定 ----
  const asp = h / w;
  const dist = (p: Pt) => Math.hypot(fx - p.x, (fy - p.y) * asp) * (w / m);
  const thirds = [1 / 3, 2 / 3].flatMap((x) => [1 / 3, 2 / 3].map((y) => ({ x, y })));
  const golds = [1 - PHI, PHI].flatMap((x) => [1 - PHI, PHI].map((y) => ({ x, y })));
  const dCenter = dist({ x: 0.5, y: 0.5 });
  const dThird = Math.min(...thirds.map(dist));
  const dGold = Math.min(...golds.map(dist));
  const focus = { x: fx, y: fy };
  const base = { focus, spread, axis, horizon, diag: diagLine ? diagSign(diagLine) : undefined, line: diagLine ? { a: { x: diagLine.a.x / w, y: diagLine.a.y / h }, b: { x: diagLine.b.x / w, y: diagLine.b.y / h } } : undefined };

  if (compact && dCenter < 0.1) return { ...base, type: 'center', score: Math.min(1, 0.6 + (0.1 - dCenter) * 4) };
  if (symmetry > 0.72 && Math.abs(axis - 0.5) < 0.05 && Math.abs(fx - axis) < 0.12)
    return { ...base, type: 'symmetry', focus: { x: axis, y: fy }, score: Math.min(1, 0.5 + (symmetry - 0.72) * 2) };
  if (horizonLine && horizonCover > 0.55 && !(compact && Math.abs(fy - (horizon ?? 0.5)) > 0.15))
    return { ...base, type: 'horizon', focus: { x: fx, y: horizon! }, score: Math.min(1, horizonCover) };
  if (diagLine && diagCover > 0.5 && !compact) return { ...base, type: 'diagonal', score: Math.min(1, diagCover) };
  if (dCenter < 0.09) return { ...base, type: 'center', score: compact ? 0.8 : 0.5 };
  if (dGold + 0.01 < dThird && dGold < 0.08) return { ...base, type: 'golden', score: (compact ? 0.9 : 0.6) * (1 - dGold / 0.16) };
  if (dThird < 0.12) return { ...base, type: 'thirds', score: (compact ? 0.9 : 0.6) * (1 - dThird / 0.24) };
  if (diagLine && diagCover > 0.35) return { ...base, type: 'diagonal', score: diagCover * 0.7 };
  if (horizonLine && horizonCover > 0.35) return { ...base, type: 'horizon', focus: { x: fx, y: horizon! }, score: horizonCover * 0.7 };
  const mm = Math.min(dCenter, dThird, dGold);
  const type: CompType = mm === dCenter ? 'center' : mm === dGold ? 'golden' : 'thirds';
  return { ...base, type, score: 0.25 };
}

export function analyze(src: CanvasImageSource & { width: number; height: number }): Analysis {
  const { w, h, d } = smallData(src);
  return { stats: colorStats(w, h, d), comp: composition(w, h, d) };
}
