// タイルの描画（プレビューと書き出しで共通）
import { COMP_LABELS } from './analyze';
import type { CompType, PhotoItem, Pt, Settings, Tile } from './types';

type Drawable = CanvasImageSource & { width: number; height: number };
const PHI = 0.6180339887;

export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function effectiveComp(p: PhotoItem): CompType | 'none' {
  return p.compOverride ?? p.comp.type;
}

/** タイル (w×h) に写真をカバー表示するときの、元画像上のトリミング範囲 */
export function cropFor(p: PhotoItem, w: number, h: number, smart: boolean): Crop {
  const pw = p.width, ph = p.height;
  const s = Math.max(w / pw, h / ph) * Math.max(1, p.zoom);
  const sw = Math.min(pw, w / s), sh = Math.min(ph, h / s);
  let sx: number, sy: number;
  if (p.pan) {
    sx = p.pan.x * pw - sw / 2;
    sy = p.pan.y * ph - sh / 2;
  } else if (smart) {
    // 被写体の位置が、トリミング後も同じ割合の位置に来るようにする（構図を保つ）
    const f = p.comp.focus;
    sx = f.x * pw - f.x * sw;
    sy = f.y * ph - f.y * sh;
  } else {
    sx = (pw - sw) / 2;
    sy = (ph - sh) / 2;
  }
  return { sx: Math.max(0, Math.min(pw - sw, sx)), sy: Math.max(0, Math.min(ph - sh, sy)), sw, sh };
}

export function roundedPath(ctx: CanvasRenderingContext2D | Path2D, pts: Pt[], r: number) {
  const n = pts.length;
  if (r <= 0 || n > 8) {
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    return;
  }
  const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = mid(pts[n - 1], pts[0]);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], prev = pts[(i + n - 1) % n];
    const lim = Math.min(Math.hypot(a.x - prev.x, a.y - prev.y), Math.hypot(b.x - a.x, b.y - a.y)) / 2;
    ctx.arcTo(a.x, a.y, b.x, b.y, Math.min(r, lim));
  }
  ctx.closePath();
}

/** 黄金スパイラル（単位正方形内）を構成する1/4楕円 */
function goldenArcs(): { c: Pt; rx: number; ry: number; a0: number }[] {
  let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
  const arcs: { c: Pt; rx: number; ry: number; a0: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const w = x1 - x0, h = y1 - y0;
    switch (i % 4) {
      case 0: {
        const s = w * PHI;
        arcs.push({ c: { x: x0 + s, y: y1 }, rx: s, ry: h, a0: Math.PI });
        x0 += s;
        break;
      }
      case 1: {
        const s = h * PHI;
        arcs.push({ c: { x: x0, y: y0 + s }, rx: w, ry: s, a0: Math.PI * 1.5 });
        y0 += s;
        break;
      }
      case 2: {
        const s = w * PHI;
        arcs.push({ c: { x: x1 - s, y: y0 }, rx: s, ry: h, a0: 0 });
        x1 -= s;
        break;
      }
      default: {
        const s = h * PHI;
        arcs.push({ c: { x: x1, y: y1 - s }, rx: w, ry: s, a0: Math.PI * 0.5 });
        y1 -= s;
      }
    }
  }
  return arcs;
}
const GOLDEN = goldenArcs();
/** 3回切り出した後に残る長方形（単位正方形内） */
const GOLDEN_REST = (() => {
  const a = GOLDEN[2];
  // 右の扇形を切った後：左上〜下端、上端は2つ目の扇形の下
  const top = GOLDEN[1].c.y;
  return { x0: GOLDEN[1].c.x, y0: top, x1: a.c.x, y1: 1 };
})();
// このスパイラルの目（収束点）
const GOLDEN_EYE = (() => {
  const last = GOLDEN[GOLDEN.length - 1];
  return { x: last.c.x, y: last.c.y };
})();

interface ShapeCtx {
  x: CanvasRenderingContext2D;
  w: number;
  h: number;
  /** 写真上の正規化座標 → タイルのローカル座標 */
  map: (u: number, v: number) => Pt;
  p: PhotoItem;
  type: CompType;
}

/** 構図に合わせた図形のパスを作る（mode: 線 or 切り抜き） */
function shapePath(s: ShapeCtx, cutout: boolean): Path2D {
  const { w, h, p, type } = s;
  const path = new Path2D();
  const F = s.map(p.comp.focus.x, p.comp.focus.y);
  const m = Math.min(w, h);
  const L = -w / 2, T = -h / 2;
  switch (type) {
    case 'center': {
      const r = Math.max(0.2, Math.min(0.44, p.comp.spread * 1.3)) * m;
      path.arc(F.x, F.y, r, 0, Math.PI * 2);
      break;
    }
    case 'thirds': {
      const pts = [1 / 3, 2 / 3].flatMap((a) => [1 / 3, 2 / 3].map((b) => ({ x: L + a * w, y: T + b * h })));
      const q = pts.reduce((best, c) => (Math.hypot(c.x - F.x, c.y - F.y) < Math.hypot(best.x - F.x, best.y - F.y) ? c : best));
      if (cutout) {
        path.arc(q.x, q.y, m * 0.3, 0, Math.PI * 2);
      } else {
        for (const a of [1 / 3, 2 / 3]) {
          path.moveTo(L + a * w, T);
          path.lineTo(L + a * w, T + h);
          path.moveTo(L, T + a * h);
          path.lineTo(L + w, T + a * h);
        }
        path.moveTo(q.x + m * 0.07, q.y);
        path.arc(q.x, q.y, m * 0.07, 0, Math.PI * 2);
      }
      break;
    }
    case 'golden': {
      // 目が被写体側に来るように反転
      const fu = (F.x - L) / w, fv = (F.y - T) / h;
      const flipX = fu < 0.5 !== GOLDEN_EYE.x < 0.5;
      const flipY = fv < 0.5 !== GOLDEN_EYE.y < 0.5;
      const P = (u: number, v: number) => ({ x: L + (flipX ? 1 - u : u) * w, y: T + (flipY ? 1 - v : v) * h });
      if (cutout) {
        // 外側の3つは扇形、その内側（目のまわり）はまとめて残す
        const r = GOLDEN_REST;
        const a = P(r.x0, r.y0), b = P(r.x1, r.y1);
        path.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      }
      (cutout ? GOLDEN.slice(0, 3) : GOLDEN).forEach((a, i) => {
        const seg = 18;
        const c = P(a.c.x, a.c.y);
        if (cutout) path.moveTo(c.x, c.y);
        for (let k = 0; k <= seg; k++) {
          const t = a.a0 + (k / seg) * (Math.PI / 2);
          const q = P(a.c.x + Math.cos(t) * a.rx, a.c.y + Math.sin(t) * a.ry);
          if (k === 0 && !cutout && i === 0) path.moveTo(q.x, q.y);
          else path.lineTo(q.x, q.y);
        }
        if (cutout) path.closePath();
      });
      break;
    }
    case 'diagonal': {
      const d = p.comp.diag ?? 1;
      const a = d === 1 ? { x: L, y: T } : { x: L + w, y: T };
      const b = d === 1 ? { x: L + w, y: T + h } : { x: L, y: T + h };
      if (cutout) {
        // 被写体がある側の三角形
        const side = (b.x - a.x) * (F.y - a.y) - (b.y - a.y) * (F.x - a.x);
        const c = d === 1 ? (side > 0 ? { x: L, y: T + h } : { x: L + w, y: T }) : side > 0 ? { x: L + w, y: T + h } : { x: L, y: T };
        path.moveTo(a.x, a.y);
        path.lineTo(b.x, b.y);
        path.lineTo(c.x, c.y);
        path.closePath();
      } else {
        path.moveTo(a.x, a.y);
        path.lineTo(b.x, b.y);
      }
      break;
    }
    case 'horizon': {
      const y = s.map(0, p.comp.horizon ?? 0.5).y;
      if (cutout) {
        const up = y - T, down = T + h - y;
        const r = Math.min(w * 0.42, Math.max(up, down) * 0.92);
        if (up >= down) path.arc(F.x, y, r, Math.PI, Math.PI * 2);
        else path.arc(F.x, y, r, 0, Math.PI);
        path.closePath();
      } else {
        path.moveTo(L, y);
        path.lineTo(L + w, y);
      }
      break;
    }
    case 'symmetry': {
      const x = F.x;
      if (cutout) {
        // アーチ窓
        const aw = Math.min(w * 0.5, h * 0.5) / 2;
        const top = T + h * 0.14 + aw;
        path.moveTo(x - aw, T + h * 0.9);
        path.lineTo(x - aw, top);
        path.arc(x, top, aw, Math.PI, Math.PI * 2);
        path.lineTo(x + aw, T + h * 0.9);
        path.closePath();
      } else {
        path.moveTo(x, T);
        path.lineTo(x, T + h);
      }
      break;
    }
  }
  return path;
}

export interface SceneOptions {
  W: number;
  H: number;
  /** レイアウト座標 → ピクセルの倍率 */
  k: number;
  tiles: Tile[];
  photos: PhotoItem[];
  settings: Settings;
  rounded: boolean;
  /** 写真ごとの画像（プレビュー用の縮小画像 or 書き出し用に切り出した画像） */
  image: (t: Tile, p: PhotoItem, crop: Crop, pw: number, ph: number) => { img: Drawable; crop: Crop };
  selected?: number;
  dropTarget?: number;
  dragging?: number;
}

export function tileLocal(x: CanvasRenderingContext2D, t: Tile, k: number) {
  x.translate(t.cx * k, t.cy * k);
  if (t.rot) x.rotate(t.rot);
}

export function drawScene(x: CanvasRenderingContext2D, o: SceneOptions) {
  const { k, settings: st } = o;
  x.save();
  x.fillStyle = st.bg;
  x.fillRect(0, 0, o.W * k, o.H * k);
  const unit = (Math.min(o.W, o.H) / 1000) * k;
  for (const t of o.tiles) {
    const p = o.photos[t.idx];
    if (!p) continue;
    const w = t.w * k, h = t.h * k;
    const clip = t.clip.map((q) => ({ x: q.x * k, y: q.y * k }));
    const crop = cropFor(p, t.w, t.h, st.smartCrop);
    x.save();
    tileLocal(x, t, k);

    if (t.frame) {
      const f = t.frame * k;
      x.save();
      x.shadowColor = 'rgba(0,0,0,.28)';
      x.shadowBlur = 14 * unit;
      x.shadowOffsetY = 4 * unit;
      x.fillStyle = '#fbfaf7';
      x.fillRect(-w / 2 - f, -h / 2 - f, w + f * 2, h + f * 3.2);
      x.restore();
    }

    const tilePath = new Path2D();
    roundedPath(tilePath, clip, o.rounded ? st.radius * k : 0);

    const type = effectiveComp(p);
    const cutout = st.overlay === 'cutout' && type !== 'none';
    const map = (u: number, v: number) => ({
      x: ((u * p.width - crop.sx) / crop.sw - 0.5) * w,
      y: ((v * p.height - crop.sy) / crop.sh - 0.5) * h,
    });
    const sctx: ShapeCtx | null = type === 'none' ? null : { x, w, h, map, p, type };

    x.save();
    x.clip(tilePath);
    if (cutout && sctx) {
      // 切り抜きの外側は写真の色を薄く敷く
      const [r, g, b] = p.stats.avg;
      x.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},.28)`;
      x.fillRect(-w / 2, -h / 2, w, h);
      x.clip(shapePath(sctx, true));
    }
    const { img, crop: c2 } = o.image(t, p, crop, w, h);
    x.imageSmoothingQuality = 'high';
    x.globalAlpha = o.dragging === t.idx ? 0.35 : 1;
    x.drawImage(img, c2.sx, c2.sy, c2.sw, c2.sh, -w / 2, -h / 2, w, h);
    x.globalAlpha = 1;
    x.restore();

    // 構図の図形（線）
    if (sctx && (st.overlay === 'guide' || st.overlay === 'accent')) {
      x.save();
      x.clip(tilePath);
      const accent = st.overlay === 'accent';
      x.strokeStyle = st.overlayColor;
      x.globalAlpha = accent ? 0.95 : 0.75;
      x.lineWidth = (accent ? 6 : 1.6) * unit;
      x.lineCap = 'round';
      x.lineJoin = 'round';
      if (!accent) {
        x.shadowColor = 'rgba(0,0,0,.35)';
        x.shadowBlur = 3 * unit;
      }
      x.stroke(shapePath(sctx, false));
      x.restore();
    }

    if (st.showLabel && type !== 'none') {
      const label = COMP_LABELS[type];
      const fs = Math.max(9, 15 * unit);
      x.font = `600 ${fs}px Inter, 'Noto Sans JP', system-ui, sans-serif`;
      const tw = x.measureText(label).width;
      const pad = fs * 0.55;
      const bx = -w / 2 + pad * 1.4, by = h / 2 - pad * 1.4 - fs * 1.6;
      x.save();
      x.clip(tilePath);
      x.fillStyle = 'rgba(20,20,22,.62)';
      x.beginPath();
      x.roundRect(bx, by, tw + pad * 2, fs * 1.6, fs * 0.8);
      x.fill();
      x.fillStyle = '#fff';
      x.textBaseline = 'middle';
      x.fillText(label, bx + pad, by + fs * 0.82);
      x.restore();
    }

    if (o.selected === t.idx || o.dropTarget === t.idx) {
      x.strokeStyle = '#e8792b';
      x.lineWidth = Math.max(2, 5 * unit);
      x.setLineDash(o.dropTarget === t.idx ? [10 * unit, 7 * unit] : []);
      x.stroke(tilePath);
    }
    x.restore();
  }
  x.restore();
}

export const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function canvasToBlob(c: HTMLCanvasElement, type: string, q: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, q));
}
