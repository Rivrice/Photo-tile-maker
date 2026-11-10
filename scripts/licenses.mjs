// 配布物（Webサイト）に同梱するサードパーティライセンス一覧を生成する。
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

let txt = `Photo Tile Maker - Third-Party Software Notices / サードパーティライセンス一覧
${LINE}

Photo Tile Maker 本体は MIT License で公開しています。
https://github.com/Rivrice/photo-tile-maker

本アプリは以下のオープンソースソフトウェアおよびフォントを使用しています。
各ソフトウェアの著作権は、それぞれの著作権者に帰属します。

一覧:
${pkgs.map((p) => `  - ${p.id} (${p.license})`).join('\n')}
`;
for (const p of pkgs) txt += `\n${LINE}\n${p.id}  —  ${p.license}\n${p.repo}\n${LINE}\n\n${p.text}\n`;

writeFileSync(out, txt);
console.log(`THIRD_PARTY_LICENSES.txt: ${pkgs.length} npm packages`);
