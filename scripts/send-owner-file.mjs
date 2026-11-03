// Administrator local-tool entry, deliberately NOT exposed by the shared safe MCP.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const [filePath, ownerId, name] = process.argv.slice(2);
  if (!filePath) throw new Error('用法: node scripts/send-owner-file.mjs <文件路径> [管理员QQ] [显示文件名]');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const owners = [].concat(cfg.ownerQQ || []).map(String);
  const id = ownerId || (owners.length === 1 ? owners[0] : '');
  if (!owners.includes(id)) throw new Error('必须指定已配置的管理员QQ');
  const token = cfg.consoleToken || fs.readFileSync(path.join(root, 'state/console-token'), 'utf8').trim();
  if (!token) throw new Error('未配置控制台令牌');
  const res = await fetch(`http://127.0.0.1:${cfg.consolePort || 3100}/api/owner/send-file`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token }, body: JSON.stringify({ key: `private:${id}`, filePath, name }), signal: AbortSignal.timeout(65000) });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  console.log('文件已提交到QQ网关');
} catch (error) { console.error(error.message); process.exitCode = 1; }
