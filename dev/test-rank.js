/* =========================================================
 * _test-rank.js —— A 组判据：榜单计算口径（纯函数 rankRows/mostDiffOf）
 * 运行：node --test D:\phi\_test-rank.js
 *
 * 为什么这么写：
 *   本目录没有 package.json（`serve.js` / `_mocksupa.js` 用的是 CommonJS），
 *   node 会把 .js 当 CommonJS，无法直接 import 站点的 ES 模块。
 *   于是把 js/*.js **原样复制**（不改一字）到临时目录，并在那里放一份
 *   {"type":"module"} 的 package.json，再动态 import —— 这样被测代码与线上逐字节相同，
 *   而且不需要浏览器、不需要起服务、不 import 任何 DOM。
 * ========================================================= */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-rank-test-'));
fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({ type: 'module' }));
fs.cpSync(path.join(SRC, 'js'), path.join(TMP, 'js'), { recursive: true });

let modPromise = null;
function rank() {
  if (!modPromise) modPromise = import(pathToFileURL(path.join(TMP, 'js', 'rank.js')).href);
  return modPromise;
}

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } });

/* ---------------- 夹具 ---------------- */
const D = (level, rating, constant) => ({ level, rating, constant });
function song(id, diffs) {
  return { id: id, title: '曲目 ' + id, artist: '曲师', chapter: '章节', difficulties: diffs };
}
function rate(songId, scores) {
  return scores.map((s, i) => ({ id: 'r_' + songId + '_' + i, song_id: songId, user_id: 'u' + i, score: s }));
}

/* SET1：a=4 条低分（count 高、均分低）、b=1 条高分、c=3 条高分、d=零评分、另有脏数据 */
const SET1_SONGS = [
  song('a', [D('EZ', 3, 3.0)]),
  song('b', [D('IN', 15, 15.2)]),
  song('c', [D('AT', 16, 16.4), D('IN', 16, 16.1)]),
  song('d', [D('EZ', 1, 1.0)])
];
const SET1_RATINGS = [].concat(
  rate('a', [4, 4, 4, 4]),
  rate('b', [8]),
  rate('c', [10, 9, 9]),
  rate('nope', [10, 10])                       // 曲库里没有这首歌 → 必须被忽略
);

const ids = rows => rows.map(r => r.song.id);

test('A1 同一曲目多次评分取算术平均', async () => {
  const { rankRows } = await rank();
  const rows = rankRows([song('x', [D('IN', 15, 15)])], rate('x', [9, 7]), { minCount: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].sum, 16);
  assert.equal(rows[0].avg, 8);
});

test('A2 均分不用于排序取整（10/9/9 → 9.333…，展示才是 9.3）', async () => {
  const { rankRows } = await rank();
  const rows = rankRows([song('x', [D('IN', 15, 15)])], rate('x', [10, 9, 9]), { minCount: 1 });
  assert.ok(Math.abs(rows[0].avg - 28 / 3) < 1e-12, 'avg=' + rows[0].avg);
  assert.equal(rows[0].avg.toFixed(1), '9.3');
});

test('A3 零评分曲目不上榜', async () => {
  const { rankRows } = await rank();
  const rows = rankRows(SET1_SONGS, SET1_RATINGS, { minCount: 1 });
  assert.ok(!ids(rows).includes('d'), '零评分的 d 不该出现：' + ids(rows).join(','));
});

test('A4 阈值过滤：minCount=3 只留 count>=3；阈值大于全部人数返回空数组且不抛异常', async () => {
  const { rankRows } = await rank();
  const rows = rankRows(SET1_SONGS, SET1_RATINGS, { minCount: 3 });
  assert.deepEqual(ids(rows).sort(), ['a', 'c']);
  rows.forEach(r => assert.ok(r.count >= 3));
  assert.deepEqual(rankRows(SET1_SONGS, SET1_RATINGS, { minCount: 999 }), []);
});

test('A5 三个维度降序时主键序列非递增', async () => {
  const { rankRows } = await rank();
  const nonIncreasing = (arr, get) => {
    for (let i = 1; i < arr.length; i++) assert.ok(get(arr[i - 1]) >= get(arr[i]), JSON.stringify(arr.map(get)));
  };
  nonIncreasing(rankRows(SET1_SONGS, SET1_RATINGS, { sort: 'avg', minCount: 1 }), r => r.avg);
  nonIncreasing(rankRows(SET1_SONGS, SET1_RATINGS, { sort: 'count', minCount: 1 }), r => r.count);
  nonIncreasing(rankRows(SET1_SONGS, SET1_RATINGS, { sort: 'level', minCount: 1 }), r => Number(r.mostDiff.constant));
});

test('A6 并列规则：avg 相同 → count 大者在前，count 也相同 → song_id 升序在前', async () => {
  const { rankRows } = await rank();
  const songs = [song('a', [D('EZ', 1, 1)]), song('b', [D('EZ', 1, 1)]), song('m', [D('EZ', 1, 1)])];
  const ratings = [].concat(rate('a', [5]), rate('b', [5]), rate('m', [5, 5]));
  const rows = rankRows(songs, ratings, { sort: 'avg', dir: 'desc', minCount: 1 });
  assert.deepEqual(ids(rows), ['m', 'a', 'b']);
});

test('A7 方向只作用于主键：avg 升序时最小均分在前，并列仍按 count 降序', async () => {
  const { rankRows } = await rank();
  const songs = [song('a', [D('EZ', 1, 1)]), song('b', [D('EZ', 1, 1)]), song('m', [D('EZ', 1, 1)])];
  const ratings = [].concat(rate('a', [5]), rate('b', [5]), rate('m', [5, 5]));
  const rows = rankRows(songs, ratings, { sort: 'avg', dir: 'asc', minCount: 1 });
  assert.deepEqual(ids(rows), ['m', 'a', 'b']);
  const mixed = rankRows(SET1_SONGS, SET1_RATINGS, { sort: 'avg', dir: 'asc', minCount: 1 });
  assert.equal(mixed[0].avg, 4);
  assert.equal(mixed[mixed.length - 1].song.id, 'c');
});

test('A8 rank 从 1 连续递增，等于下标 + 1', async () => {
  const { rankRows } = await rank();
  const rows = rankRows(SET1_SONGS, SET1_RATINGS, { minCount: 1 });
  assert.equal(rows.length, 3);
  rows.forEach((r, i) => assert.equal(r.rank, i + 1));
});

test('A9 难度筛选：difficulty=AT 只保留含 AT 的曲目，all 不过滤', async () => {
  const { rankRows } = await rank();
  const at = rankRows(SET1_SONGS, SET1_RATINGS, { difficulty: 'AT', minCount: 1 });
  assert.deepEqual(ids(at), ['c']);
  const all = rankRows(SET1_SONGS, SET1_RATINGS, { difficulty: 'all', minCount: 1 });
  assert.deepEqual(ids(all).sort(), ['a', 'b', 'c']);
});

test('A10 mostDiff 取 rating 最大那一项（并列取靠前者），并给出其 constant', async () => {
  const { rankRows, mostDiffOf } = await rank();
  assert.deepEqual(mostDiffOf(song('e', [D('AT', 16, 16.9), D('IN', 16, 16.1)])), { level: 'AT', rating: 16, constant: 16.9 });
  assert.deepEqual(mostDiffOf(song('f', [D('IN', 16, 16.1), D('AT', 16, 16.9)])), { level: 'IN', rating: 16, constant: 16.1 });
  const rows = rankRows(SET1_SONGS, SET1_RATINGS, { minCount: 1 });
  const c = rows.find(r => r.song.id === 'c');
  assert.equal(c.mostDiff.level, 'AT');
  assert.equal(c.mostDiff.constant, 16.4);
  // 规格里 2.3 用 maxDiff、5.1 用 mostDiff：两个字段必须指向同一份数据
  assert.deepEqual(c.maxDiff, c.mostDiff);
});

test('A11 ratings 里 song_id 不在曲库中的行被忽略，不抛异常', async () => {
  const { rankRows } = await rank();
  const rows = rankRows(SET1_SONGS, SET1_RATINGS, { minCount: 1 });
  assert.ok(!ids(rows).includes('nope'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rankRows([], [], {}), []);
  assert.deepEqual(rankRows(null, null, null), []);
});

test('A12 排序稳定：同一输入连续两次调用，song_id 序列完全一致', async () => {
  const { rankRows } = await rank();
  const a = ids(rankRows(SET1_SONGS, SET1_RATINGS, { sort: 'avg', dir: 'desc', minCount: 1 }));
  const b = ids(rankRows(SET1_SONGS, SET1_RATINGS, { sort: 'avg', dir: 'desc', minCount: 1 }));
  assert.deepEqual(a, b);
  // 三种维度都必须是确定性顺序
  for (const sort of ['avg', 'count', 'level']) {
    for (const dir of ['asc', 'desc']) {
      const x = ids(rankRows(SET1_SONGS, SET1_RATINGS, { sort: sort, dir: dir, minCount: 1 }));
      const y = ids(rankRows(SET1_SONGS, SET1_RATINGS, { sort: sort, dir: dir, minCount: 1 }));
      assert.deepEqual(x, y, sort + '/' + dir);
    }
  }
});

test('A13（附加）非法/缺字段入参不抛异常，默认值可用', async () => {
  const { rankRows } = await rank();
  assert.deepEqual(ids(rankRows(SET1_SONGS, SET1_RATINGS, {})).sort(), ['a', 'b', 'c']);   // 默认 avg/desc/min1/all
  assert.deepEqual(ids(rankRows(SET1_SONGS, SET1_RATINGS, { sort: 'nope', dir: 'x', minCount: 0, difficulty: 'HUH' })).sort(),
    ['a', 'b', 'c']);
  assert.equal(rankRows(SET1_SONGS, [{ song_id: 'a', score: 'bad' }], {}).length, 1);      // 非法分数按 0 计
  assert.equal(rankRows(SET1_SONGS, [{ song_id: 'a', score: 'bad' }], {})[0].avg, 0);
});
