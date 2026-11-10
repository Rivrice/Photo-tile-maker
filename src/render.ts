// タイルの描画（プレビューと書き出しで共通）
import { COMP_LABELS } from './analyze';
import type { CompType, PhotoItem, Pt, Settings, Tile } from './types';

type Drawable = CanvasImageSource & { width: number; height: number };
const PHI = 0.6180339887;
/** これ以下の検出精度は「低い」とみなす */
export const LOW_CONF = 0.5;

export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 写真を角度 angle で回転して置くとき、タイル (w×h) を覆うのに必要な写真側の枠の大きさ。
 * 回転したタイルを囲む長方形を、写真から切り出せばよい。
 */
export function photoBox(p: PhotoItem, w: number, h: number) {
  const a = ((p.angle || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return { bw: w * c + h * s, bh: w * s + h * c };
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

/** 写真上の正規化座標（0..1） */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 黄金分割の補助線：長い辺を 0.382 : 0.618 で区切る操作を、被写体のある側へ繰り返す。
 * 区切り線は被写体に近い方の分割点を使うので、線が被写体へ向かって収束していく。
 */
function goldenCuts(pw: number, ph: number, f: Pt, depth = 6) {
  let r = { x0: 0, y0: 0, x1: pw, y1: ph };
  const fx = f.x * pw, fy = f.y * ph;
  const lines: [Pt, Pt][] = [];
  const rects: Rect[] = [];
  for (let i = 0; i < depth; i++) {
    const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
    if (rw >= rh) {
      const c1 = r.x0 + rw * (1 - PHI), c2 = r.x0 + rw * PHI;
      const c = Math.abs(fx - c1) <= Math.abs(fx - c2) ? c1 : c2;
      lines.push([{ x: c / pw, y: r.y0 / ph }, { x: c / pw, y: r.y1 / ph }]);
      r = fx < c ? { ...r, x1: c } : { ...r, x0: c };
    } else {
      const c1 = r.y0 + rh * (1 - PHI), c2 = r.y0 + rh * PHI;
      const c = Math.abs(fy - c1) <= Math.abs(fy - c2) ? c1 : c2;
      lines.push([{ x: r.x0 / pw, y: c / ph }, { x: r.x1 / pw, y: c / ph }]);
      r = fy < c ? { ...r, y1: c } : { ...r, y0: c };
    }
    rects.push({ x0: r.x0 / pw, y0: r.y0 / ph, x1: r.x1 / pw, y1: r.y1 / ph });
  }
  return { lines, rects };
}

interface ShapeCtx {
  w: number;
  h: number;
  /** 写真上の正規化座標 → タイルのローカル座標 */
  map: (u: number, v: number) => Pt;
  /** 写真の短辺を 1 とした長さ → タイルのローカル座標での長さ */
  len: (l: number) => number;
  p: PhotoItem;
  type: CompType;
}

interface ShapeSet {
  /** 主となる線（アクセントでは太く描く） */
  main: Path2D;
  /** 補助の線（細く描く） */
  sub: Path2D;
  /** 構図の要となる点 */
  dots: Pt[];
  /** 切り抜きの形 */
  cut: Path2D;
}

/** 構図の要の点（三分割の交点など）。すべて元画像を基準に決める */
function keyPoint(p: PhotoItem, type: CompType): Pt {
  const f = p.comp.focus;
  if (type === 'thirds' || type === 'golden') {
    const a = type === 'thirds' ? 1 / 3 : 1 - PHI;
    const pts = [a, 1 - a].flatMap((x) => [a, 1 - a].map((y) => ({ x, y })));
    const asp = p.height / p.width;
    return pts.reduce((b, c) => (Math.hypot(c.x - f.x, (c.y - f.y) * asp) < Math.hypot(b.x - f.x, (b.y - f.y) * asp) ? c : b));
  }
  return f;
}

/**
 * 構図に合わせた図形。座標はすべて元画像の上で決めてからタイルへ写すので、
 * どのタイルに入れても、写真との位置関係と図形の比率は変わらない。
 */
/** 手動で選んだ構図のときだけ、図形の調整を返す */
export function shapeEdit(p: PhotoItem) {
  const e = p.shape;
  if (!e || p.compOverride == null || p.compOverride === 'none') return null;
  if (!e.x && !e.y && e.scale === 1 && !e.angle) return null;
  return e;
}

/** 図形の調整で動かすときの基準点（元画像の正規化座標） */
function shapeAnchor(p: PhotoItem, type: CompType): Pt {
  const f = p.comp.focus;
  switch (type) {
    case 'thirds':
    case 'golden':
      return keyPoint(p, type);
    case 'diagonal': {
      const seg = diagSeg(p);
      return { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
    }
    case 'horizon':
      return { x: 0.5, y: p.comp.horizon ?? f.y };
    case 'symmetry':
      return { x: p.comp.axis ?? f.x, y: 0.5 };
    default:
      return f;
  }
}

function diagSeg(p: PhotoItem) {
  const d = p.comp.diag ?? 1;
  return p.comp.line ?? (d === 1 ? { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } } : { a: { x: 1, y: 0 }, b: { x: 0, y: 1 } });
}

function shapeSet(s: ShapeCtx): ShapeSet {
  const { p, type } = s;
  // 図形の調整：基準点を中心に拡大・回転してから、移動する（タイルの座標で）
  const ed = shapeEdit(p);
  const rot = ed ? (ed.angle * Math.PI) / 180 : 0;
  const sc = ed ? ed.scale : 1;
  let map = s.map, len = s.len;
  if (ed) {
    const an = shapeAnchor(p, type);
    const A = s.map(an.x, an.y);
    const D = s.map(an.x + ed.x, an.y + ed.y);
    const cs = Math.cos(rot) * sc, sn = Math.sin(rot) * sc;
    map = (u, v) => {
      const P = s.map(u, v);
      const x = P.x - A.x, y = P.y - A.y;
      return { x: D.x + x * cs - y * sn, y: D.y + x * sn + y * cs };
    };
    len = (l) => s.len(l) * sc;
  }
  const main = new Path2D(), sub = new Path2D(), cut = new Path2D();
  const dots: Pt[] = [];
  const onEdge = (q: Pt) => q.x <= 0.001 || q.x >= 0.999 || q.y <= 0.001 || q.y >= 0.999;
  // 写真の端から端までの線は、動かしても途切れないように外へ延ばす
  const far = s.len(4);
  const line = (path: Path2D, a: Pt, b: Pt) => {
    let A = map(a.x, a.y), B = map(b.x, b.y);
    if (ed && onEdge(a) && onEdge(b)) {
      const dx = B.x - A.x, dy = B.y - A.y, l = Math.hypot(dx, dy) || 1;
      A = { x: A.x - (dx / l) * far, y: A.y - (dy / l) * far };
      B = { x: B.x + (dx / l) * far, y: B.y + (dy / l) * far };
    }
    path.moveTo(A.x, A.y);
    path.lineTo(B.x, B.y);
  };
  const circle = (path: Path2D, c: Pt, r: number) => {
    const C = map(c.x, c.y);
    path.moveTo(C.x + len(r), C.y);
    path.arc(C.x, C.y, len(r), 0, Math.PI * 2);
  };
  const short = Math.min(p.width, p.height);
  // 正規化座標の長さ（短辺比）を、u・v 方向の比率に直す
  const du = short / p.width, dv = short / p.height;
  const f = p.comp.focus;
  switch (type) {
    case 'center': {
      const r = Math.max(0.16, Math.min(0.42, p.comp.spread * 1.35));
      circle(main, f, r);
      circle(sub, f, r * 1.18);
      dots.push(f);
      circle(cut, f, r);
      break;
    }
    case 'thirds':
    case 'golden': {
      const k = keyPoint(p, type);
      if (type === 'thirds') {
        for (const a of [1 / 3, 2 / 3]) {
          line(Math.abs(a - k.x) < 0.01 ? main : sub, { x: a, y: 0 }, { x: a, y: 1 });
          line(Math.abs(a - k.y) < 0.01 ? main : sub, { x: 0, y: a }, { x: 1, y: a });
        }
        dots.push(k);
        circle(cut, k, 0.25);
      } else {
        // 黄金分割の区切り線（直線のみ）。最初の2本を主線、残りを補助線に
        const g = goldenCuts(p.width, p.height, k);
        g.lines.forEach(([a, b], i) => line(i < 2 ? main : sub, a, b));
        dots.push(k);
        // 切り抜き：要の点を中心にした黄金長方形（1 : 1.618、写真と同じ向き）
        const C = map(k.x, k.y);
        const a = len(0.27), b = a / PHI;
        const [hw, hh] = p.width >= p.height ? [b, a] : [a, b];
        cut.rect(C.x - hw, C.y - hh, hw * 2, hh * 2);
      }
      break;
    }
    case 'diagonal': {
      // 検出した線があればそれを、なければ画像の対角線を使う
      const seg = diagSeg(p);
      line(main, seg.a, seg.b);
      // 平行な補助線（対角線を挟んで等間隔）
      const nx = -(seg.b.y - seg.a.y) * p.height, ny = (seg.b.x - seg.a.x) * p.width;
      const nl = Math.hypot(nx, ny) || 1;
      for (const o of [-0.12, 0.12]) {
        const ox = ((nx / nl) * o * short) / p.width, oy = ((ny / nl) * o * short) / p.height;
        line(sub, { x: seg.a.x + ox, y: seg.a.y + oy }, { x: seg.b.x + ox, y: seg.b.y + oy });
      }
      // 切り抜き：被写体のある側。図形を動かしたときは、線のその側全体（タイルで切り抜かれる）
      if (ed) {
        const A = map(seg.a.x, seg.a.y), B = map(seg.b.x, seg.b.y), F = map(f.x, f.y);
        const dx = B.x - A.x, dy = B.y - A.y, l = Math.hypot(dx, dy) || 1;
        const ux = dx / l, uy = dy / l;
        let nx = -uy, ny = ux;
        if ((F.x - A.x) * nx + (F.y - A.y) * ny < 0) [nx, ny] = [-nx, -ny];
        const p1 = { x: A.x - ux * far, y: A.y - uy * far }, p2 = { x: B.x + ux * far, y: B.y + uy * far };
        cut.moveTo(p1.x, p1.y);
        cut.lineTo(p2.x, p2.y);
        cut.lineTo(p2.x + nx * far, p2.y + ny * far);
        cut.lineTo(p1.x + nx * far, p1.y + ny * far);
        cut.closePath();
        break;
      }
      const side = (q: Pt) => (seg.b.x - seg.a.x) * (q.y - seg.a.y) * p.height - (seg.b.y - seg.a.y) * (q.x - seg.a.x) * p.width;
      const sf = side(f) || 1;
      const corners = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ].filter((c) => side(c) * sf > 0);
      // 線の端から角をたどって多角形を作る
      const poly = [seg.a, seg.b, ...orderCorners(seg.b, seg.a, corners)];
      poly.forEach((q, i) => {
        const Q = map(q.x, q.y);
        if (i) cut.lineTo(Q.x, Q.y);
        else cut.moveTo(Q.x, Q.y);
      });
      cut.closePath();
      break;
    }
    case 'horizon': {
      const y = p.comp.horizon ?? f.y;
      line(main, { x: 0, y }, { x: 1, y });
      // 上下に、水平線との間隔をそろえた補助線
      for (const o of [-0.08, 0.08]) line(sub, { x: 0, y: y + o * dv }, { x: 1, y: y + o * dv });
      // 切り抜き：水平線から昇る半円（空の広い側へ）
      const up = y, down = 1 - y;
      const r = Math.min(0.34, Math.max(up, down) * (p.height / short) * 0.85);
      const C = map(f.x, y);
      const R = len(r);
      if (up >= down) cut.arc(C.x, C.y, R, Math.PI + rot, Math.PI * 2 + rot);
      else cut.arc(C.x, C.y, R, rot, Math.PI + rot);
      cut.closePath();
      dots.push({ x: f.x, y });
      break;
    }
    case 'symmetry': {
      const x = p.comp.axis ?? f.x;
      line(main, { x, y: 0 }, { x, y: 1 });
      for (const o of [-0.18, 0.18]) line(sub, { x: x + o * du, y: 0 }, { x: x + o * du, y: 1 });
      // 切り抜き：軸を中心にしたアーチ窓
      const aw = 0.22; // 半幅（短辺比）
      const top = 0.1 + aw * dv, bottom = 0.92;
      const L = map(x - aw * du, bottom), R = map(x + aw * du, bottom), T = map(x, top), LT = map(x - aw * du, top);
      cut.moveTo(L.x, L.y);
      cut.lineTo(LT.x, LT.y);
      cut.arc(T.x, T.y, len(aw), Math.PI + rot, Math.PI * 2 + rot);
      cut.lineTo(R.x, R.y);
      cut.closePath();
      break;
    }
  }
  return { main, sub, dots: dots.map((d) => map(d.x, d.y)), cut };
}

/** 線の端 from から、同じ側の角を外周に沿ってたどり、端 to に戻る順に並べる */
function orderCorners(from: Pt, to: Pt, corners: Pt[]): Pt[] {
  // 外周上の位置（0..4）：上辺→右辺→下辺→左辺
  const pos = (q: Pt) => {
    const e = 1e-6;
    if (q.y <= e) return q.x;
    if (q.x >= 1 - e) return 1 + q.y;
    if (q.y >= 1 - e) return 2 + (1 - q.x);
    return 3 + (1 - q.y);
  };
  const a = pos(from), b = pos(to);
  const fwd = (q: Pt) => (pos(q) - a + 4) % 4;
  const span = (b - a + 4) % 4;
  const along = corners.every((c) => fwd(c) < span);
  return [...corners].sort((c1, c2) => (along ? fwd(c1) - fwd(c2) : fwd(c2) - fwd(c1)));
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
    // 回転している写真は、回転後のタイルを覆う枠で切り出す
    const box = photoBox(p, t.w, t.h);
    const crop = cropFor(p, box.bw, box.bh, st.smartCrop);
    const bw = box.bw * k, bh = box.bh * k;
    const ang = ((p.angle || 0) * Math.PI) / 180;
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

    // 自動検出で精度が低い（50%以下）写真は、設定で許可したときだけ構図を描く
    const lowConf = p.compOverride == null && p.comp.score <= LOW_CONF && !st.showLowConf;
    const type = lowConf ? 'none' : effectiveComp(p);
    const cutout = st.overlay === 'cutout' && type !== 'none';
    const map = (u: number, v: number) => ({
      x: ((u * p.width - crop.sx) / crop.sw - 0.5) * bw,
      y: ((v * p.height - crop.sy) / crop.sh - 0.5) * bh,
    });
    // 写真の短辺（正規化長 1）→ タイル上の長さ
    const len = (l: number) => ((l * Math.min(p.width, p.height)) / crop.sw) * bw;
    const shapes = type === 'none' || st.overlay === 'none' ? null : shapeSet({ w: bw, h: bh, map, len, p, type });

    const { img, crop: c2 } = o.image(t, p, crop, bw, bh);
    x.save();
    x.clip(tilePath);
    if (ang) x.rotate(ang);
    x.imageSmoothingQuality = 'high';
    x.globalAlpha = o.dragging === t.idx ? 0.35 : 1;
    x.drawImage(img, c2.sx, c2.sy, c2.sw, c2.sh, -bw / 2, -bh / 2, bw, bh);
    x.globalAlpha = 1;
    if (cutout && shapes) {
      // 切り抜きの外側は、写真を背景色で薄く覆う（紙に窓を開けたような見た目）
      const outside = new Path2D();
      outside.rect(-bw / 2 - 1, -bh / 2 - 1, bw + 2, bh + 2);
      outside.addPath(shapes.cut);
      x.fillStyle = st.bg;
      x.globalAlpha = 0.84;
      x.fill(outside, 'evenodd');
      x.globalAlpha = 1;
      // 窓の縁に細い線
      x.strokeStyle = st.overlayColor;
      x.globalAlpha = 0.9;
      x.lineWidth = 1.5 * unit;
      x.lineJoin = 'round';
      x.stroke(shapes.cut);
      x.globalAlpha = 1;
    }
    x.restore();

    // 構図の図形（線）
    if (shapes && (st.overlay === 'guide' || st.overlay === 'accent')) {
      x.save();
      x.clip(tilePath);
      if (ang) x.rotate(ang);
      const accent = st.overlay === 'accent';
      x.strokeStyle = st.overlayColor;
      x.fillStyle = st.overlayColor;
      x.lineCap = 'round';
      x.lineJoin = 'round';
      if (!accent) {
        // 細い線＋ごく弱い影で、どんな写真の上でも読めるように
        x.shadowColor = 'rgba(0,0,0,.28)';
        x.shadowBlur = 2 * unit;
      }
      x.globalAlpha = accent ? 0.5 : 0.55;
      x.lineWidth = (accent ? 1.4 : 1) * unit;
      x.stroke(shapes.sub);
      x.globalAlpha = accent ? 0.95 : 0.9;
      x.lineWidth = (accent ? 3.2 : 1.3) * unit;
      x.stroke(shapes.main);
      for (const d of shapes.dots) {
        x.beginPath();
        x.arc(d.x, d.y, (accent ? 5 : 3) * unit, 0, Math.PI * 2);
        x.fill();
        if (!accent) {
          x.beginPath();
          x.arc(d.x, d.y, 9 * unit, 0, Math.PI * 2);
          x.lineWidth = 1 * unit;
          x.stroke();
        }
      }
      x.restore();
    }

    if (st.showLabel && type !== 'none') {
      const label = COMP_LABELS[type];
      const fs = Math.max(9, 15 * unit);
      x.font = `600 ${fs}px Inter, 'Noto Sans JP Variable', 'Noto Sans JP', sans-serif`;
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
