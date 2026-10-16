// 早报「信息源库」：一个可增长的、分类的信息获取来源知识库。
//
// 职责：
// - 单个 Markdown 文档的解析 / 渲染 / 读写（人类可读可编辑，同时机器可解析）
// - 分类（= 探索路径）组织结构，每个分类一张固定列的表
// - 硬上限控制（总来源数 / 单分类数），避免无限增长
// - 生成三种提示词：早报引用来源 / 探索新来源 / 定期维护（含大企业与独角兽刷新）
// - 调度判定：是否到了该探索 / 该维护的日子
//
// 设计取舍：
// - 用「一个 Markdown 文档」而不是 JSON+MD 双份，避免两份数据不同步；
//   调度元信息（上次探索日等）以 HTML 注释里的 JSON 形式存在文档头部，仍然只有一份文件。
// - 桥接只负责解析、调度、注入提示词；真正的探索与淘汰判断交给 AI（它能读网页、能判断质量）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 来源状态：active=常用；watch=观察（可用但产出不稳定）；retired=已停用（保留记录，采集时跳过）
export const SOURCE_STATUS = Object.freeze({
  ACTIVE: 'active',
  WATCH: 'watch',
  RETIRED: 'retired'
});

// 表格列顺序固定，便于解析；渲染时始终按此顺序输出。
export const SOURCE_COLUMNS = Object.freeze(['来源', '网址', '用途', '状态', '加入日', '上次验证', '命中', '备注']);

export const META_MARKER = 'source-library-meta';
export const LOG_SECTION = '探索日志';

// 默认分类 = 默认探索路径
export const DEFAULT_CATEGORIES = Object.freeze([
  '论文与预印本',
  '科研机构与实验室',
  '科技新闻聚合',
  '公司与组织（大企业 / 独角兽）',
  '中文科技圈',
  '社区与讨论'
]);

function todayStr(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localDateStr(ts = Date.now()) {
  return todayStr(ts);
}

function nowIso() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── URL 规范化与去重键 ────────────────────────────────────────────────────────

// 去重键：主机名小写 + 路径（去尾斜杠、去常见追踪参数）。忽略协议与 query 噪声。
export function urlKey(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let p = u.pathname.replace(/\/+$/, '');
    // 常见追踪参数直接丢掉，不影响去重
    const params = [...u.searchParams.keys()].filter((k) => !/^(utm_|ref|source|fbclid|gclid)/i.test(k));
    const q = params.length ? '?' + params.sort().map((k) => `${k}=${u.searchParams.get(k)}`).join('&') : '';
    return (host + p + q).toLowerCase();
  } catch {
    // 不是合法 URL 时退化为原文小写去空白
    return s.toLowerCase().replace(/\s+/g, '');
  }
}

function cell(v) {
  // 单元格内容不能含换行；竖线需要转义，否则会破坏表格结构
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function uncell(v) {
  return String(v ?? '').replace(/\\\|/g, '|').trim();
}

// 按未转义的竖线切分表格行。不能用 naive split('|')：单元格内容里的 \| 会被误当成列分隔符，
// 导致后续所有列的索引错位（表现为「命中」读成别的列）。
export function splitTableRow(line) {
  const s = String(line ?? '').trim();
  const inner = s.startsWith('|') ? s.slice(1) : s;
  const body = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  const cells = [];
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      buf += '\\|';   // 转义的竖线：原样保留，交给 uncell 还原
      i++;
      continue;
    }
    if (ch === '|') { cells.push(buf); buf = ''; continue; }
    buf += ch;
  }
  cells.push(buf);
  return cells.map((c) => uncell(c));
}

export function normalizeSource(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const status = Object.values(SOURCE_STATUS).includes(s.status) ? s.status : SOURCE_STATUS.ACTIVE;
  return {
    name: String(s.name ?? '').trim(),
    url: String(s.url ?? '').trim(),
    purpose: String(s.purpose ?? '').trim(),
    status,
    addedAt: String(s.addedAt ?? '').trim() || todayStr(),
    verifiedAt: String(s.verifiedAt ?? '').trim(),
    hits: Math.max(0, Number(s.hits) || 0),
    note: String(s.note ?? '').trim()
  };
}

export function emptyLibrary() {
  return {
    meta: {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastExploreDate: '',
      lastMaintainDate: '',
      exploreRuns: 0,
      maintainRuns: 0
    },
    categories: DEFAULT_CATEGORIES.map((name) => ({ name, sources: [] })),
    log: []
  };
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

export function parseSourceLibrary(text) {
  const lib = emptyLibrary();
  lib.categories = [];
  lib.log = [];

  const lines = String(text ?? '').split(/\r?\n/);
  let inMeta = false;
  let metaBuf = [];
  let current = null;      // 当前分类
  let inLogSection = false;
  let headerCols = null;   // 当前表的列名映射

  const flushCategory = () => {
    if (current && !lib.categories.some((c) => c.name === current.name)) lib.categories.push(current);
    current = null;
    headerCols = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    // 1) 元信息块：HTML 注释里包 JSON，缺失/损坏都不影响其余内容
    if (!inMeta && line.startsWith(`<!-- ${META_MARKER}`)) {
      inMeta = true;
      metaBuf = [];
      continue;
    }
    if (inMeta) {
      if (line.includes('-->')) {
        const tail = line.slice(0, line.indexOf('-->'));
        if (tail.trim()) metaBuf.push(tail);
        inMeta = false;
        try {
          const parsed = JSON.parse(metaBuf.join('\n'));
          if (parsed && typeof parsed === 'object') lib.meta = { ...lib.meta, ...parsed };
        } catch {
          // 元信息坏了就用默认值，不抛错
        }
      } else {
        metaBuf.push(raw);
      }
      continue;
    }

    // 2) 分类标题
    if (/^##\s+/.test(line)) {
      const name = line.replace(/^##\s+/, '').trim();
      flushCategory();
      if (name === LOG_SECTION) {
        inLogSection = true;
        continue;
      }
      inLogSection = false;
      current = { name, sources: [] };
      continue;
    }

    // 3) 一级标题（文档名）忽略
    if (/^#\s+/.test(line)) continue;

    // 4) 探索日志：列表项
    if (inLogSection) {
      const m = /^[-*]\s+(.*)$/.exec(line);
      if (m && m[1].trim()) lib.log.push(m[1].trim());
      continue;
    }

    // 5) 表格：先读表头，再读数据行
    if (line.startsWith('|')) {
      const cells = splitTableRow(line);
      if (!headerCols) {
        // 表头行；若全为分隔符则说明没表头，跳过
        if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
        headerCols = cells;
        continue;
      }
      // 分隔行
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
      if (!current) continue;
      const get = (label) => {
        const i = headerCols.indexOf(label);
        return i >= 0 ? cells[i] ?? '' : '';
      };
      const src = normalizeSource({
        name: get('来源'),
        url: get('网址'),
        purpose: get('用途'),
        status: get('状态'),
        addedAt: get('加入日'),
        verifiedAt: get('上次验证'),
        hits: get('命中'),
        note: get('备注')
      });
      if (src.name || src.url) current.sources.push(src);
      continue;
    }
  }
  flushCategory();

  // 保证默认分类齐全，且顺序稳定（文档里出现的顺序优先）
  for (const name of DEFAULT_CATEGORIES) {
    if (!lib.categories.some((c) => c.name === name)) lib.categories.push({ name, sources: [] });
  }
  return lib;
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

export function renderSourceLibrary(lib) {
  const out = [];
  out.push('# 早报信息源库');
  out.push('');
  out.push('> 本文件由 QQ 桥接的「每日早报 · 信息源探索」自动维护，可以直接手工编辑。');
  out.push('> 结构：每个分类（= 一条探索路径）一个 `##` 小节，小节内一张表格；表格列顺序固定，不要改动。');
  out.push(`> \`状态\`：${SOURCE_STATUS.ACTIVE}=常用 / ${SOURCE_STATUS.WATCH}=观察 / ${SOURCE_STATUS.RETIRED}=已停用（保留记录，采集时跳过）。`);
  out.push('> `命中`：早报实际从该来源取到内容的次数。`备注` 里写“需登录”的来源，采集时应跳过。');
  out.push('');
  out.push(`<!-- ${META_MARKER}`);
  out.push(JSON.stringify(lib.meta, null, 2));
  out.push('-->');
  out.push('');

  for (const cat of lib.categories) {
    out.push(`## ${cat.name}`);
    out.push('');
    out.push(`| ${SOURCE_COLUMNS.join(' | ')} |`);
    out.push(`| ${SOURCE_COLUMNS.map(() => '---').join(' | ')} |`);
    for (const s of cat.sources) {
      out.push(`| ${cell(s.name)} | ${cell(s.url)} | ${cell(s.purpose)} | ${cell(s.status)} | ${cell(s.addedAt)} | ${cell(s.verifiedAt)} | ${cell(s.hits)} | ${cell(s.note)} |`);
    }
    out.push('');
  }

  out.push(`## ${LOG_SECTION}`);
  out.push('');
  out.push('> 只保留最近 40 条，用于说明“从哪条线索发现了哪个新来源”。');
  out.push('');
  for (const entry of lib.log) out.push(`- ${cell(entry)}`);
  out.push('');
  return out.join('\n');
}

// ── 读写 ─────────────────────────────────────────────────────────────────────

export function loadSourceLibrary(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return parseSourceLibrary(text);
  } catch {
    return null;
  }
}

export function saveSourceLibrary(file, lib) {
  lib.meta.updatedAt = nowIso();
  lib.log = lib.log.slice(-40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, renderSourceLibrary(lib), { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

// 文档不存在时写入一份起步来源，保证第一次早报就有东西可用。
export function seedSourceLibrary(lib, today = todayStr()) {
  const add = (catName, name, url, purpose, note = '', status = SOURCE_STATUS.ACTIVE) => {
    const cat = lib.categories.find((c) => c.name === catName) || { name: catName, sources: [] };
    if (!lib.categories.includes(cat)) lib.categories.push(cat);
    if (cat.sources.some((s) => urlKey(s.url) === urlKey(url))) return;
    cat.sources.push(normalizeSource({ name, url, purpose, status, addedAt: today, verifiedAt: '', hits: 0, note }));
  };

  add('论文与预印本', 'arXiv cs.AI 最新', 'https://arxiv.org/list/cs.AI/recent', '论文列表', '一手来源');
  add('论文与预印本', 'arXiv cs.CL 最新', 'https://arxiv.org/list/cs.CL/recent', '论文列表', '一手来源');
  add('论文与预印本', 'arXiv cs.LG 最新', 'https://arxiv.org/list/cs.LG/recent', '论文列表', '一手来源');
  add('论文与预印本', 'Hugging Face Daily Papers', 'https://huggingface.co/papers', '社区高亮论文', '可选补充');

  add('科研机构与实验室', 'Google DeepMind Blog', 'https://deepmind.google/discover/blog/', '官方研究发布', '一手来源');
  add('科研机构与实验室', 'Anthropic News', 'https://www.anthropic.com/news', '官方公告', '一手来源');
  add('科研机构与实验室', 'Meta AI Research Blog', 'https://research.meta.ai/blog', '官方研究发布', '一手来源');
  add('科研机构与实验室', 'Microsoft Research Blog', 'https://www.microsoft.com/en-us/research/blog/', '官方研究发布', '一手来源');

  add('科技新闻聚合', 'Hacker News 首页', 'https://news.ycombinator.com/', '技术圈热点', '社区投票，噪声需过滤');
  add('科技新闻聚合', 'Techmeme 首页', 'https://www.techmeme.com/', '科技新闻聚合', '带原文链接，适合追一手来源');
  add('科技新闻聚合', 'Ars Technica', 'https://arstechnica.com/', '科技深度报道', '');
  add('科技新闻聚合', 'The Verge', 'https://www.theverge.com/tech', '科技新闻', '');

  add('公司与组织（大企业 / 独角兽）', 'OpenAI News', 'https://openai.com/news/', '官方动态', '注意：官网有人机验证，可能打不开时改用聚合站');
  add('公司与组织（大企业 / 独角兽）', 'NVIDIA Newsroom', 'https://nvidianews.nvidia.com/', '官方动态', '');
  add('公司与组织（大企业 / 独角兽）', 'Apple Newsroom', 'https://www.apple.com/newsroom/', '官方动态', '');
  add('公司与组织（大企业 / 独角兽）', 'Mistral AI', 'https://mistral.ai/news', '独角兽官方动态', '欧洲头部独角兽');

  add('中文科技圈', '机器之心', 'https://www.jiqizhixin.com/', '中文 AI 报道', '');
  add('中文科技圈', '量子位', 'https://www.qbitai.com/', '中文 AI 报道', '');

  add('社区与讨论', 'LMArena 排行榜', 'https://lmarena.ai/leaderboard', '模型评测排名', '看模型口碑与实际排名');
  add('社区与讨论', 'r/MachineLearning', 'https://www.reddit.com/r/MachineLearning/', '研究社区讨论', '');

  return lib;
}

// ── 统计与上限 ───────────────────────────────────────────────────────────────

export function libraryStats(lib) {
  const cats = lib.categories.map((c) => {
    const live = c.sources.filter((s) => s.status !== SOURCE_STATUS.RETIRED);
    return { name: c.name, total: c.sources.length, live: live.length, retired: c.sources.length - live.length };
  });
  const total = lib.categories.reduce((n, c) => n + c.sources.length, 0);
  const live = lib.categories.reduce((n, c) => n + c.sources.filter((s) => s.status !== SOURCE_STATUS.RETIRED).length, 0);
  return { total, live, retired: total - live, categories: cats };
}

// 返回超出上限的说明（空数组 = 都在限额内）。桥接据此在提示词里要求 AI 淘汰。
export function capViolations(lib, { maxSources, maxPerCategory } = {}) {
  const out = [];
  const max = Number(maxSources) || 0;
  const perCat = Number(maxPerCategory) || 0;
  if (max > 0 && libraryStats(lib).live > max) {
    out.push(`启用的来源共 ${libraryStats(lib).live} 条，超过上限 ${max} 条，需要先淘汰一些再新增`);
  }
  if (perCat > 0) {
    for (const c of lib.categories) {
      const live = c.sources.filter((s) => s.status !== SOURCE_STATUS.RETIRED).length;
      if (live > perCat) out.push(`分类「${c.name}」启用了 ${live} 条，超过单分类上限 ${perCat} 条，需要精简`);
    }
  }
  return out;
}

// ── 提示词片段 ───────────────────────────────────────────────────────────────

// 给早报用的来源清单：只列启用中的来源，按分类分组，控制长度。
export function buildDigestSourcesText(lib, { maxPerCategory = 8 } = {}) {
  const out = [];
  for (const cat of lib.categories) {
    const live = cat.sources
      .filter((s) => s.status !== SOURCE_STATUS.RETIRED)
      .slice(0, Math.max(1, maxPerCategory));
    if (!live.length) continue;
    out.push(`【${cat.name}】`);
    for (const s of live) {
      const bits = [s.name, s.url ? `(${s.url})` : '', s.purpose ? `— ${s.purpose}` : '', s.note ? `[${s.note}]` : ''];
      out.push('- ' + bits.filter(Boolean).join(' '));
    }
  }
  return out.join('\n');
}

// 「公司与组织」分类单独取出来，供“大企业/独角兽动态”使用。
export function companyWatchlist(lib, { max = 12 } = {}) {
  const cat = lib.categories.find((c) => c.name.startsWith('公司与组织'));
  if (!cat) return [];
  return cat.sources.filter((s) => s.status !== SOURCE_STATUS.RETIRED).slice(0, max);
}

function capRulesText(cfg) {
  const rules = [
    `总来源数上限 ${cfg.maxSources} 条（只算启用的；超过就必须先淘汰再新增）`,
    `单分类上限 ${cfg.maxPerCategory} 条`,
    `每次探索只新增 ${cfg.explorePerRun} 条新来源，宁缺毋滥`
  ];
  return rules.join('；') + '。';
}

export function buildExplorePrompt({ docPath, lib, cfg, today = todayStr() }) {
  const stats = libraryStats(lib);
  const existing = stats.total
    ? lib.categories.map((c) => `- ${c.name}：${c.sources.filter((s) => s.status !== SOURCE_STATUS.RETIRED).length} 条`).join('\n')
    : '（空）';
  const violations = capViolations(lib, cfg);
  const lines = [
    `【信息源探索】${today}，请给早报的信息源库探索 ${cfg.explorePerRun} 个新来源。`,
    `信息源库文档：${docPath}`,
    '',
    '当前库存：',
    existing,
    `合计启用 ${stats.live} 条（停用 ${stats.retired} 条）。`,
    '',
    `本次任务：找 ${cfg.explorePerRun} 个**确实可用**的新来源并写入信息源库，要求：`,
    '1. 先读信息源库文档了解现有来源与分类，别重复添加已有的（按域名去重）。',
    '2. 用浏览器工具实际打开候选页面确认能访问、正文可读，再决定收录；打不开或要登录的直接放弃。',
    '3. 优先收录一手来源（论文库、官方博客、官方新闻室）和高质量聚合站；避免内容农场、纯转载站。',
    '4. 新来源要归入合适的分类。若确实是全新方向，可以新开一个分类（分类名要简短）。',
    '5. 优先尝试“从已有来源顺藤摸瓜”：看现有聚合站/社区里引用了哪些你没收录的原始站点，这也是最自然的探索路径。',
    cfg.useInDigest
      ? '6. 收录标准：站上确实有“最近 24~48 小时内的新内容”可用于早报。'
      : '6. 收录标准：站上确实有可定期复看的新内容。',
    '',
    `约束：${capRulesText(cfg)}`,
  ];
  if (violations.length) {
    lines.push('', '⚠ 当前已超出限额，必须先淘汰再新增（把低产/失效/需登录的来源改成 retired 或删除）：');
    for (const v of violations) lines.push(`- ${v}`);
  }
  lines.push(
    '',
    '写回要求：',
    `- 用编辑/写入文件工具更新 ${docPath}，**保持文档结构**（每个分类一个 ## 小节 + 一张表格，列顺序固定：${SOURCE_COLUMNS.join(' / ')}）。`,
    '- 新增行的「加入日」写今天，「上次验证」写今天，「命中」从 0 开始，「备注」一句话说明来源特点（需登录的一定写明）。',
    '- 在 `## 探索日志` 追加一条记录，写清“从哪条线索发现了它”，让探索路径可追溯。',
    '- 如果这次一个合格的新来源都没找到，不要硬凑：在探索日志里写一行说明卡在哪里，然后结束。',
    `- 日志只保留最近 40 条，超出就删最旧的，避免文档无限膨胀。`,
    '',
    `完成后给管理员一句话汇报（新增了什么来源、归到哪个分类），直接输出正文即可（桥接会自动转发，不要调用任何发送工具）。`
  );
  return lines.join('\n');
}

export function buildMaintainPrompt({ docPath, lib, cfg, today = todayStr() }) {
  const stats = libraryStats(lib);
  const violations = capViolations(lib, cfg);
  const companies = companyWatchlist(lib, { max: 15 });
  const lines = [
    `【信息源维护】${today}，请给早报的信息源库做一次定期维护。`,
    `信息源库文档：${docPath}`,
    '',
    `当前库存：启用 ${stats.live} 条 / 停用 ${stats.retired} 条 / 合计 ${stats.total} 条。`,
    '',
    '维护内容：',
    '1. **可用性检查**：抽查各分类来源，把已经打不开、需要登录、内容长期不更新、或明显变成内容农场的来源标成 `retired`（保留记录，不采集）。',
    '2. **去重与归位**：同一站点被收录多次的只留一条；分类放错的移到正确的分类。',
    '3. **淘汰低产来源**：`命中` 长期为 0 或极低、且已加入较久的来源，标 `retired`；确实没价值的直接删掉。',
    '4. **修改时间戳**：这次实际验证过的来源，把「上次验证」更新为今天。',
    `5. **大企业与独角兽刷新**：更新「公司与组织（大企业 / 独角兽）」分类——补上最近值得关注的新公司，移除已不再活跃的。当前该分类有 ${companies.length} 条：`,
  ];
  for (const c of companies) lines.push(`   - ${c.name}${c.url ? ` (${c.url})` : ''}`);
  lines.push(
    '6. 顺手把这次维护中发现的好的新来源按“探索”标准收录进来（数量克制，1~2 条即可）。',
    '',
    `约束：${capRulesText(cfg)}`,
  );
  if (violations.length) {
    lines.push('', '⚠ 超出限额，本次维护必须收敛到限额以内：');
    for (const v of violations) lines.push(`- ${v}`);
  }
  lines.push(
    '',
    '写回要求：',
    `- 用编辑/写入文件工具更新 ${docPath}，**保持文档结构**（每个分类一个 ## 小节 + 一张表格，列顺序固定：${SOURCE_COLUMNS.join(' / ')}）。`,
    '- 维护动作（停用/删除/移动/新增）都要在 `## 探索日志` 里各记一行，说明理由。',
    '- 日志只保留最近 40 条，超出删最旧的。',
    '',
    '完成后给管理员一段简短汇报（停用了几条、新增了几条、公司清单有什么变化），直接输出正文即可（桥接会自动转发，不要调用任何发送工具）。'
  );
  return lines.join('\n');
}

// ── 调度判定 ─────────────────────────────────────────────────────────────────

function dateToNum(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? '').trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function daysSince(lastDateStr, today = todayStr()) {
  const a = dateToNum(lastDateStr);
  const b = dateToNum(today);
  if (a === null || b === null) return Infinity; // 没有记录 = 很久没做
  return Math.round((b - a) / 86400000);
}

export function shouldExplore(lib, cfg, today = todayStr()) {
  if (cfg.enabled !== true || cfg.exploreEnabled !== true) return false;
  return daysSince(lib?.meta?.lastExploreDate, today) >= Math.max(1, Number(cfg.exploreEveryDays) || 1);
}

export function shouldMaintain(lib, cfg, today = todayStr()) {
  if (cfg.enabled !== true || cfg.maintainEnabled !== true) return false;
  return daysSince(lib?.meta?.lastMaintainDate, today) >= Math.max(1, Number(cfg.maintainEveryDays) || 7);
}

// ── 默认路径 ─────────────────────────────────────────────────────────────────

export function resolveDocPath(cfg, ownerWorkspace) {
  const configured = String(cfg?.path ?? '').trim();
  if (configured) return path.resolve(configured);
  const base = String(ownerWorkspace ?? '').trim();
  if (base) return path.join(base, '早报信息源库.md');
  return path.resolve(process.cwd(), '早报信息源库.md');
}

// 确保文档存在（不存在则落一份起步来源），返回 { lib, created }
export function ensureSourceLibrary(file) {
  const existing = loadSourceLibrary(file);
  if (existing) return { lib: existing, created: false };
  const lib = seedSourceLibrary(emptyLibrary());
  saveSourceLibrary(file, lib);
  return { lib, created: true };
}
