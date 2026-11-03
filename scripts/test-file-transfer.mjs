import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertFileOwner, safeFileName, resolveSendFile, receiveOwnerFile } from '../src/file-transfer.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-file-test-'));
const cfg = { ownerQQ: [123], dsh: { ownerTools: true, ownerWorkspace: root } };
try {
  assertFileOwner(cfg, 'private:123');
  for (const key of ['group:123', 'private:456', 'private:123junk']) assert.throws(() => assertFileOwner(cfg, key));
  assert.throws(() => assertFileOwner(cfg, 'private:123', 'group-token'));
  assert.throws(() => assertFileOwner(cfg, 'private:123', ''));
  assert.throws(() => assertFileOwner({ ...cfg, deny: { private: [123] } }, 'private:123'));
  fs.writeFileSync(path.join(root, 'report.md'), 'hello');
  assert.equal(resolveSendFile(root, 'report.md'), path.join(root, 'report.md'));
  for (const name of ['config.json', '.env', 'secret.key']) {
    fs.writeFileSync(path.join(root, name), 'secret');
    assert.throws(() => resolveSendFile(root, name));
  }
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state', 'token'), 'secret');
  assert.throws(() => resolveSendFile(root, 'state/token'));
  assert.throws(() => resolveSendFile(root, '../outside'));
  assert.throws(() => resolveSendFile(root, 'https://example.com/file'));
  assert.equal(safeFileName('../../evil.txt'), 'evil.txt');
  assert.equal(safeFileName('CON'), 'file.bin');
  let downloadOptions;
  const saved = await receiveOwnerFile(cfg, 'private:123', { id: 'f1', name: '../../report.txt', size: 5 }, {
    call: async (_cfg, action, params) => { assert.equal(action, 'get_private_file_url'); assert.equal(params.user_id, 123); return { url: 'https://example.com/download' }; },
    download: async (_url, maxBytes, options) => { assert.equal(maxBytes, 20 * 1024 * 1024); downloadOptions = options; return { buffer: Buffer.from('hello') }; }
  });
  assert.equal(downloadOptions.requireImage, false);
  assert.equal(fs.readFileSync(saved.localPath, 'utf8'), 'hello');
  assert.equal(path.dirname(saved.localPath), path.join(root, 'QQ收件箱'));
  await assert.rejects(receiveOwnerFile(cfg, 'private:456', { id: 'f1' }));
  await assert.rejects(receiveOwnerFile(cfg, 'private:123', { id: 'f1', size: 999999999 }));
  console.log('PASS: owner isolation, token rejection, traversal/secret guards, receive save, size limits');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
