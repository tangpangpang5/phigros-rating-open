/* 极简 YAML 结构自检：只针对本文件用到的子集
   （2 空格缩进映射 / `- ` 列表项 / `key: |` 块标量 / `#` 注释 / 引号字符串）。
   用途：在不能把模板推上 GitHub 之前，先排除「缩进错、漏冒号、制表符」这类低级错误。
   它**不做**完整 YAML 校验，也不替代 GitHub 自己的 issue form 校验。 */
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
let fails = 0;

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const errs = [];
  let blockIndent = -1;          // 正在块标量里时，记录它的内容缩进
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (/\t/.test(raw)) errs.push(n + ': 含制表符');
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) errs.push(n + ': 缩进 ' + indent + ' 不是 2 的倍数');

    if (blockIndent >= 0) {
      if (indent > blockIndent) return;   // 块标量内容，跳过
      blockIndent = -1;
    }
    if (indent > 0 && indent % 2 !== 0) return;
    const body = line.trim();
    if (body.startsWith('- ')) {
      const item = body.slice(2);
      /* 列表项可以是 `- key: value` 或纯标量 */
      if (item.includes(':') && !/^["'].*["']\s*$/.test(item)) {
        const m = item.match(/^[^:]+:/);
        if (!m) errs.push(n + ': 列表项里的映射缺冒号');
      }
      return;
    }
    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) { errs.push(n + ': 不是 `key:` 也不是 `- ` 开头 -> ' + body.slice(0, 40)); return; }
    if (m[2].trim() === '|' || m[2].trim() === '>') blockIndent = indent;
  });
  if (errs.length) { fails++; console.log('FAIL ' + path.basename(f)); errs.slice(0, 8).forEach(e => console.log('   ' + e)); }
  else console.log('OK   ' + path.basename(f) + '  (' + lines.length + ' 行)');
}
console.log(fails ? '\n结构自检：' + fails + ' 个文件有问题' : '\n结构自检：全部通过');
process.exitCode = fails ? 1 : 0;
