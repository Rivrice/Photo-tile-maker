// 写真の色・明るさと構図を、縮小画像（長辺 96px）から推定する。
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
const ANALYZE_EDGE = 96;

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

function blur(a: Float32Array, w: number, h: number, r: number) {
  const t = new Float32Array(a.length);
  const o = new Float32Array(a.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) {
          s += a[y * w + xx];
          c++;
        }
      }
      t[y * w + x] = s / c;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) {
          s += t[yy * w + x];
          c++;
        }
      }
      o[y * w + x] = s / c;
    }
  return o;
}

function composition(w: number, h: number, d: Uint8ClampedArray): Composition {
  const n = w * h;
  // 反対色空間（簡易Lab）
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
    L[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    A[i] = r - g;
    B[i] = (r + g) / 2 - b;
  }
  const mL = L.reduce((a, b) => a + b, 0) / n;
  const mA = A.reduce((a, b) => a + b, 0) / n;
  const mB = B.reduce((a, b) => a + b, 0) / n;
  const bl = blur(L, w, h, 1), ba = blur(A, w, h, 1), bb = blur(B, w, h, 1);

  // 勾配
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const dx = bl[i + 1 - w] + 2 * bl[i + 1] + bl[i + 1 + w] - bl[i - 1 - w] - 2 * bl[i - 1] - bl[i - 1 + w];
      const dy = bl[i + w - 1] + 2 * bl[i + w] + bl[i + w + 1] - bl[i - w - 1] - 2 * bl[i - w] - bl[i - w + 1];
      gx[i] = dx;
      gy[i] = dy;
      mag[i] = Math.hypot(dx, dy);
    }

  // 顕著性 = 平均色からの距離（周波数同調型）＋ エッジの密度
  const edge = blur(mag, w, h, 3);
  let maxC = 1e-6, maxE = 1e-6;
  const con = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    con[i] = Math.hypot(bl[i] - mL, (ba[i] - mA) * 1.2, (bb[i] - mB) * 1.2);
    if (con[i] > maxC) maxC = con[i];
    if (edge[i] > maxE) maxE = edge[i];
  }
  const sal = new Float32Array(n);
  for (let i = 0; i < n; i++) sal[i] = (con[i] / maxC) * 0.65 + (edge[i] / maxE) * 0.35;
  const sorted = Float32Array.from(sal).sort();
  const thr = sorted[Math.floor(n * 0.82)];

  let sw = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = sal[y * w + x] - thr;
      if (v <= 0) continue;
      sw += v;
      sx += v * (x + 0.5);
      sy += v * (y + 0.5);
    }
  const fx = sw ? sx / sw / w : 0.5;
  const fy = sw ? sy / sw / h : 0.5;
  // 広がり・主軸
  let cxx = 0, cyy = 0, cxy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = sal[y * w + x] - thr;
      if (v <= 0) continue;
      const ux = (x + 0.5) / w - fx, uy = ((y + 0.5) / h - fy) * (h / w);
      cxx += v * ux * ux;
      cyy += v * uy * uy;
      cxy += v * ux * uy;
    }
  if (sw) {
    cxx /= sw;
    cyy /= sw;
    cxy /= sw;
  }
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const spread = Math.sqrt(tr) * (w / Math.min(w, h));
  const elong = Math.sqrt(l1 / l2);
  const axis = Math.atan2(l1 - cxx, cxy || 1e-9); // 主軸の角度

  // 水平線：行ごとの縦方向勾配のピーク
  const rows = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    let s = 0;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // 横に伸びる境界（縦方向勾配が強く、横方向が弱い）
      s += Math.max(0, Math.abs(gy[i]) - Math.abs(gx[i]) * 0.5);
    }
    rows[y] = s / w;
  }
  let hy = 0, hv = 0, hm = 0;
  for (let y = 2; y < h - 2; y++) {
    const v = rows[y - 1] * 0.5 + rows[y] + rows[y + 1] * 0.5;
    hm += v;
    if (v > hv) {
      hv = v;
      hy = y;
    }
  }
  hm /= Math.max(1, h - 4);
  const horizonStrength = hm ? hv / hm : 0;
  const horizon = hy / h;

  // 勾配方向のヒストグラム（対角線）
  const diagAngle = Math.atan2(h, w);
  let dPos = 0, dNeg = 0, dAll = 1e-6;
  for (let i = 0; i < n; i++) {
    if (mag[i] < 0.08) continue;
    // 勾配に直交する向き＝線の向き
    let a = Math.atan2(gy[i], gx[i]) + Math.PI / 2;
    a = ((a % Math.PI) + Math.PI) % Math.PI; // 0..π
    dAll += mag[i];
    if (Math.abs(a - diagAngle) < 0.2) dPos += mag[i];
    if (Math.abs(a - (Math.PI - diagAngle)) < 0.2) dNeg += mag[i];
  }
  const diagShare = Math.max(dPos, dNeg) / dAll;
  const axisMod = ((axis % Math.PI) + Math.PI) % Math.PI;
  const axisPos = Math.abs(axisMod - diagAngle), axisNeg = Math.abs(axisMod - (Math.PI - diagAngle));
  const axisDiag = elong > 2.2 && Math.min(axisPos, axisNeg) < 0.25;

  // 左右対称性
  let symDiff = 0, symVar = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w / 2; x++) {
      const a = bl[y * w + x], b = bl[y * w + (w - 1 - x)];
      symDiff += Math.abs(a - b);
      symVar += Math.abs(a - mL) + Math.abs(b - mL);
    }
  // 横方向に変化がない（空と海だけ等）画像は、左右対称とは見なさない
  let rowDev = 0, allDev = 0;
  for (let y = 0; y < h; y++) {
    let m = 0;
    for (let x = 0; x < w; x++) m += bl[y * w + x];
    m /= w;
    for (let x = 0; x < w; x++) {
      rowDev += Math.abs(bl[y * w + x] - m);
      allDev += Math.abs(bl[y * w + x] - mL);
    }
  }
  const lateral = allDev ? rowDev / allDev : 0;
  const symmetry = symVar && lateral > 0.35 ? 1 - symDiff / symVar : 0;

  const dist = (p: Pt) => Math.hypot(fx - p.x, (fy - p.y) * (h / w));
  const thirds = [1 / 3, 2 / 3].flatMap((x) => [1 / 3, 2 / 3].map((y) => ({ x, y })));
  const golds = [1 - PHI, PHI].flatMap((x) => [1 - PHI, PHI].map((y) => ({ x, y })));
  const dCenter = dist({ x: 0.5, y: 0.5 });
  const dThird = Math.min(...thirds.map(dist));
  const dGold = Math.min(...golds.map(dist));
  const focus = { x: fx, y: fy };
  const base = { focus, spread };

  if (dCenter < 0.09 && spread < 0.28) return { ...base, type: 'center', score: 1 - dCenter / 0.09 };
  if (symmetry > 0.82 && Math.abs(fx - 0.5) < 0.08)
    return { ...base, type: 'symmetry', score: Math.min(1, (symmetry - 0.82) * 5 + 0.5) };
  if (horizonStrength > 3 && spread > 0.42)
    return { ...base, type: 'horizon', horizon, score: Math.min(1, horizonStrength / 6) };
  if (diagShare > 0.2 || axisDiag) {
    const sign: 1 | -1 = (axisDiag ? axisPos < axisNeg : dPos >= dNeg) ? 1 : -1;
    return { ...base, type: 'diagonal', diag: sign, score: Math.min(1, diagShare * 3) };
  }
  if (dCenter < 0.09) return { ...base, type: 'center', score: 1 - dCenter / 0.09 };
  if (dGold < dThird && dGold < 0.07) return { ...base, type: 'golden', score: 1 - dGold / 0.07 };
  if (dThird < 0.11) return { ...base, type: 'thirds', score: 1 - dThird / 0.11 };
  if (horizonStrength > 2.4) return { ...base, type: 'horizon', horizon, score: 0.3 };
  // どれにも近くない：最も近いものを低い信頼度で
  const m = Math.min(dCenter, dThird, dGold);
  const type: CompType = m === dCenter ? 'center' : m === dGold ? 'golden' : 'thirds';
  return { ...base, type, score: 0.2 };
}

export function analyze(src: CanvasImageSource & { width: number; height: number }): Analysis {
  const { w, h, d } = smallData(src);
  return { stats: colorStats(w, h, d), comp: composition(w, h, d) };
}
