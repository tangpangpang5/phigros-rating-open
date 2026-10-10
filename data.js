/* Phigros 打分站 · 本地种子数据（曲目数据已移至 songs.json）
 * 说明：账号系统已迁移到 Supabase Auth（邮箱 + 密码），
 *       这里不再有任何内置账号或密码，只保留「只读演示模式」用的展示数据。 */

/* 只读演示模式下的展示用户（不对应任何可登录账号） */
window.PHIGROS_SEED_PROFILES = [
  { id: 'u_demo', username: 'demo', nickname: '演示用户', avatar_color: '#6c5ce7', is_admin: false }
];

window.PHIGROS_SEED_RATINGS = [
  { id: 'r1', song_id: 'rrharil', user_id: 'u_demo', score: 10, created_at: 1700000001000, updated_at: 1700000001000 },
  { id: 'r2', song_id: 'igallta', user_id: 'u_demo', score: 10, created_at: 1700000002000, updated_at: 1700000002000 },
  { id: 'r3', song_id: 'spasmodic', user_id: 'u_demo', score: 9, created_at: 1700000003000, updated_at: 1700000003000 },
  { id: 'r4', song_id: 'cthugha', user_id: 'u_demo', score: 9, created_at: 1700000004000, updated_at: 1700000004000 },
  { id: 'r5', song_id: 'marenol', user_id: 'u_demo', score: 8, created_at: 1700000005000, updated_at: 1700000005000 },
  { id: 'r6', song_id: 'distortedfate', user_id: 'u_demo', score: 8, created_at: 1700000006000, updated_at: 1700000006000 }
];

window.PHIGROS_SEED_COMMENTS = [
  { id: 'c1', song_id: 'rrharil', user_id: 'u_demo', text: 'Rrhar\'il 的 AT 真的是人打的吗…… 17.6 摆在那，过不去也只能认了，谱子是真好。', created_at: 1700000010000 },
  { id: 'c2', song_id: 'igallta', user_id: 'u_demo', text: 'Igallta 的 AT 开头那段就够呛，打完一整根人都是麻的。', created_at: 1700000011000 },
  { id: 'c3', song_id: 'spasmodic', user_id: 'u_demo', text: '当年第一首 16 级，那时候哪见过这种谱，看了半天才敢打。', created_at: 1700000012000 },
  { id: 'c4', song_id: 'cthugha', user_id: 'u_demo', text: 'Muse Dash 联动过来的曲子，IN 的交互打着很过瘾。', created_at: 1700000013000 }
];
