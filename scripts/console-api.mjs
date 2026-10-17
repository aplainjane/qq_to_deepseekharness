import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const port = cfg.consolePort || 3100;
const token = String(cfg.consoleToken || '').trim();
const action = process.argv[2] || 'status';
const path = action === 'dsh-restart' ? '/api/dsh/restart'
  : action === 'restart' ? '/api/restart'
  : action === 'digest' ? '/api/socialV2/daily-digest'
  : action === 'digest-run' ? '/api/socialV2/daily-digest/run'
  : action === 'digest-preview' ? '/api/socialV2/daily-digest/preview'
  : action === 'sources' ? '/api/socialV2/source-library'
  : action === 'sources-explore' ? '/api/socialV2/source-library/explore'
  : action === 'sources-maintain' ? '/api/socialV2/source-library/maintain'
  : action === 'sources-preview-explore' ? '/api/socialV2/source-library/preview?kind=explore'
  : action === 'sources-preview-maintain' ? '/api/socialV2/source-library/preview?kind=maintain'
  : '/api/status';
const method = (action === 'dsh-restart' || action === 'restart' || action === 'digest-run'
  || action === 'sources-explore' || action === 'sources-maintain') ? 'POST' : 'GET';
(async () => {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`http://127.0.0.1:${port}${path}${sep}token=${encodeURIComponent(token)}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined
    });
    const txt = await res.text();
    // 预览类：直接打印提示词正文，便于核对
    if (action.startsWith('digest-preview') || action.startsWith('sources-preview')) {
      try {
        const j = JSON.parse(txt);
        console.log(`HTTP ${res.status} ${path}`);
        console.log(j.prompt ?? txt.slice(0, 1500));
        return;
      } catch { /* 落到默认输出 */ }
    }
    // sources 状态是嵌套 JSON，压平一点便于阅读
    if (action === 'sources' && res.ok) {
      try {
        const s = JSON.parse(txt).status;
        console.log(`HTTP ${res.status} ${path}`);
        console.log(`启用：${s.enabled}  文档：${s.path}`);
        console.log(`来源：${s.live} 启用 / ${s.retired} 停用（上限 ${s.maxSources}，单分类 ${s.maxPerCategory}）`);
        console.log(`探索：每 ${s.exploreEveryDays} 天 ${s.explorePerRun} 条，上次 ${s.lastExploreDate || '—'}（共 ${s.exploreRuns} 次）`);
        console.log(`维护：每 ${s.maintainEveryDays} 天，上次 ${s.lastMaintainDate || '—'}（共 ${s.maintainRuns} 次）`);
        console.log(`该跑了吗：${JSON.stringify(s.overdue)}`);
        for (const c of s.categories) console.log(`  · ${c.name}: ${c.live}${c.retired ? ` (+${c.retired} 停用)` : ''}`);
        return;
      } catch { /* 落到默认输出 */ }
    }
    console.log(`HTTP ${res.status} ${path}\n${txt.slice(0, 1500)}`);
  } catch (e) {
    console.log(`ERR ${path}: ${e.message}`);
  }
})();
