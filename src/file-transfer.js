// Owner-private file transfer. No arbitrary URL/path downloads and no group access.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeFetchBuffer } from './safe-fetch.js';
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export function assertFileOwner(cfg, key, agentToken) {
  const owners = [].concat(cfg.ownerQQ || []).map(String);
  if (agentToken !== undefined || cfg.dsh?.ownerTools !== true || !owners.some(q => key === `private:${q}`)) throw new Error('文件传输仅限管理员私聊，拒绝群聊或会话令牌调用');
  if ((cfg.deny?.private || []).map(String).includes(key.split(':')[1])) throw new Error('管理员在拒绝名单中');
}
export function safeFileName(name) {
  const result = path.basename(String(name || 'file').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 150);
  return !result || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(result) ? 'file.bin' : result;
}
export function resolveSendFile(workspace, input) {
  if (!workspace || !input || /^(https?:|file:)/i.test(input)) throw new Error('只能发送管理员工作区内的本地文件');
  const root = fs.realpathSync(workspace);
  const resolved = fs.realpathSync(path.resolve(root, input));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('文件超出管理员工作区');
  if (rel.split(path.sep).some(s => /^(\.git|\.dsh|\.ssh|state|node_modules)$/i.test(s)) || /^(config(?:\..*)?\.json|\.env.*|.*\.(?:pem|key|pfx|p12))$/i.test(path.basename(resolved))) throw new Error('禁止发送配置、凭据或内部状态文件');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('仅支持不超过 20MB 的普通文件');
  return resolved;
}
export async function fileOnebot(cfg, action, params) {
  const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const response = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) }, body: JSON.stringify(params), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`);
  const body = await response.json();
  if (body.status === 'failed' || (body.retcode !== undefined && body.retcode !== 0)) throw new Error(`OneBot ${action} 失败（${body.retcode}）`);
  return body.data;
}
export async function sendOwnerFile(cfg, key, input, name) {
  assertFileOwner(cfg, key);
  const file = resolveSendFile(cfg.dsh?.ownerWorkspace, input);
  return fileOnebot(cfg, 'upload_private_file', { user_id: Number(key.split(':')[1]), file, name: safeFileName(name || path.basename(file)) });
}
export async function receiveOwnerFile(cfg, key, file, { call = fileOnebot, download = safeFetchBuffer } = {}) {
  assertFileOwner(cfg, key);
  if (!file?.id && !file?.file_id) throw new Error('消息没有文件 ID');
  if (Number(file.size) > MAX_FILE_BYTES) throw new Error('文件超过 20MB');
  // URL must come from the gateway for a file event, never from model/user input.
  const result = await call(cfg, 'get_private_file_url', { user_id: Number(key.split(':')[1]), file_id: String(file.id || file.file_id), file_hash: file.file_hash || file.hash });
  const url = typeof result === 'string' ? result : result?.url;
  if (!url) throw new Error('网关未返回文件下载地址');
  const downloaded = await download(url, MAX_FILE_BYTES, { requireImage: false });
  const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FILE_BYTES) throw new Error('无效文件或文件过大');
  const root = fs.realpathSync(cfg.dsh.ownerWorkspace);
  const inbox = path.join(root, 'QQ收件箱');
  fs.mkdirSync(inbox, { recursive: true });
  if (fs.realpathSync(inbox) !== inbox) throw new Error('收件箱不能是符号链接');
  const localPath = path.join(inbox, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}-${safeFileName(file.name)}`);
  fs.writeFileSync(localPath, buffer, { flag: 'wx' });
  return { localPath, name: safeFileName(file.name), size: buffer.length };
}
