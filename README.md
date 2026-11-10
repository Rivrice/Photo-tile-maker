# Photo Tile Maker

複数の写真（最大20枚）を、色・明るさ・構図を読み取る自動レイアウトでタイル状に並べるWebアプリです。
[Exif Frame Maker](https://rivrice.github.io/exif-frame-maker/) の姉妹アプリです。

## 主な機能

- **9種類の自動レイアウト**：モザイク（縦横比に合わせて再帰分割）／行そろえ／グリッド／マソンリー／主役＋脇役／黄金スパイラル／ハニカム／ドット（円）／散らし（白フチ・回転）
- **斜めカット**：タイルの縦の境界線を傾けて、斜めに切り分けたタイルにする
- **ドラッグで直感操作**：プレビュー上で写真をドラッグして入れ替え、「位置調整」モードでトリミング位置を移動（ホイールでズーム）。写真一覧もドラッグで並べ替え（スマホは長押し）
- **並べ替え**：明るい順／暗い順／色相（虹色）／鮮やかな順／色のグラデーション（似た色をつなぐ）／構図ごと／撮影日時／ファイル名／シャッフル／逆順
- **おまかせ配置**：タイルの形（縦長・横長）に合う写真を自動で割り当て、トリミングを最小に
- **構図の自動検出**：日の丸・三分割・黄金比・対角線・水平線・シンメトリーを推定し、
  - 構図を保ったトリミング（被写体の位置の割合を保つ）
  - タイル内に図形を組み込み：ガイド線／アクセント（太線）／切り抜き（円・スパイラル・三角・半円・アーチ）
- **背景色**：定番色と、読み込んだ写真から抽出した色
- **書き出し**：JPEG / PNG / WebP、長辺 1080〜4096px

## 画像の解像度について

- 読み込み時に、プレビュー用（長辺1280px）と一覧用の縮小画像だけをメモリに保持します。
- 書き出し時は、各タイルの実際のピクセルサイズに合わせて元写真から必要な範囲だけを縮小して取り出し、1枚ずつ配置します（元より大きくは引き伸ばしません）。

## プライバシー

写真の読み込み・解析・書き出しはすべてブラウザ内で行われ、外部に送信されません。書き出した画像にExif（位置情報など）は残りません。

## 使い方（ローカル）

```bash
npm install
npm run dev      # 開発サーバー http://localhost:5173
npm run build    # dist/ に本番ビルド
npm run preview  # ビルド結果の確認
```

## GitHub Pages で公開

`.github/workflows/deploy.yml` が `main` への push で自動ビルド・デプロイします。
初回のみリポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。

## Android版（APK）

Exif Frame Maker と同じく [Capacitor](https://capacitorjs.com/) で Android アプリにしています（アプリID: `io.github.rivrice.phototile`）。

- `.github/workflows/android.yml` が `main` への push で APK をビルドし、**Releases** に `photo-tile-maker.apk` を公開します（PR ではビルド確認のみ）。
- 署名鍵はリポジトリに含めず、GitHub Secrets から渡します。
  - `ANDROID_KEYSTORE_BASE64`：キーストア（PKCS12）を Base64 にしたもの
  - `ANDROID_KEYSTORE_PASSWORD`：キーストアと鍵のパスワード（共通）
  - 鍵のエイリアスは `phototile`
  - 未登録のときは一時的な鍵で署名されます（更新時にアンインストールが必要）
- アプリ版では、書き出した画像を共有シート（ギャラリー / Googleフォトなど）か端末の `Documents/PhotoTileMaker` に保存できます。WebView が読めない HEIC は Android 標準のデコーダーで変換します。

ローカルでビルドする場合（Android SDK と JDK 21 が必要）：

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
```

## 構成

| ファイル | 内容 |
| --- | --- |
| `src/layouts.ts` | 自動レイアウト（タイルを凸多角形として生成） |
| `src/analyze.ts` | 色・明るさの統計と構図の推定 |
| `src/photos.ts` | 読み込み・縮小・書き出し用の切り出し |
| `src/render.ts` | タイル・構図図形の描画（プレビュー／書き出し共通） |
| `src/native.ts` | Androidアプリ版の保存・共有・HEIC変換 |
| `src/main.ts` | UI |

## ライセンス

MIT（商用利用可）。依存ライブラリも商用利用可能なライセンス（MIT / OFL-1.1）のみで、
`npm run build` 時に `scripts/licenses.mjs` がライセンスを確認し `THIRD_PARTY_LICENSES.txt` を生成します。
