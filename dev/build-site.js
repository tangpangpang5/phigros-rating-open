/* ===========================================================================
 * dev/build-site.js —— 打包：把「站点必需文件」复制进 dist/
 *
 * ⚠️ 这是**公开仓变体**。它内置了针对**完整数据仓库**的数量校验：
 *    必需单文件清单（含 songs.json）+ js/ 8 个模块 + covers/ 311 张曲绘。
 *    而公开仓按设计**不含 songs.json 与 covers/**（版权原因），
 *    所以在本仓库直接跑它会**故意失败退出**。
 *    要用它：先按自己的实际情况改下面的 REQUIRED_FILES / REQUIRED_DIRS，
 *    或者在准备好的完整项目里跑（那边这两项是齐的）。
 *
 * 设计要点（踩过坑才这么写）：
 *   · 先复制到临时目录 dist.tmp/，三道闸门全过之后才原子替换 dist/
 *     ⇒ 任何一关不过，dist/ 一个字节都不动，绝不留下「不完整但看起来正常」的产物；
 *   · 闸门 A：违禁文件（_ 开头的开发文件、.md/.sql/日志/临时产物）
 *   · 闸门 B：数量（清单齐不齐、目录条目数对不对）
 *   · 闸门 C：占位符（产物里不得残留 __XXX__ 形态的未替换串）
 * =========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + path.sep + '..';        // 仓库根目录（本脚本在 dev/ 下）
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, 'dist.tmp');

/** 站点必需的单文件清单 */
const REQUIRED_FILES = [
  'index.html',
  'config.js',
  'data.js',
  'songs.json',
  'modern.css',
  'minimal.css',
  'layout.css',
  '九鸟.jpg',
  'bg.jpg',        /* 现代主题的整页背景图；漏掉它线上背景就一直是坏的 */
];

/** 需要整目录复制的：源相对路径 → 期望条目数 */
const REQUIRED_DIRS = [
  { dir: 'js', expectFiles: 8 },
  { dir: 'covers', expectFiles: 311 },
];

/** 绝不能出现在产物里的东西 */
const FORBIDDEN = [
  { name: '下划线开头的开发文件/目录', test: (rel) => rel.split('/').some((seg) => seg.startsWith('_')) },
  { name: 'Markdown 文档（.md）', test: (rel) => /\.md$/i.test(rel) },
  { name: 'SQL 脚本（.sql）', test: (rel) => /\.sql$/i.test(rel) },
  { name: '日志文件（.log）', test: (rel) => /\.log$/i.test(rel) },
  { name: '临时/备份产物（.tmp/.bak/.zip/.swp/~）', test: (rel) => /(\.tmp|\.bak|\.zip|\.swp|~)$/i.test(rel) },
];

const PLACEHOLDER_SCAN_EXT = /\.(html|htm|js|mjs|cjs|json|css)$/i;
const PLACEHOLDER_RE = /__[A-Z0-9_]+__/g;

let failed = false;
const fail = (msg) => { failed = true; console.error('  ✗ ' + msg); };

function copyFile(rel, destRoot) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { fail('缺少必需文件：' + rel); return false; }
  const dst = path.join(destRoot, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function listFiles(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

console.log('=== build-site.js · 打包站点必需文件（原子打包）===');

/* 1) 清理上一次的暂存目录 */
fs.rmSync(STAGE, { recursive: true, force: true });

/* 2) 复制到暂存目录 */
console.log('\n[1/5] 复制站点必需文件到 dist.tmp/ …');
let copiedSingles = 0;
let copiedDirFiles = 0;
for (const rel of REQUIRED_FILES) if (copyFile(rel, STAGE)) copiedSingles++;
for (const { dir, expectFiles } of REQUIRED_DIRS) {
  const srcDir = path.join(ROOT, dir);
  if (!fs.existsSync(srcDir)) { fail(`缺少必需目录：${dir}/`); continue; }
  const entries = fs.readdirSync(srcDir).filter((f) => fs.statSync(path.join(srcDir, f)).isFile());
  if (entries.length !== expectFiles) {
    fail(`${dir}/ 条目数 = ${entries.length}，与脚本期望的 ${expectFiles} 不符（数据变了就同步改本脚本，别默默发出去）`);
  }
  fs.mkdirSync(path.join(STAGE, dir), { recursive: true });
  for (const f of entries) { fs.copyFileSync(path.join(srcDir, f), path.join(STAGE, dir, f)); copiedDirFiles++; }
}
console.log(`  · 单文件 ${copiedSingles}/${REQUIRED_FILES.length} 个，目录内文件 ${copiedDirFiles} 个`);

/* 3) 闸门 A：违禁文件 */
console.log('\n[2/5] 闸门 A · 违禁文件（不得含开发/文档/临时文件）…');
const staged = listFiles(STAGE, '');
for (const rel of staged) {
  for (const f of FORBIDDEN) if (f.test(rel)) fail(`产物含违禁内容（${f.name}）：${rel}`);
}

/* 4) 闸门 C：占位符（先扫文本类文件） */
console.log('\n[3/5] 闸门 B · 占位符（不得含未替换的 __XXX__ 形态字符串）…');
for (const rel of staged) {
  if (!PLACEHOLDER_SCAN_EXT.test(rel)) continue;
  const text = fs.readFileSync(path.join(STAGE, rel), 'utf8');
  const hit = text.match(PLACEHOLDER_RE);
  if (hit) fail(`产物含未替换占位符 ${[...new Set(hit)].join(', ')}：${rel}`);
}

/* 5) 汇总数量 */
console.log('\n[4/5] 闸门 C · 数量核对 …');
console.log(`  · 产物文件合计 ${staged.length} 个`);

/* 6) 通过才替换 */
console.log('\n[5/5] ' + (failed ? '闸门未全部通过 ⇒ 不替换 dist/' : '闸门全部通过 ⇒ 原子替换 dist/ …'));
if (failed) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  console.error('\n✗ 打包失败：dist/ 未被改动。');
  process.exit(1);
}
fs.rmSync(DIST, { recursive: true, force: true });
fs.renameSync(STAGE, DIST);
console.log(`✓ 打包完成：${listFiles(DIST, '').length} 个文件 → dist/`);
