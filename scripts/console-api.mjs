import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const port = cfg.consolePort || 3100;
const token = String(cfg.consoleToken || '').trim();
const action = process.argv[2] || 'status';
const path = action === 'dsh-restart' ? '/api/dsh/restart'
  : action === 'restart' ? '/api/restart'
  : action === 'digest' ? '/api/socialV2/daily-digest'
  : action === 'digest-run' ? '/api/socialV2/daily-digest/run'
  : '/api/status';
const method = (action === 'dsh-restart' || action === 'restart' || action === 'digest-run') ? 'POST' : 'GET';
(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined
    });
    const txt = await res.text();
    console.log(`HTTP ${res.status} ${path}\n${txt.slice(0, 1500)}`);
  } catch (e) {
    console.log(`ERR ${path}: ${e.message}`);
  }
})();
