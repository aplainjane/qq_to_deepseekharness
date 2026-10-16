// 早报时间检测逻辑的离线校验（与 bridge.js 中实现保持一致）
// 验证：① 到点触发 ② 同日幂等（不重复投递）③ 补跑窗口 ④ 超出窗口则跳过 ⑤ 休眠/时钟漂移后可恢复

const p2 = (n) => String(n).padStart(2, '0');
const localDateStr = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
function clock(time) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim()); return { hh: Number(m?.[1] ?? 8), mm: Number(m?.[2] ?? 0) }; }
function todayAt(now, time) { const { hh, mm } = clock(time); const d = new Date(now); d.setHours(hh, mm, 0, 0); return d.getTime(); }

// 模拟 tick：返回本次是否投递
function tick(state, now, cfg) {
  if (cfg.enabled !== true) return 'disabled';
  if (state.lastRunDate === localDateStr(now)) return 'already-ran-today';
  const dueAt = todayAt(now, cfg.time);
  if (now < dueAt) return 'not-yet';
  // 宽限：轮询间隔内的迟到算"正常到点触发"（否则 catchUpMinutes=0 会永远错过）
  const graceMs = Math.max(Math.max(10 * 1000, cfg.checkIntervalMs || 60000), 60000);
  const lateMs = now - dueAt;
  const catchUpMs = Math.max(0, cfg.catchUpMinutes) * 60000;
  if (lateMs <= graceMs) {
    state.lastRunDate = localDateStr(now);
    return 'DISPATCH(scheduled)';
  }
  if (catchUpMs > 0 && lateMs <= catchUpMs) {
    state.lastRunDate = localDateStr(now);
    return 'DISPATCH(catch-up)';
  }
  state.lastRunDate = localDateStr(now);
  return 'skip-too-late';
}

// 模拟手动「早报」命令：不受"今天已跑过"限制；
// 若今天触发时刻已过，则标记今天已完成（避免随后一次 tick 重复投递）；
// 若还没到触发时刻（如 07:00 手动试跑），不标记，8:00 照常自动跑。
function manual(state, now, cfg) {
  if (cfg.enabled !== true) return 'disabled';
  if (now >= todayAt(now, cfg.time)) {
    state.lastRunDate = localDateStr(now);
    return 'DISPATCH(manual)+mark-today';
  }
  return 'DISPATCH(manual)+keep-today-pending';
}

const cfg = { enabled: true, time: '08:00', checkIntervalMs: 60000, catchUpMinutes: 180 };
const at = (s) => new Date(s).getTime();
const show = (ts) => new Date(ts).toLocaleString('zh-CN');

console.log('=== 场景1：正常到点触发 + 同日幂等 ===');
{
  const st = { lastRunDate: '' };
  for (const t of ['2026-10-16T07:59:00', '2026-10-16T08:00:00', '2026-10-16T08:01:00', '2026-10-16T09:00:00']) {
    console.log(`  ${show(at(t))} → ${tick(st, at(t), cfg)}`);
  }
  console.log('  期望：not-yet → DISPATCH → already-ran-today → already-ran-today');
}

console.log('\n=== 场景2：8:30 才开机（在 180 分钟补跑窗口内）===');
{
  const st = { lastRunDate: '' };
  console.log(`  ${show(at('2026-10-16T08:30:00'))} → ${tick(st, at('2026-10-16T08:30:00'), cfg)}`);
  console.log('  期望：DISPATCH（补跑今天的早报）');
}

console.log('\n=== 场景3：20:00 才开机（超出补跑窗口）===');
{
  const st = { lastRunDate: '' };
  console.log(`  ${show(at('2026-10-16T20:00:00'))} → ${tick(st, at('2026-10-16T20:00:00'), cfg)}`);
  console.log(`  随后 20:01 再检测 → ${tick(st, at('2026-10-16T20:01:00'), cfg)}`);
  console.log('  期望：skip-too-late → already-ran-today（不会晚点突然补发）');
}

console.log('\n=== 场景4：电脑休眠跨过 8 点（醒来仍是当天，窗口内）===');
{
  const st = { lastRunDate: '' };
  console.log(`  7:55 检测 → ${tick(st, at('2026-10-16T07:55:00'), cfg)}`);
  console.log(`  休眠 2 小时后 9:55 检测 → ${tick(st, at('2026-10-16T09:55:00'), cfg)}`);
  console.log('  期望：not-yet → DISPATCH（长定时器方案会漏掉，轮询检测不会）');
}

console.log('\n=== 场景5：跨天恢复 ===');
{
  const st = { lastRunDate: '' };
  console.log(`  10/16 08:01 → ${tick(st, at('2026-10-16T08:01:00'), cfg)}`);
  console.log(`  10/17 08:00 → ${tick(st, at('2026-10-17T08:00:00'), cfg)}`);
  console.log('  期望：DISPATCH → DISPATCH（新的一天重新触发）');
}

console.log('\n=== 场景6：改时间后当天不再跑（已跑过）===');
{
  const st = { lastRunDate: '2026-10-16' };
  console.log(`  已跑过，把时间从 08:00 改成 09:00，10/16 09:00 检测 → ${tick(st, at('2026-10-16T09:00:00'), cfg)}`);
  console.log('  期望：already-ran-today（同一天不重复；手动「早报」命令可强制执行）');
}

console.log('\n=== 场景7：手动「早报」在触发点之后执行，不会随后被自动重复投递 ===');
{
  const st = { lastRunDate: '' };
  console.log(`  21:14 手动「早报」→ ${manual(st, at('2026-10-16T21:14:00'), cfg)}`);
  console.log(`  21:15 紧接着一次自动检测 → ${tick(st, at('2026-10-16T21:15:00'), cfg)}`);
  console.log('  期望：DISPATCH(manual)+mark-today → already-ran-today（手动跑过当天不再重复）');
}

console.log('\n=== 场景8：手动「早报」在触发点之前试跑，8:00 仍会自动跑 ===');
{
  const st = { lastRunDate: '' };
  console.log(`  07:00 手动「早报」→ ${manual(st, at('2026-10-16T07:00:00'), cfg)}`);
  console.log(`  08:00 自动检测 → ${tick(st, at('2026-10-16T08:00:00'), cfg)}`);
  console.log('  期望：DISPATCH(manual)+keep-today-pending → DISPATCH(scheduled)（白天试跑不影响当天正式早报）');
}

console.log('\n=== 场景9：开关关闭时不投递 ===');
{
  const st = { lastRunDate: '' };
  const off = { ...cfg, enabled: false };
  console.log(`  08:00 自动检测 → ${tick(st, at('2026-10-16T08:00:00'), off)}`);
  console.log(`  21:00 手动「早报」→ ${manual(st, at('2026-10-16T21:00:00'), off)}`);
  console.log('  期望：disabled → disabled（config 开关关掉后完全不投递）');
}

console.log('\n=== 场景10：轮询迟到在宽限内仍算正常触发（不会因为没卡在 08:00:00 就漏掉）===');
{
  const st = { lastRunDate: '' };
  console.log(`  08:00:37 这次轮询才检测到 → ${tick(st, at('2026-10-16T08:00:37'), cfg)}`);
  console.log('  期望：DISPATCH(scheduled)（轮询间隔内的迟到属于正常到点）');
}

console.log('\n=== 场景11：catchUpMinutes=0（不补跑）当天仍能正常触发 ===');
{
  const st = { lastRunDate: '' };
  const noCatch = { ...cfg, catchUpMinutes: 0 };
  console.log(`  08:00:37 检测 → ${tick(st, at('2026-10-16T08:00:37'), noCatch)}`);
  const st2 = { lastRunDate: '' };
  console.log(`  08:30 才开机（不补跑）→ ${tick(st2, at('2026-10-16T08:30:00'), noCatch)}`);
  console.log('  期望：DISPATCH(scheduled) → skip-too-late（当天正常跑得到，但开机太晚就不补）');
}
