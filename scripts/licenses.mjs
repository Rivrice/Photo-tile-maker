// 配布物（Webサイト / APK）に同梱するサードパーティライセンス一覧を生成する。
// 出力: public/THIRD_PARTY_LICENSES.txt（ビルド時に dist/ に含まれる）
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'public', 'THIRD_PARTY_LICENSES.txt');
const LINE = '='.repeat(78);
// 商用利用できるライセンスだけを許可（それ以外が入ったらビルドを止める）
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1', '0BSD']);

function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null;
}

// 本番依存（npm ls --omit=dev）を列挙
const paths = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter((p) => p && p.includes('node_modules'));

const seen = new Set();
const pkgs = [];
for (const dir of paths) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const id = `${pj.name}@${pj.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const license = pj.license ?? 'UNKNOWN';
  if (!ALLOWED.has(license)) throw new Error(`商用利用を確認できないライセンスです: ${id} (${license})`);
  const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url ?? pj.homepage ?? '';
  const text = licenseText(dir);
  if (!text) throw new Error(`ライセンスファイルが見つかりません: ${id}`);
  pkgs.push({ id, license, repo: repo.replace(/^git\+/, ''), text });
}
pkgs.sort((a, b) => a.id.localeCompare(b.id));

const apache = readFileSync(join(root, 'node_modules', 'typescript', 'LICENSE'), 'utf8').trim();

// Androidアプリ（APK）にのみ含まれる Java/Kotlin ライブラリ
const androidLibs = [
  ['AndroidX (activity, appcompat, coordinatorlayout, core, core-splashscreen, fragment, webkit ほか)', 'Apache-2.0', 'Copyright The Android Open Source Project', 'https://developer.android.com/jetpack/androidx'],
  ['Apache Cordova Android framework', 'Apache-2.0', 'Copyright The Apache Software Foundation', 'https://github.com/apache/cordova-android'],
  ['Kotlin Standard Library / kotlinx.coroutines', 'Apache-2.0', 'Copyright JetBrains s.r.o. and Kotlin Programming Language contributors', 'https://github.com/Kotlin/kotlinx.coroutines'],
  ['Capacitor Android (com.capacitorjs:core)', 'MIT', 'Copyright (c) 2017-present Drifty Co.', 'https://github.com/ionic-team/capacitor'],
  ['ionfilesystem-android (io.ionic.libs)', 'MIT', 'Copyright (c) 2025 Ionic', 'https://github.com/ionic-team/ion-android-filesystem'],
];

const MIT_TEMPLATE = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;


let txt = `Photo Tile Maker - Third-Party Software Notices / サードパーティライセンス一覧
${LINE}

Photo Tile Maker 本体は MIT License で公開しています。
https://github.com/Rivrice/photo-tile-maker

本アプリは以下のオープンソースソフトウェアおよびフォントを使用しています。
各ソフトウェアの著作権は、それぞれの著作権者に帰属します。

一覧:
${pkgs.map((p) => `  - ${p.id} (${p.license})`).join('\n')}
${androidLibs.map(([n, l]) => `  - ${n} (${l}) ※Androidアプリ版のみ`).join('\n')}
`;
for (const p of pkgs) txt += `\n${LINE}\n${p.id}  —  ${p.license}\n${p.repo}\n${LINE}\n\n${p.text}\n`;

txt += `\n${LINE}\nAndroidアプリ版（APK）に含まれるライブラリ\n${LINE}\n`;
for (const [name, lic, copy, url] of androidLibs) {
  txt += `\n${name}\n  License: ${lic}\n  ${copy}\n  ${url}\n`;
  if (lic === 'MIT') txt += `\n${copy}\n\n${MIT_TEMPLATE}\n`;
}
txt += `\n${LINE}\nApache License 2.0（上記 Apache-2.0 のライブラリに適用）\n${LINE}\n\n${apache}\n`;

writeFileSync(out, txt);
console.log(`THIRD_PARTY_LICENSES.txt: ${pkgs.length} npm packages + ${androidLibs.length} Android libraries`);
