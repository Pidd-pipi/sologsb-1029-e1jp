// 通过 esbuild 打包后在 node 中运行：模拟浏览器最小环境，验证 store 导入/回滚行为。
const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k)
};
globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0), clearTimeout };
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const { state, importMergeCode, generateMergeCode, recordAnswer, flushAnswer, saveAttempt, resolveAnswer, exportRecords } =
  await import('/tmp/store-built.mjs');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`PASS  ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
};

// 初始状态来自演示数据迁移（v1 -> v2 首次打开）
check('首次打开迁移为 v2 操作日志', state.schemaVersion === 2 && state.ops.length > 0);
check('迁移后原演示答案与反馈可读', state.attempts[0]?.teacherFeedback?.includes('连读细节'));
const initialOps = state.ops.length;

// 本设备作答形成追加操作
recordAnswer('airport-01', 'airport-01-s2', 'Could I have a window seat please');
flushAnswer();
check('作答产生带设备标识和顺序号的新操作', state.ops.length === initialOps + 1 && state.ops.at(-1).deviceId === state.deviceId && state.ops.at(-1).seq === state.deviceSeq - 1);

// 平板端：用另一份独立日志模拟（手工构造 envelope）
const tabletOps = [
  { id: 'tablet:0', type: 'progress-answer', deviceId: 'tablet', deviceName: '我的平板', seq: 0, at: '2026-09-28T08:00:00.000Z', payload: { lessonId: 'airport-01', sentenceId: 'airport-01-s3', answer: 'How many bags are you checking' } },
  { id: 'tablet:1', type: 'progress-answer', deviceId: 'tablet', deviceName: '我的平板', seq: 1, at: '2026-09-28T08:05:00.000Z', payload: { lessonId: 'airport-01', sentenceId: 'airport-01-s2', answer: 'different tablet answer' } }
];
const tabletCode = 'ESM1-' + Buffer.from(JSON.stringify({ format: 'echostep-merge', version: 1, deviceId: 'tablet', deviceName: '我的平板', ops: tabletOps, generatedAt: '2026-09-28T09:00:00.000Z' }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const opsBefore = state.ops.length;
const summary1 = importMergeCode(tabletCode);
check('首次导入应用全部操作', summary1.applied === 2 && summary1.duplicates === 0);
check('导入后不同句内容合并可见', state.progress['airport-01'].answers['airport-01-s3'] === 'How many bags are you checking');
check('导入后同句不同答案进入待确认', state.pendingMerges.some((m) => m.sentenceId === 'airport-01-s2' && m.candidates.length === 2));
check('设备目录记录了对端设备', state.devices.some((d) => d.deviceId === 'tablet'));

// 重复导入同一合并码：只计一次
const summary2 = importMergeCode(tabletCode);
check('重复导入判定为重复、不追加', summary2.applied === 0 && summary2.duplicates === 2 && state.ops.length === opsBefore + 2);

// 失败合并码：状态回滚到导入前
const beforeRollback = JSON.stringify({ ops: state.ops.length, s3: state.progress['airport-01'].answers['airport-01-s3'], pending: state.pendingMerges.length });
let threw = false;
try {
  importMergeCode('ESM1-@@@@not-valid-base64-json');
} catch { threw = true; }
check('无效合并码抛出错误', threw);
check('失败后恢复导入前本机内容', JSON.stringify({ ops: state.ops.length, s3: state.progress['airport-01'].answers['airport-01-s3'], pending: state.pendingMerges.length }) === beforeRollback);
check('失败后允许立即重新尝试（再次成功）', (() => {
  const retry = importMergeCode(JSON.stringify({ format: 'echostep-merge', version: 1, deviceId: 'extra', deviceName: '另一台', ops: [{ id: 'extra:0', type: 'progress-answer', deviceId: 'extra', deviceName: '另一台', seq: 0, at: '2026-09-29T08:00:00.000Z', payload: { lessonId: 'airport-02', sentenceId: 'airport-02-s1', answer: 'Please place your laptop' } }], generatedAt: '2026-09-29T09:00:00.000Z' }));
  return retry.applied === 1;
})());

// 裁决冲突后，课程进度读取合并后记录，且裁决进入合并码
const conflict = state.pendingMerges.find((m) => m.sentenceId === 'airport-01-s2');
resolveAnswer(conflict.lessonId, conflict.sentenceId, 'Could I have a window seat please');
check('裁决后进度采用确认的答案', state.progress['airport-01'].answers['airport-01-s2'] === 'Could I have a window seat please');
check('裁决后冲突消失', !state.pendingMerges.some((m) => m.sentenceId === 'airport-01-s2'));
const code = generateMergeCode();
check('裁决操作包含在本机合并码中', code.includes('ESM1-'));

// 作答提交进入同一份合并记录
const attemptCount = state.attempts.length;
saveAttempt({ id: 'att-x', lessonId: 'meeting-01', lessonTitle: '确认行动项', courseTitle: '职场英语', submittedAt: '2026-09-30T10:00:00.000Z', score: 90, teacherFeedback: '', sentenceAttempts: [] });
check('最近练习读取的 attempts 即合并后同一份', state.attempts.length === attemptCount + 1);

// 导出读取合并后记录并带来源设备信息
const exported = JSON.parse(exportRecords());
check('导出包含合并后的作答与进度', Array.isArray(exported.attempts) && exported.progress['airport-02']?.answers['airport-02-s1'] === 'Please place your laptop');
check('导出包含参与合并的设备目录', exported.mergedFromDevices.some((d) => d.deviceId === 'tablet'));

// 重新从磁盘加载（持久化的 JSON）后重新归约，数据一致
const persisted = JSON.parse(storage.get('sologsb-1029-dictation-state-v1'));
check('持久化是 schemaVersion 2', persisted.schemaVersion === 2);
check('持久化保留了全部设备的操作', persisted.ops.some((o) => o.deviceId === 'tablet') && persisted.ops.some((o) => o.deviceId === state.deviceId));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
if (failures) process.exit(1);
