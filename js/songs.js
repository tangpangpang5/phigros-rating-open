/* =========================================================
 * js/songs.js —— 曲库：加载 songs.json、筛选、排序、封面
 * ========================================================= */

let SONGS = [];

const COVER_PALETTE = [
  ['#2b1b3d', '#e74c8b'], ['#0d1b3e', '#b34bff'], ['#00151f', '#00d4d4'],
  ['#1a0b2e', '#7b5cff'], ['#30030a', '#ff4050'], ['#1a0a00', '#ff8a00'],
  ['#0a1a2e', '#6fe0ff'], ['#1a0030', '#ff4fd8'], ['#002a1a', '#00e08a'],
  ['#1a1433', '#a892ff'], ['#2a001a', '#ff5a8a'], ['#00331a', '#00ff95'],
  ['#33000a', '#ff2e6e'], ['#001b2e', '#00c8ff'], ['#0a2a1a', '#00e0a0'],
  ['#1a0026', '#c86bff'], ['#2a0a00', '#ff7030'], ['#0d0d2e', '#5a5aff']
];

/** 缺图占位（灰底 NO ART） */
export const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">' +
  '<rect width="300" height="300" fill="#c9c9cf"/>' +
  '<text x="150" y="158" font-size="20" text-anchor="middle" fill="#6b6b72" font-family="sans-serif">NO ART</text></svg>');

/** 每种排序的默认方向 */
export const SORT_DIR_DEFAULT = { new: 'desc', rating: 'desc', ratingCount: 'desc', level: 'desc', name: 'asc' };

export async function loadSongs() {
  /* 注意：songs.json 不随本仓库分发（曲目数据整理自萌娘百科，不属本项目版权）。
     缺文件时给一句人话，不要让页面卡在「正在载入曲库」。 */
  let res;
  try {
    res = await fetch('songs.json');
  } catch (e) {
    throw new Error('读不到 songs.json（' + (e && e.message) + '）');
  }
  if (res.status === 404) {
    throw new Error('没有 songs.json —— 本仓库不含曲目数据，请按 README 的「曲目数据」一节自备一份');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  SONGS = await res.json();
  SONGS.forEach((s, i) => { if (!s.cover) s.cover = COVER_PALETTE[i % COVER_PALETTE.length]; });
  return SONGS;
}

export function getSongs() { return SONGS; }
export function getSong(id) { return SONGS.find(s => s.id === id); }
export function maxLevel(song) { return Math.max.apply(null, song.difficulties.map(d => d.rating)); }

/** 曲绘图片：covers/<id>.jpg，懒加载 + 失败占位 */
export function coverImg(song) {
  return '<img class="cover-img" loading="lazy" src="covers/' + song.id + '.jpg" alt="" ' +
    'onerror="this.onerror=null;this.src=\'' + PLACEHOLDER + '\'">';
}

/** 筛选 + 排序（state: { query, pack, difficulty, sort, dir }） */
export function filteredSongs(state, helpers) {
  const { avgScore, ratingCount } = helpers;
  let list = SONGS.slice();
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      (s.charter || '').toLowerCase().includes(q) ||
      s.chapter.toLowerCase().includes(q));
  }
  if (state.pack !== 'all') list = list.filter(s => s.chapter === state.pack);
  if (state.difficulty !== 'all') {
    list = list.filter(s => s.difficulties.some(d => d.level === state.difficulty));
  }
  const d = state.dir === 'asc' ? 1 : -1;
  switch (state.sort) {
    case 'name':
      list.sort((a, b) => d * String(a.title).localeCompare(String(b.title), 'zh'));
      break;
    case 'rating':
      list.sort((a, b) => d * (avgScore(a.id) - avgScore(b.id)));
      break;
    case 'ratingCount':
      list.sort((a, b) => d * (ratingCount(a.id) - ratingCount(b.id)));
      break;
    case 'level':
      list.sort((a, b) => d * (maxLevel(a) - maxLevel(b)));
      break;
    default: // new：新曲优先，不随升降序反转
      list.sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0));
  }
  return list;
}

/** 按大类分组的曲包下拉选项 */
export function buildPackOptions(escapeHtml) {
  const order = ['主线章节', '支线章节', '联动精选', '外传章节', '单曲精选'];
  const groups = {};
  SONGS.forEach(s => {
    if (!groups[s.category]) groups[s.category] = [];
    if (!groups[s.category].includes(s.chapter)) groups[s.category].push(s.chapter);
  });
  return order.map(c => {
    if (!groups[c]) return '';
    return '<optgroup label="' + escapeHtml(c) + '">' +
      groups[c].map(ch => '<option value="' + escapeHtml(ch) + '">' + escapeHtml(ch) + '</option>').join('') +
      '</optgroup>';
  }).join('');
}
