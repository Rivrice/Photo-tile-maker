// 写真の読み込みと縮小。元ファイルは保持し、必要になった解像度だけを取り出す。
import exifr from 'exifr';
import { analyze } from './analyze';
import { heicToJpegNative } from './native';
import type { PhotoItem } from './types';

export const MAX_PHOTOS = 20;
/** プレビュー用の長辺（タイル表示にはこれで十分） */
export const PREVIEW_EDGE = 1280;
const THUMB_EDGE = 160;

export const ACCEPT = 'image/*,.heic,.heif,.avif';

type Drawable = CanvasImageSource & { width: number; height: number };

const uid = () => Math.random().toString(36).slice(2, 10);

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 段階的に半分ずつ縮めて、指定サイズへ高画質に縮小する */
export function resizeTo(src: Drawable, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): HTMLCanvasElement {
  dw = Math.max(1, Math.round(dw));
  dh = Math.max(1, Math.round(dh));
  let cur: Drawable = src;
  let cx = sx, cy = sy, cw = sw, ch = sh;
  while (cw / 2 >= dw && ch / 2 >= dh) {
    const c = canvas(cw / 2, ch / 2);
    const x = c.getContext('2d')!;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, cx, cy, cw, ch, 0, 0, c.width, c.height);
    if (cur instanceof HTMLCanvasElement && cur !== src) cur.width = 0;
    cur = c;
    cx = 0;
    cy = 0;
    cw = c.width;
    ch = c.height;
  }
  const out = canvas(dw, dh);
  const x = out.getContext('2d')!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(cur, cx, cy, cw, ch, 0, 0, dw, dh);
  if (cur instanceof HTMLCanvasElement && cur !== src) cur.width = 0;
  return out;
}

async function decodeViaImg(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 向き補正済みでデコード。resize を指定するとデコード時点で縮小する（対応ブラウザのみ） */
async function decode(file: Blob, resize?: { w: number; h: number }): Promise<Drawable> {
  if ('createImageBitmap' in window) {
    try {
      if (resize) {
        return await createImageBitmap(file, {
          imageOrientation: 'from-image',
          resizeWidth: Math.round(resize.w),
          resizeHeight: Math.round(resize.h),
          resizeQuality: 'high',
        });
      }
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* HEIC など：img 要素で再挑戦 */
    }
  }
  try {
    return await decodeViaImg(file);
  } catch (e) {
    // Androidアプリ版：WebViewが読めないHEICはOS標準のデコーダーでJPEGに変換
    const jpeg = await heicToJpegNative(file).catch(() => null);
    if (!jpeg) throw e;
    return resize ? await decode(jpeg, resize) : await decodeViaImg(jpeg);
  }
}

function release(src: Drawable) {
  if ('close' in src && typeof src.close === 'function') src.close();
  else if (src instanceof HTMLCanvasElement) src.width = 0;
}

/** 90°単位で回転したキャンバス（q = 時計回りの回数） */
function rotated(src: Drawable, q: number): HTMLCanvasElement {
  const odd = q % 2 === 1;
  const c = canvas(odd ? src.height : src.width, odd ? src.width : src.height);
  const x = c.getContext('2d')!;
  x.translate(c.width / 2, c.height / 2);
  x.rotate((q * Math.PI) / 2);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function thumb(src: Drawable) {
  const s = Math.min(1, THUMB_EDGE / Math.max(src.width, src.height));
  return resizeTo(src, 0, 0, src.width, src.height, src.width * s, src.height * s);
}

function finishItem(name: string, file: File | null, full: Drawable, date: number): PhotoItem {
  const w = full.width, h = full.height;
  const s = Math.min(1, PREVIEW_EDGE / Math.max(w, h));
  const preview = s < 1 ? resizeTo(full, 0, 0, w, h, w * s, h * s) : full;
  const { stats, comp } = analyze(preview);
  const mini = thumb(preview);
  return {
    id: uid(),
    name,
    file,
    width: w,
    height: h,
    preview,
    thumbUrl: mini.toDataURL('image/jpeg', 0.8),
    mini,
    stats,
    comp,
    compOverride: null,
    date,
    pan: null,
    zoom: 1,
    rot: 0,
    angle: 0,
    shape: { x: 0, y: 0, scale: 1, angle: 0 },
  };
}

export async function loadPhoto(file: File): Promise<PhotoItem> {
  let date = file.lastModified;
  try {
    const ex = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    const d = ex?.DateTimeOriginal ?? ex?.CreateDate;
    if (d instanceof Date && !isNaN(d.getTime())) date = d.getTime();
  } catch {
    /* Exif なし */
  }
  const full = await decode(file);
  const item = finishItem(file.name, file, full, date);
  if (item.preview !== full) release(full);
  return item;
}

/**
 * 書き出し用：元ファイルから、トリミング範囲 (sx,sy,sw,sh)（元画像の座標）を dw×dh に縮小して取り出す。
 * 元画像を必要な倍率までデコード時に縮めるので、巨大な写真でもメモリを使いすぎない。
 */
export async function extractRegion(p: PhotoItem, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(1, Math.max(dw / sw, dh / sh) * 1.25);
  if (!p.file) {
    const k = p.preview.width / p.width;
    return resizeTo(p.preview, sx * k, sy * k, sw * k, sh * k, dw, dh);
  }
  let src: Drawable | null = null;
  // 元ファイルは回転前の向き：回転前の大きさで縮小してから回す
  const odd = p.rot % 2 === 1;
  const bw = odd ? p.height : p.width, bh = odd ? p.width : p.height;
  try {
    if (scale < 0.98) {
      const want = { w: bw * scale, h: bh * scale };
      src = await decode(p.file, want);
      // 向きの扱いが違うブラウザ対策：比率が合わなければ縮小なしで読み直す
      if (Math.abs(src.width / src.height - bw / bh) > 0.02) {
        release(src);
        src = null;
      }
    }
    if (!src) src = await decode(p.file);
    if (p.rot) {
      const r = rotated(src, p.rot);
      release(src);
      src = r;
    }
    const k = src.width / p.width;
    return resizeTo(src, sx * k, sy * k, sw * k, sh * k, dw, dh);
  } catch {
    const k = p.preview.width / p.width;
    return resizeTo(p.preview, sx * k, sy * k, sw * k, sh * k, dw, dh);
  } finally {
    if (src) release(src);
  }
}

// ---------- サンプル（未読込時のプレビュー用） ----------

type Painter = (x: CanvasRenderingContext2D, w: number, h: number) => void;

const SAMPLES: { name: string; w: number; h: number; paint: Painter }[] = [
  {
    name: '夕日（日の丸）',
    w: 1200,
    h: 1200,
    paint(x, w, h) {
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#f6b26b');
      g.addColorStop(1, '#e8792b');
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#fff4d6';
      x.beginPath();
      x.arc(w / 2, h / 2, w * 0.16, 0, Math.PI * 2);
      x.fill();
    },
  },
  {
    name: '海と空（水平線）',
    w: 1500,
    h: 1000,
    paint(x, w, h) {
      const sky = x.createLinearGradient(0, 0, 0, h * 0.62);
      sky.addColorStop(0, '#9ec9e8');
      sky.addColorStop(1, '#dcecf5');
      x.fillStyle = sky;
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#2f6f95';
      x.fillRect(0, h * 0.64, w, h);
    },
  },
  {
    name: '灯台（三分割）',
    w: 1000,
    h: 1400,
    paint(x, w, h) {
      x.fillStyle = '#2d3047';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#e9e7e2';
      x.fillRect(w * 0.64, h * 0.3, w * 0.06, h * 0.5);
      x.fillStyle = '#f4d35e';
      x.beginPath();
      x.arc(w * 0.67, h * 0.32, w * 0.07, 0, Math.PI * 2);
      x.fill();
    },
  },
  {
    name: '坂道（対角線）',
    w: 1500,
    h: 1000,
    paint(x, w, h) {
      x.fillStyle = '#c7d6c1';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#4f6d4a';
      x.beginPath();
      x.moveTo(0, 0);
      x.lineTo(w, h);
      x.lineTo(0, h);
      x.fill();
    },
  },
  {
    name: '花（黄金比）',
    w: 1200,
    h: 900,
    paint(x, w, h) {
      x.fillStyle = '#efe6f2';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#b5468c';
      x.beginPath();
      x.arc(w * 0.38, h * 0.38, w * 0.07, 0, Math.PI * 2);
      x.fill();
    },
  },
  {
    name: '門（シンメトリー）',
    w: 1000,
    h: 1250,
    paint(x, w, h) {
      x.fillStyle = '#1f2a33';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#d64545';
      x.fillRect(w * 0.18, h * 0.2, w * 0.1, h * 0.8);
      x.fillRect(w * 0.72, h * 0.2, w * 0.1, h * 0.8);
      x.fillRect(w * 0.1, h * 0.18, w * 0.8, h * 0.07);
    },
  },
  {
    name: '森',
    w: 1400,
    h: 1000,
    paint(x, w, h) {
      x.fillStyle = '#16302b';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#7fb069';
      x.beginPath();
      x.arc(w * 0.3, h * 0.66, h * 0.12, 0, Math.PI * 2);
      x.fill();
    },
  },
];

export function makeSamples(): PhotoItem[] {
  return SAMPLES.map((s, i) => {
    const c = canvas(s.w, s.h);
    s.paint(c.getContext('2d')!, s.w, s.h);
    const item = finishItem(s.name, null, c, Date.UTC(2026, 0, 1 + i));
    return item;
  });
}
