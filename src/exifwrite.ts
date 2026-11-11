// 書き出した JPEG に、すべての写真で共通する Exif だけを書き込む。
// （Exif Frame Maker でカメラ名やレンズなどの文字を入れられるようにするため。位置情報などは入れない）

/** 読み取る（そして共通なら書き込む）タグ */
export const META_TAGS = [
  'Make',
  'Model',
  'Artist',
  'Copyright',
  'LensMake',
  'LensModel',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'FNumber',
  'ExposureTime',
  'ISO',
  'DateTimeOriginal',
] as const;
export type MetaTag = (typeof META_TAGS)[number];
export type Meta = Partial<Record<MetaTag, string | number>>;

/** exifr の生の値を、比べやすい形（文字列か数値）にそろえる */
export function normalizeMeta(raw: Record<string, unknown> | null | undefined): Meta {
  const out: Meta = {};
  if (!raw) return out;
  for (const k of META_TAGS) {
    let v = raw[k] as unknown;
    if (Array.isArray(v)) v = v[0];
    if (typeof v === 'string') {
      const s = v.replace(/\0/g, '').trim();
      if (s) out[k] = s;
    } else if (typeof v === 'number' && isFinite(v) && v > 0) {
      out[k] = v;
    }
  }
  return out;
}

/** すべての写真で同じ値のタグだけを残す */
export function commonMeta(list: Meta[]): Meta {
  if (!list.length) return {};
  const out: Meta = {};
  for (const k of META_TAGS) {
    const v0 = list[0][k];
    if (v0 == null) continue;
    const same = list.every((m) => {
      const v = m[k];
      if (v == null || typeof v !== typeof v0) return false;
      return typeof v === 'number' ? Math.abs(v - (v0 as number)) <= Math.abs(v0 as number) * 1e-6 : v === v0;
    });
    if (same) (out as Record<string, unknown>)[k] = v0;
  }
  return out;
}

// ---------- TIFF / Exif の組み立て ----------

type Entry = { tag: number; type: 2 | 3 | 4 | 5 | 7; count: number; data: number[] };
const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5;

const enc = new TextEncoder();
function ascii(tag: number, s: string): Entry {
  const b = [...enc.encode(s), 0];
  return { tag, type: ASCII, count: b.length, data: b };
}
function short(tag: number, v: number): Entry {
  const n = Math.max(0, Math.min(65535, Math.round(v)));
  return { tag, type: SHORT, count: 1, data: [n & 255, n >> 8, 0, 0] };
}
function u32(n: number) {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}
function rational(tag: number, num: number, den: number): Entry {
  return { tag, type: RATIONAL, count: 1, data: [...u32(num), ...u32(den)] };
}
/** 小数を分数に（露出時間 1/250 などは 1/250 のまま） */
function toRational(v: number, den: number): [number, number] {
  if (v > 0 && v < 1) {
    const inv = 1 / v;
    if (Math.abs(inv - Math.round(inv)) < 1e-3) return [1, Math.round(inv)];
  }
  return [Math.round(v * den), den];
}

/** IFD を書く。データ領域は IFD の直後に置く。next は次の IFD への位置（0 = なし） */
function writeIfd(out: number[], entries: Entry[], next = 0) {
  entries.sort((a, b) => a.tag - b.tag);
  const start = out.length;
  const dataStart = start + 2 + entries.length * 12 + 4;
  const data: number[] = [];
  out.push(entries.length & 255, entries.length >> 8);
  const ptrs: number[] = [];
  for (const e of entries) {
    out.push(e.tag & 255, e.tag >> 8, e.type, 0, ...u32(e.count));
    if (e.data.length <= 4) {
      out.push(...e.data, ...Array(4 - e.data.length).fill(0));
    } else {
      ptrs.push(out.length);
      out.push(...u32(dataStart + data.length));
      data.push(...e.data);
      if (data.length % 2) data.push(0);
    }
  }
  out.push(...u32(next));
  out.push(...data);
  return { start, ptrs };
}

/** Exif の TIFF 部分（"Exif\0\0" の後ろ）を作る。書くものが無ければ null */
export function buildTiff(m: Meta): Uint8Array<ArrayBuffer> | null {
  const ifd0: Entry[] = [short(0x0112, 1)]; // Orientation = 正位置（書き出しは向き補正済み）
  const exif: Entry[] = [];
  if (m.Make) ifd0.push(ascii(0x010f, String(m.Make)));
  if (m.Model) ifd0.push(ascii(0x0110, String(m.Model)));
  if (m.Artist) ifd0.push(ascii(0x013b, String(m.Artist)));
  if (m.Copyright) ifd0.push(ascii(0x8298, String(m.Copyright)));
  if (typeof m.ExposureTime === 'number') exif.push(rational(0x829a, ...toRational(m.ExposureTime, 1_000_000)));
  if (typeof m.FNumber === 'number') exif.push(rational(0x829d, ...toRational(m.FNumber, 10)));
  if (typeof m.ISO === 'number') exif.push(short(0x8827, m.ISO));
  if (m.DateTimeOriginal) exif.push(ascii(0x9003, String(m.DateTimeOriginal)));
  if (typeof m.FocalLength === 'number') exif.push(rational(0x920a, ...toRational(m.FocalLength, 100)));
  if (typeof m.FocalLengthIn35mmFormat === 'number') exif.push(short(0xa405, m.FocalLengthIn35mmFormat));
  if (m.LensMake) exif.push(ascii(0xa433, String(m.LensMake)));
  if (m.LensModel) exif.push(ascii(0xa434, String(m.LensModel)));
  if (ifd0.length === 1 && !exif.length) return null;
  const out: number[] = [0x49, 0x49, 42, 0, ...u32(8)];
  if (exif.length) {
    exif.push({ tag: 0x9000, type: 7, count: 4, data: [...enc.encode('0232')] }); // ExifVersion
    ifd0.push({ tag: 0x8769, type: LONG, count: 1, data: u32(0) });
  }
  writeIfd(out, ifd0);
  if (exif.length) {
    // IFD0 の ExifIFD ポインタに、Exif IFD の位置を書き込む
    const at = out.length;
    const n0 = out[8] | (out[9] << 8);
    for (let i = 0; i < n0; i++) {
      const p = 10 + i * 12;
      if ((out[p] | (out[p + 1] << 8)) === 0x8769) out.splice(p + 8, 4, ...u32(at));
    }
    writeIfd(out, exif);
  }
  return new Uint8Array(out);
}

/** JPEG の先頭（SOI の直後）に Exif（APP1）を差し込む */
export async function withExif(jpeg: Blob, m: Meta): Promise<Blob> {
  const tiff = buildTiff(m);
  if (!tiff || jpeg.type !== 'image/jpeg') return jpeg;
  const buf = new Uint8Array(await jpeg.arrayBuffer());
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return jpeg;
  const len = 2 + 6 + tiff.length;
  if (len > 65535) return jpeg;
  const head = new Uint8Array([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  return new Blob([buf.subarray(0, 2), head, tiff, buf.subarray(2)], { type: 'image/jpeg' });
}
