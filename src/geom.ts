// 多角形の幾何（カスタムレイアウトの区切り・自動調整で使う）
import type { Pt } from './types';

export function area(poly: Pt[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
/** 面積の重心（曲線で区切ったマスのように、点が片側に偏っていてもずれない） */
export function centroid(poly: Pt[]): Pt {
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
export function distToEdges(poly: Pt[], x: number, y: number) {
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
export function labelPoint(poly: Pt[]): Pt {
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
export function thickness(poly: Pt[]) {
  let per = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    per += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return per ? (2 * Math.abs(area(poly))) / per : 0;
}
export function bbox(poly: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}
export function inside(poly: Pt[], x: number, y: number) {
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
export function crossings(poly: Pt[], path: Pt[]): Cross[] {
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
export function walk(poly: Pt[], a: number, b: number): Pt[] {
  const n = poly.length;
  const end = b < a ? b + n : b;
  const out: Pt[] = [];
  for (let k = Math.floor(a) + 1; k <= end; k++) out.push(poly[k % n]);
  return out;
}
/** 折れ線上の距離 s の点 */
export function pointAt(path: Pt[], s: number): Pt {
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
export function subPath(path: Pt[], s1: number, s2: number): Pt[] {
  const out = [pointAt(path, s1)];
  let acc = 0;
  for (let k = 0; k + 1 < path.length; k++) {
    acc += Math.hypot(path[k + 1].x - path[k].x, path[k + 1].y - path[k].y);
    if (acc > s1 && acc < s2) out.push(path[k + 1]);
  }
  out.push(pointAt(path, s2));
  return out;
}

export interface CutOpts {
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
export function cutPoly(poly: Pt[], path: Pt[], o: CutOpts, depth = 0): Pt[][] {
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
export function pathLen(pts: Pt[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

// ---------- 写真の枚数に合わせて、マスを増やす・減らす ----------

/** マスを、長い方の辺と直角な直線で面積が半分ずつになるように分ける。分けられなければ null */
export function splitHalf(poly: Pt[]): Pt[][] | null {
  const b = bbox(poly);
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const total = Math.abs(area(poly));
  const o: CutOpts = { from: 0, to: Infinity, minIn: 0, minArea: 0, minThick: 0 };
  for (const vertical of w >= h ? [true, false] : [false, true]) {
    const at = (t: number) => {
      const line = vertical
        ? [{ x: b.x0 + w * t, y: b.y0 - h - 10 }, { x: b.x0 + w * t, y: b.y1 + h + 10 }]
        : [{ x: b.x0 - w - 10, y: b.y0 + h * t }, { x: b.x1 + w + 10, y: b.y0 + h * t }];
      const pieces = cutPoly(poly, line, o);
      const pos = (p: Pt[]) => (vertical ? centroid(p).x : centroid(p).y);
      const cut = vertical ? b.x0 + w * t : b.y0 + h * t;
      const first = pieces.filter((p) => pos(p) < cut);
      const a = first.reduce((s, p) => s + Math.abs(area(p)), 0);
      return { pieces, first, a };
    };
    // 面積が半分になる位置を二分探索
    let lo = 0.02, hi = 0.98;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (at(m).a < total / 2) lo = m;
      else hi = m;
    }
    const r = at((lo + hi) / 2);
    if (r.pieces.length >= 2 && r.first.length && r.first.length < r.pieces.length) {
      const rest = r.pieces.filter((p) => !r.first.includes(p));
      return [...r.first, ...rest];
    }
  }
  return null;
}

/** 線分 ab 上（両端を除く）に点 p があるか */
function onSeg(p: Pt, a: Pt, b: Pt, eps: number) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  if (l2 < eps * eps) return false;
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
  if (t <= 0 || t >= 1) return false;
  return Math.hypot(a.x + vx * t - p.x, a.y + vy * t - p.y) < eps;
}
/** 辺の途中に乗っている相手の頂点を、こちらの頂点としても入れる（T字の継ぎ目をなくす） */
function addJoints(P: Pt[], Q: Pt[], eps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    out.push(a);
    const on = Q.filter((q) => onSeg(q, a, b, eps)).sort((u, v) => Math.hypot(u.x - a.x, u.y - a.y) - Math.hypot(v.x - a.x, v.y - a.y));
    out.push(...on);
  }
  return out;
}
const ccw = (p: Pt[]) => (area(p) < 0 ? p.slice().reverse() : p);
/**
 * となり合う 2 つのマスを 1 つにする。共有する辺がなければ null。
 * 戻り値の 2 つめは共有していた辺の長さ。
 */
export function mergeCells(A0: Pt[], B0: Pt[], eps: number): [Pt[], number] | null {
  let A = ccw(A0), B = ccw(B0);
  A = addJoints(A, B, eps);
  B = addJoints(B, A, eps);
  // 近い頂点は同じ点にそろえる
  B = B.map((q) => A.find((p) => Math.hypot(p.x - q.x, p.y - q.y) < eps) ?? q);
  const same = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < eps;
  type E = [Pt, Pt];
  const ea: E[] = A.map((p, i) => [p, A[(i + 1) % A.length]]);
  const eb: E[] = B.map((p, i) => [p, B[(i + 1) % B.length]]);
  let shared = 0;
  const keepA = ea.map(() => true), keepB = eb.map(() => true);
  ea.forEach(([p, q], i) => {
    const j = eb.findIndex(([r, s], k) => keepB[k] && same(p, s) && same(q, r));
    if (j >= 0) {
      keepA[i] = false;
      keepB[j] = false;
      shared += Math.hypot(q.x - p.x, q.y - p.y);
    }
  });
  if (shared < eps * 4) return null;
  const edges = [...ea.filter((_, i) => keepA[i]), ...eb.filter((_, i) => keepB[i])].filter(([p, q]) => !same(p, q));
  if (edges.length < 3) return null;
  // 残った辺をつないで 1 周させる
  const out: Pt[] = [];
  const used = edges.map(() => false);
  let cur = 0;
  for (let n = 0; n < edges.length; n++) {
    used[cur] = true;
    out.push(edges[cur][0]);
    const end = edges[cur][1];
    const next = edges.findIndex((e, k) => !used[k] && same(e[0], end));
    if (next < 0) {
      if (n === edges.length - 1 && same(end, edges[0][0])) break;
      return null;
    }
    cur = next;
  }
  if (out.length !== edges.length) return null;
  // 一直線に並んだ頂点を間引く
  const clean = out.filter((p, i) => {
    const a = out[(i + out.length - 1) % out.length], b = out[(i + 1) % out.length];
    const cr = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
    return Math.abs(cr) > eps * Math.hypot(b.x - a.x, b.y - a.y) * 0.5;
  });
  if (clean.length < 3 || Math.abs(area(clean)) < Math.abs(area(A0)) + Math.abs(area(B0)) - eps * 50) return null;
  return [clean, shared];
}

/**
 * マス（ピクセル座標）の数を n にそろえる。
 * 多いとき：小さいマスから、いちばん長く接しているとなりのマスとまとめる。
 * 少ないとき：いちばん大きいマスを半分に分ける。
 */
export function fitCells(cells: Pt[][], n: number, eps = 2.5): Pt[][] {
  let cs = cells.map((c) => c.slice());
  if (n <= 0) return cs;
  let guard = 0;
  while (cs.length < n && guard++ < 200) {
    const order = cs.map((c, i) => [Math.abs(area(c)), i]).sort((a, b) => b[0] - a[0]);
    let done = false;
    for (const [, i] of order) {
      const parts = splitHalf(cs[i]);
      if (!parts) continue;
      cs.splice(i, 1, ...parts);
      done = true;
      break;
    }
    if (!done) break;
  }
  guard = 0;
  while (cs.length > n && guard++ < 200) {
    const order = cs.map((c, i) => [Math.abs(area(c)), i]).sort((a, b) => a[0] - b[0]);
    let done = false;
    for (const [, i] of order) {
      let best: { j: number; poly: Pt[]; len: number } | null = null;
      for (let j = 0; j < cs.length; j++) {
        if (j === i) continue;
        const m = mergeCells(cs[j], cs[i], eps);
        if (m && (!best || m[1] > best.len)) best = { j, poly: m[0], len: m[1] };
      }
      if (!best) continue;
      cs[best.j] = best.poly;
      cs.splice(i, 1);
      done = true;
      break;
    }
    // どれもまとめられない（重なったマスなど）ときは、いちばん小さいマスを外す
    if (!done) cs.splice(order[0][1], 1);
  }
  return cs;
}
