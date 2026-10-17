// 信息源库模块离线自测：解析 / 渲染 / 往返一致性 / 上限 / 调度判定 / 提示词。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SOURCE_STATUS,
  SOURCE_COLUMNS,
  emptyLibrary,
  seedSourceLibrary,
  parseSourceLibrary,
  renderSourceLibrary,
  saveSourceLibrary,
  loadSourceLibrary,
  ensureSourceLibrary,
  libraryStats,
  capViolations,
  buildDigestSourcesText,
  buildExplorePrompt,
  buildMaintainPrompt,
  shouldExplore,
  shouldMaintain,
  daysSince,
  urlKey,
  resolveDocPath,
  DEALS_CATEGORY,
  dealsWatchlist
} from '../src/source-library.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srclib-'));
const doc = path.join(tmp, '早报信息源库.md');

console.log('\n[1] 种子库与统计');
let lib = seedSourceLibrary(emptyLibrary(), '2026-10-16');
const st = libraryStats(lib);
check('种子来源 > 15 条', st.total > 15, `got ${st.total}`);
check('分类齐全', lib.categories.length >= 6, `got ${lib.categories.length}`);
check('公司与组织分类存在', lib.categories.some((c) => c.name.startsWith('公司与组织')));
check('羊毛与价格情报分类存在', lib.categories.some((c) => c.name === DEALS_CATEGORY));
const deals = dealsWatchlist(lib, { max: 20 });
check('羊毛分类有起步来源', deals.length >= 4, `got ${deals.length}`);
check('羊毛来源都指向可读页面', deals.every((s) => /^https?:\/\//.test(s.url)));
check('羊毛来源未混入其他分类', dealsWatchlist({ categories: [{ name: '论文与预印本', sources: [{ status: 'active', name: 'x', url: 'https://a.b' }] }] }).length === 0);

console.log('\n[2] 渲染 → 解析 往返一致');
saveSourceLibrary(doc, lib);
const reloaded = loadSourceLibrary(doc);
check('往返后总数一致', libraryStats(reloaded).total === st.total, `${libraryStats(reloaded).total} vs ${st.total}`);
check('往返后分类数一致', reloaded.categories.length === lib.categories.length);
const a = lib.categories.flatMap((c) => c.sources.map((s) => s.name + '|' + s.url)).sort();
const b = reloaded.categories.flatMap((c) => c.sources.map((s) => s.name + '|' + s.url)).sort();
check('往返后每条来源都保留', JSON.stringify(a) === JSON.stringify(b));

console.log('\n[3] 元信息持久化');
lib.meta.lastExploreDate = '2026-10-15';
lib.meta.exploreRuns = 3;
saveSourceLibrary(doc, lib);
const r3 = loadSourceLibrary(doc);
check('lastExploreDate 保留', r3.meta.lastExploreDate === '2026-10-15', r3.meta.lastExploreDate);
check('exploreRuns 保留', r3.meta.exploreRuns === 3, String(r3.meta.exploreRuns));

console.log('\n[4] 表格列顺序与转义');
check('列定义固定', SOURCE_COLUMNS.join(',') === '来源,网址,用途,状态,加入日,上次验证,命中,备注');
const libX = emptyLibrary();
libX.categories = [{ name: '论文与预印本', sources: [] }];
libX.categories[0].sources.push({
  name: '含|竖线|的站', url: 'https://ex.com/a', purpose: '多行\r\n用途', status: SOURCE_STATUS.WATCH,
  addedAt: '2026-10-16', verifiedAt: '', hits: 7, note: '备注|x'
});
const txtX = renderSourceLibrary(libX);
check('竖线被转义，表格不破行', txtX.includes('含\\|竖线\\|的站'));
const rX = parseSourceLibrary(txtX);
check('转义后可正确解析回名称', rX.categories.find((c) => c.name === '论文与预印本').sources[0].name === '含|竖线|的站');
check('多行用途被压成单行', !rX.categories.find((c) => c.name === '论文与预印本').sources[0].purpose.includes('\n'));
check('命中数保留', rX.categories.find((c) => c.name === '论文与预印本').sources[0].hits === 7);

console.log('\n[5] 去重键');
check('www 与协议无关', urlKey('https://www.Techmeme.com/') === urlKey('http://techmeme.com'));
check('尾斜杠无关', urlKey('https://a.com/x/') === urlKey('https://a.com/x'));
check('utm 参数忽略', urlKey('https://a.com/x?utm_source=q') === urlKey('https://a.com/x'));
check('不同路径不同键', urlKey('https://a.com/x') !== urlKey('https://a.com/y'));

console.log('\n[6] 手工编辑容错');
const messy = [
  '# 早报信息源库',
  '<!-- source-library-meta',
  '{ this is broken json ]',
  '-->',
  '## 论文与预印本',
  '',
  '| 来源 | 网址 | 用途 | 状态 | 加入日 | 上次验证 | 命中 | 备注 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 手写的站 | https://hand.example/ | 测试 | active | 2026-10-01 |  | 2 | 手工加的 |',
  '| 少列的站 | https://short.example/ |',
  '## 新分类',
  '| 来源 | 网址 |',
  '| --- | --- |',
  '| 只有两列 | https://two.example/ |',
  '## 探索日志',
  '- 从 Techmeme 顺藤摸到某官方博客'
].join('\n');
saveSourceLibrary(path.join(tmp, 'x.md'), emptyLibrary());
fs.writeFileSync(path.join(tmp, 'messy.md'), messy, 'utf8');
const rm = parseSourceLibrary(messy);
check('坏元信息不抛错，用默认', typeof rm.meta === 'object');
check('缺列的站仍收录（不崩）', rm.categories.some((c) => c.sources.some((s) => s.name === '少列的站')));
check('自定义新分类保留', rm.categories.some((c) => c.name === '新分类'));
check('只有两列表格也能读', rm.categories.find((c) => c.name === '新分类')?.sources[0]?.name === '只有两列');
check('探索日志读到', rm.log.length === 1 && rm.log[0].includes('顺藤摸瓜') === false && rm.log[0].includes('Techmeme'));

console.log('\n[7] 上限检查');
const libCap = emptyLibrary();
libCap.categories = [{ name: '论文与预印本', sources: [] }];
for (let i = 0; i < 5; i++) {
  libCap.categories[0].sources.push({ name: `s${i}`, url: `https://s${i}.com`, status: SOURCE_STATUS.ACTIVE, hits: 0 });
}
libCap.categories[0].sources.push({ name: 'ret', url: 'https://r.com', status: SOURCE_STATUS.RETIRED, hits: 0 });
check('停用不计入 live', libraryStats(libCap).live === 5 && libraryStats(libCap).retired === 1);
check('超单分类上限被报出', capViolations(libCap, { maxSources: 100, maxPerCategory: 3 }).length === 1);
check('超总数上限被报出', capViolations(libCap, { maxSources: 4, maxPerCategory: 100 }).length === 1);
check('限额内无告警', capViolations(libCap, { maxSources: 10, maxPerCategory: 10 }).length === 0);

console.log('\n[8] 调度判定');
const cfg = { enabled: true, exploreEnabled: true, maintainEnabled: true, exploreEveryDays: 1, maintainEveryDays: 7 };
const l2 = emptyLibrary();
l2.meta.lastExploreDate = '';
l2.meta.lastMaintainDate = '';
check('从未探索过 → 该探索', shouldExplore(l2, cfg, '2026-10-16') === true);
check('从未维护过 → 该维护', shouldMaintain(l2, cfg, '2026-10-16') === true);
l2.meta.lastExploreDate = '2026-10-16';
check('今天探索过 → 不再探索', shouldExplore(l2, cfg, '2026-10-16') === false);
l2.meta.lastExploreDate = '2026-10-15';
check('昨天探索过（间隔1天）→ 该探索', shouldExplore(l2, cfg, '2026-10-16') === true);
l2.meta.lastMaintainDate = '2026-10-10';
check('6 天前维护（间隔7天）→ 还不用', shouldMaintain(l2, cfg, '2026-10-16') === false);
l2.meta.lastMaintainDate = '2026-10-09';
check('7 天前维护 → 该维护', shouldMaintain(l2, cfg, '2026-10-16') === true);
check('开关关闭 → 不探索', shouldExplore(l2, { ...cfg, exploreEnabled: false }, '2026-10-16') === false);
check('总开关关闭 → 不维护', shouldMaintain(l2, { ...cfg, enabled: false }, '2026-10-16') === false);
check('exploreEveryDays=3 时昨天不用', shouldExplore({ meta: { lastExploreDate: '2026-10-15' } }, { ...cfg, exploreEveryDays: 3 }, '2026-10-16') === false);
check('跨月天数正确', daysSince('2026-09-30', '2026-10-01') === 1);
check('完全没有记录 → Infinity', daysSince('', '2026-10-16') === Infinity);

console.log('\n[9] 提示词内容');
const fullCfg = {
  enabled: true, exploreEnabled: true, maintainEnabled: true, exploreEveryDays: 1, maintainEveryDays: 7,
  explorePerRun: 2, maxSources: 40, maxPerCategory: 8, useInDigest: true
};
const ex = buildExplorePrompt({ docPath: doc, lib: reloaded, cfg: fullCfg, today: '2026-10-16' });
check('探索提示含文档路径', ex.includes(doc));
check('探索提示含条数', ex.includes('2 个'));
check('探索提示含上限', ex.includes('40') && ex.includes('8'));
check('探索提示含列顺序', ex.includes('来源 / 网址 / 用途 / 状态'));
check('探索提示要求先打开验证', ex.includes('浏览器') && ex.includes('确认能访问'));
check('探索提示说明日志上限', ex.includes('40 条'));
const mt = buildMaintainPrompt({ docPath: doc, lib: reloaded, cfg: fullCfg, today: '2026-10-16' });
check('维护提示含大企业刷新', mt.includes('大企业与独角兽'));
check('维护提示列出公司', mt.includes('OpenAI News') || mt.includes('NVIDIA'));
check('维护提示含停用要求', mt.includes('retired'));
check('维护提示含省钱渠道刷新', mt.includes('省钱渠道刷新'));
check('维护提示列出羊毛来源', mt.includes(DEALS_CATEGORY) && mt.includes('OpenRouter'));
const digestSrc = buildDigestSourcesText(reloaded, { maxPerCategory: 3 });
check('早报来源文本含分类标题', digestSrc.includes('【论文与预印本】'));
check('早报来源文本含网址', digestSrc.includes('http'));
check('早报来源文本含羊毛分类', digestSrc.includes(`【${DEALS_CATEGORY}】`));

console.log('\n[9b] 羊毛情报板块（早报③）');
const bridgeSrc = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
check('早报提示含③板块', /③\s*实用情报/.test(bridgeSrc));
check('③板块条数可配（maxDeals）', bridgeSrc.includes('maxDeals'));
check('③板块带开关（dealsSection）', bridgeSrc.includes('dealsSection'));
check('③板块要求给链接', /必须给出来源链接/.test(bridgeSrc));
check('③板块要求原样引用页面数字', /实际看到/.test(bridgeSrc));
check('③板块禁止编造优惠码', /不要编造优惠码/.test(bridgeSrc));
check('③板块禁止违反条款', /不要引导管理员违反任何服务的条款/.test(bridgeSrc));
check('③板块区分官方与第三方', /第三方转卖/.test(bridgeSrc));
check('③板块不许写过期活动', /已经结束的活动/.test(bridgeSrc));
check('③板块允许当天没有就留空', /宁缺毋滥/.test(bridgeSrc));
check('③板块列出的方向含额度重置', /额度重置/.test(bridgeSrc));
check('③板块列出的方向含学生优惠', /教育优惠/.test(bridgeSrc));
check('③板块随开关可关闭（不硬编码上限）', /maxDeals > 0/.test(bridgeSrc));

console.log('\n[10] 文档不存在时自动落地');
const fresh = path.join(tmp, 'sub', 'fresh.md');
const { lib: freshLib, created } = ensureSourceLibrary(fresh);
check('首次创建标记 true', created === true);
check('文件已写出', fs.existsSync(fresh));
check('内容非空', libraryStats(freshLib).total > 10);
const again = ensureSourceLibrary(fresh);
check('第二次不覆盖（created=false）', again.created === false);

console.log('\n[11] 路径解析');
check('配置了路径就用配置的', resolveDocPath({ path: doc }, '/ws') === path.resolve(doc));
check('没配置用工作区', resolveDocPath({}, 'F:\\ws').endsWith('早报信息源库.md'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
