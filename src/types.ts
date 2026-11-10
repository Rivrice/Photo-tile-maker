export interface Pt {
  x: number;
  y: number;
}

export interface ColorStats {
  /** 平均輝度 0..1 */
  lum: number;
  /** 代表色の色相 0..360 */
  hue: number;
  /** 平均彩度 0..1 */
  sat: number;
  /** 平均色 */
  avg: [number, number, number];
  /** 主要色（明るさ順ではなく面積順） */
  palette: string[];
}

export type CompType = 'center' | 'thirds' | 'golden' | 'diagonal' | 'horizon' | 'symmetry';

export interface Composition {
  type: CompType;
  /** 主被写体の位置（0..1） */
  focus: Pt;
  /** 信頼度 0..1 */
  score: number;
  /** 被写体の広がり（短辺に対する比） */
  spread: number;
  /** 水平線の位置（0..1、horizon のとき） */
  horizon?: number;
  /** 対角線の向き：1 = 左上→右下, -1 = 右上→左下 */
  diag?: 1 | -1;
  /** 検出した対角方向の線（0..1、画像の端から端まで） */
  line?: { a: Pt; b: Pt };
  /** 左右対称の軸（0..1） */
  axis?: number;
}

export interface PhotoItem {
  id: string;
  name: string;
  /** 元ファイル（書き出し時に必要な解像度だけ取り出す）。サンプルは null */
  file: File | null;
  /** 向き補正後の元サイズ */
  width: number;
  height: number;
  /** プレビュー用の縮小画像（長辺 PREVIEW_EDGE 以下） */
  preview: CanvasImageSource & { width: number; height: number };
  thumbUrl: string;
  /** レイアウト一覧の小さなプレビュー用 */
  mini: HTMLCanvasElement;
  stats: ColorStats;
  comp: Composition;
  /** 構図の手動上書き（null = 自動） */
  compOverride: CompType | 'none' | null;
  date: number;
  /** トリミング中心の手動指定（null = 構図から自動） */
  pan: Pt | null;
  zoom: number;
  /** 元ファイルからの回転（時計回り 90° × rot） */
  rot: number;
  /** タイルの中での写真の回転角（度、時計回り） */
  angle: number;
}

/**
 * レイアウト結果の1タイル。
 * 中心 (cx, cy) と回転 rot、ローカル座標系の w×h の枠に写真をカバー表示し、
 * clip（ローカル座標の凸多角形）で切り抜く。
 */
export interface Tile {
  idx: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
  clip: Pt[];
  /** 散らしレイアウトの白フチ */
  frame?: number;
}

export type OverlayMode = 'none' | 'guide' | 'accent' | 'cutout';

export interface Settings {
  layout: string;
  aspect: string;
  columns: number;
  gap: number;
  margin: number;
  radius: number;
  slant: number;
  seed: number;
  bg: string;
  overlay: OverlayMode;
  overlayColor: string;
  showLabel: boolean;
  smartCrop: boolean;
  format: 'image/jpeg' | 'image/png' | 'image/webp';
  quality: number;
  outEdge: number;
  gradKey: 'bright' | 'hue' | 'sat' | 'tone';
  gradDir: 'lr' | 'tb' | 'tlbr' | 'bltr' | 'radial';
  gradRev: boolean;
}
