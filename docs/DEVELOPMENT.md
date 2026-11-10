# 開発・公開の手順

## ローカルで動かす

```bash
npm install
npm run dev      # 開発サーバー http://localhost:5173
npm run build    # dist/ に本番ビルド（ライセンス確認・型チェック込み）
npm run preview  # ビルド結果の確認
```

## ブラウザ版（GitHub Pages）

`.github/workflows/deploy.yml` が `main` への push で自動ビルド・公開します。

リポジトリ側の設定：

- **Settings → General → Default branch** が `main` であること
- **Settings → Pages → Build and deployment → Source** が **GitHub Actions** であること
- **Settings → Environments → github-pages → Deployment branches and tags** で `main` が許可されていること

## Android版（APK）

[Capacitor](https://capacitorjs.com/) で Android アプリにしています（アプリID：`io.github.rivrice.phototile`）。

`.github/workflows/android.yml` の動き：

- PR：APK のビルド確認のみ
- `main` への push と手動実行：署名付き APK を作り、Releases に `photo-tile-maker.apk` として公開

### 署名鍵

署名鍵はリポジトリに含めず、**Settings → Secrets and variables → Actions** から渡します。

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | キーストア（PKCS12）を Base64 にしたもの |
| `ANDROID_KEYSTORE_PASSWORD` | キーストアと鍵のパスワード（共通） |

- 鍵のエイリアスは `phototile`
- Secrets が未登録のときは一時的な鍵で署名されます（その版からの更新にはアンインストールが必要）
- 同じ鍵がないとアプリを上書き更新できないため、鍵の原本は必ずバックアップしてください
- `*.keystore` / `*.jks` は `.gitignore` 済みです

### ローカルでビルドする

Android SDK と JDK 21 が必要です。

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
```

## ライセンスの確認

`npm run build` の最初に `scripts/licenses.mjs` が本番依存のライセンスを確認し、
商用利用できるもの（MIT / ISC / BSD / Apache-2.0 / OFL-1.1 / 0BSD）以外が含まれるとビルドを止めます。
同時に `public/THIRD_PARTY_LICENSES.txt`（APK に含まれる Android ライブラリを含む）を生成します。

## ソースの構成

| ファイル | 内容 |
| --- | --- |
| `src/layouts.ts` | 自動レイアウト（タイルを凸多角形として生成） |
| `src/analyze.ts` | 色・明るさの統計と構図の推定 |
| `src/photos.ts` | 読み込み・縮小・書き出し用の切り出し |
| `src/render.ts` | タイル・構図図形の描画（プレビュー／書き出し共通） |
| `src/native.ts` | Androidアプリ版の保存・共有・HEIC変換 |
| `src/main.ts` | UI |

### 画像の解像度

- 読み込み時は、プレビュー用（長辺1280px）と一覧用の縮小画像だけをメモリに保持します
- 書き出し時は、各タイルの実際のピクセルサイズに合わせて元写真から必要な範囲だけを縮小して取り出し、1枚ずつ配置します（元より大きくは引き伸ばしません）
