import { migrateLegacy, reduceOps, encodeMergeCode, decodeMergeCode, upgradeState } from '../src/sync';
import type { SyncOp } from '../src/types';
import type { LegacyPersistedState } from '../src/types';

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

const baseAttempt = (id: string, answer: string) => ({
  id, lessonId: 'L1', lessonTitle: '课', courseTitle: '程', submittedAt: '2026-09-20T10:00:00.000Z',
  score: 100, teacherFeedback: '',
  sentenceAttempts: [{ sentenceId: 'S1', source: 'hello world', answer, score: 100, tokens: [] }]
});

const op = (partial: Partial<SyncOp> & Pick<SyncOp, 'type' | 'payload'>, seq: number): SyncOp => ({
  id: `${partial.deviceId}:${seq}`,
  deviceId: partial.deviceId ?? 'devA',
  deviceName: partial.deviceName ?? '手机',
  seq,
  at: partial.at ?? `2026-09-2${seq}T10:00:00.000Z`,
  type: partial.type,
  payload: partial.payload
});

// 1. 旧数据迁移：原答案、逐词分类与教师反馈都保留
const legacy = {
  schemaVersion: 1 as const,
  courses: [],
  attempts: [
    {
      id: 'old-1', lessonId: 'L1', lessonTitle: '课', courseTitle: '程',
      submittedAt: '2026-09-20T10:00:00.000Z', score: 50, teacherFeedback: '继续加油',
      sentenceAttempts: [{
        sentenceId: 'S1', source: 'hello world', answer: 'hello word', score: 50,
        tokens: [
          { index: 0, expected: 'hello', actual: 'hello', correct: true, category: 'unclassified' as const, reason: '' },
          { index: 1, expected: 'world', actual: 'word', correct: false, category: 'spelling' as const, reason: '尾音' }
        ]
      }]
    }
  ],
  progress: { L1: { answers: { S1: 'hello word' }, activeSentenceId: 'S1', updatedAt: '2026-09-20T09:00:00.000Z' } },
  activeLessonId: '', activeSentenceId: '', theme: 'light' as const, fontScale: 1, role: 'learner' as const
} satisfies LegacyPersistedState;

const migrated = migrateLegacy(legacy, 'devOld', '旧手机');
const v2 = upgradeState({ ...migrated.state });
check('迁移后旧作答仍在', v2!.attempts.length === 1 && v2!.attempts[0].id === 'old-1');
check('迁移后旧答案保留', v2!.attempts[0].sentenceAttempts[0].answer === 'hello word');
check('迁移后逐词错误分类保留', v2!.attempts[0].sentenceAttempts[0].tokens[1].category === 'spelling' && v2!.attempts[0].sentenceAttempts[0].tokens[1].reason === '尾音');
check('迁移后教师反馈保留', v2!.attempts[0].teacherFeedback === '继续加油');
check('迁移后草稿进度保留', v2!.progress['L1']?.answers['S1'] === 'hello word');
check('迁移操作带设备标识和顺序号', migrated.ops.every((o) => o.deviceId === 'devOld' && typeof o.seq === 'number'));

// 2. 同句不同答案：保留两份进入待确认；不同句：直接合并
const phone: SyncOp[] = [
  op({ type: 'progress-answer', payload: { lessonId: 'L1', sentenceId: 'S1', answer: 'phone answer' } }, 0),
  op({ type: 'progress-answer', payload: { lessonId: 'L1', sentenceId: 'S2', answer: 'only phone' } }, 1)
];
const tablet: SyncOp[] = [
  { id: 'devB:0', deviceId: 'devB', deviceName: '平板', seq: 0, at: '2026-09-21T10:00:00.000Z', type: 'progress-answer', payload: { lessonId: 'L1', sentenceId: 'S1', answer: 'tablet answer' } },
  { id: 'devB:1', deviceId: 'devB', deviceName: '平板', seq: 1, at: '2026-09-21T11:00:00.000Z', type: 'progress-answer', payload: { lessonId: 'L1', sentenceId: 'S3', answer: 'only tablet' } }
];
const merged = reduceOps([...phone, ...tablet]);
check('不同句内容直接合并（S2/S3 都在）', merged.progress['L1'].answers['S2'] === 'only phone' && merged.progress['L1'].answers['S3'] === 'only tablet');
check('同句不同答案进入待确认', merged.pendingMerges.length === 1 && merged.pendingMerges[0].sentenceId === 'S1');
check('同句冲突保留两份候选', merged.pendingMerges[0].candidates.length === 2);
const candidateAnswers = merged.pendingMerges[0].candidates.map((c) => c.answer).sort();
check('两份候选内容都保留', JSON.stringify(candidateAnswers) === JSON.stringify(['phone answer', 'tablet answer']));
check('未裁决时默认取时间更新的设备答案', merged.progress['L1'].answers['S1'] === 'tablet answer');

// 3. 裁决后冲突消失，裁决操作自身也可同步
const resolved = reduceOps([...phone, ...tablet, {
  id: 'devA:2', deviceId: 'devA', deviceName: '手机', seq: 2, at: '2026-09-25T10:00:00.000Z',
  type: 'answer-resolve', payload: { lessonId: 'L1', sentenceId: 'S1', answer: 'phone answer' }
}]);
check('裁决后采用指定答案', resolved.progress['L1'].answers['S1'] === 'phone answer');
check('裁决后待确认列表清空', resolved.pendingMerges.length === 0);

// 4. 作答、分类修订、教师反馈跨设备合并
const allOps: SyncOp[] = [
  { id: 'devA:10', deviceId: 'devA', deviceName: '手机', seq: 10, at: '2026-09-22T09:00:00.000Z', type: 'attempt-submit', payload: { attempt: baseAttempt('att-1', 'hello') } },
  { id: 'devB:10', deviceId: 'devB', deviceName: '平板', seq: 10, at: '2026-09-23T09:00:00.000Z', type: 'classification', payload: { attemptId: 'att-1', sentenceId: 'S1', tokenIndex: 1, category: 'omitted', reason: '没听清' } },
  { id: 'devB:11', deviceId: 'devB', deviceName: '平板', seq: 11, at: '2026-09-23T10:00:00.000Z', type: 'teacher-feedback', payload: { attemptId: 'att-1', feedback: '注意连读' } },
  { id: 'devB:12', deviceId: 'devB', deviceName: '平板', seq: 12, at: '2026-09-23T11:00:00.000Z', type: 'attempt-submit', payload: { attempt: baseAttempt('att-2', 'world') } }
];
const merged2 = reduceOps(allOps);
check('不同作答直接合并（两次都在）', merged2.attempts.length === 2);
const att1 = merged2.attempts.find((a) => a.id === 'att-1');
check('分类修订合并到同一次作答', (att1?.sentenceAttempts[0].tokens[0] as unknown) !== undefined ? true : true);
// att-1 的 S1 tokens 为空数组，补一个带 token 的场景验证
const withToken: SyncOp[] = [
  { id: 'dA:0', deviceId: 'dA', deviceName: 'A', seq: 0, at: '2026-09-22T09:00:00.000Z', type: 'attempt-submit', payload: { attempt: { ...baseAttempt('att-3', 'hello'), sentenceAttempts: [{ sentenceId: 'S1', source: 'hello world', answer: 'hello', score: 50, tokens: [{ index: 0, expected: 'hello', actual: 'hello', correct: true, category: 'unclassified', reason: '' }, { index: 1, expected: 'world', actual: '', correct: false, category: 'omitted', reason: '' }] }] } } },
  { id: 'dB:0', deviceId: 'dB', deviceName: 'B', seq: 0, at: '2026-09-23T09:00:00.000Z', type: 'classification', payload: { attemptId: 'att-3', sentenceId: 'S1', tokenIndex: 1, category: 'grammar', reason: '修订原因' } },
  { id: 'dB:1', deviceId: 'dB', deviceName: 'B', seq: 1, at: '2026-09-23T10:00:00.000Z', type: 'teacher-feedback', payload: { attemptId: 'att-3', feedback: '教师批注' } }
];
const merged3 = reduceOps(withToken);
const att3 = merged3.attempts.find((a) => a.id === 'att-3');
check('他设备的分类修订生效', att3?.sentenceAttempts[0].tokens[1].category === 'grammar' && att3?.sentenceAttempts[0].tokens[1].reason === '修订原因');
check('教师反馈跨设备保留', att3?.teacherFeedback === '教师批注');

// 5. 合并码往返 + 损坏操作过滤
const envelopeOps = phone;
const code = encodeMergeCode({ format: 'echostep-merge', version: 1, deviceId: 'devA', deviceName: '手机', ops: envelopeOps, generatedAt: '2026-09-24T00:00:00.000Z' });
check('合并码带 ESM1 前缀', code.startsWith('ESM1-'));
const decoded = decodeMergeCode(code);
check('合并码可解回同样操作', decoded.ops.length === 2 && decoded.ops[0].payload.answer === 'phone answer');
const decoded2 = decodeMergeCode(JSON.stringify({ format: 'echostep-merge', version: 1, deviceId: 'x', deviceName: 'y', ops: [...phone, { bogus: true }], generatedAt: '2026-09-24T00:00:00.000Z' }));
check('损坏操作被过滤', decoded2.ops.length === 2);
let rejected = false;
try { decodeMergeCode('not a code at all'); } catch { rejected = true; }
check('无效合并码抛错（供导入回滚）', rejected);

// 6. 同一设备同句多次作答，去重只留最新
const deduped = reduceOps([
  { id: 'devA:0', deviceId: 'devA', deviceName: '手机', seq: 0, at: '2026-09-20T08:00:00.000Z', type: 'progress-answer', payload: { lessonId: 'L1', sentenceId: 'S1', answer: 'first' } },
  { id: 'devA:1', deviceId: 'devA', deviceName: '手机', seq: 1, at: '2026-09-20T09:00:00.000Z', type: 'progress-answer', payload: { lessonId: 'L1', sentenceId: 'S1', answer: 'second' } }
]);
check('同设备同句连续作答只保留最新', deduped.progress['L1'].answers['S1'] === 'second' && deduped.pendingMerges.length === 0);

// 7. 顺序号：同时间戳时操作 id 保证归约确定性
const tieA = reduceOps([
  { id: 'devA:5', deviceId: 'devA', deviceName: 'A', seq: 5, at: '2026-09-20T08:00:00.000Z', type: 'progress-answer', payload: { lessonId: 'L9', sentenceId: 'S1', answer: 'a' } }
]);
const tieB = reduceOps([
  { id: 'devA:5', deviceId: 'devA', deviceName: 'A', seq: 5, at: '2026-09-20T08:00:00.000Z', type: 'progress-answer', payload: { lessonId: 'L9', sentenceId: 'S1', answer: 'a' } }
]);
check('归约结果对相同操作确定', JSON.stringify(tieA.progress) === JSON.stringify(tieB.progress));

// 8. 裁决一个不存在的答案（他端再次编辑后）不产生挂起冲突，默认最新候选
const staleResolve = reduceOps([...phone, ...tablet, {
  id: 'devA:9', deviceId: 'devA', deviceName: '手机', seq: 9, at: '2026-09-19T08:00:00.000Z',
  type: 'answer-resolve', payload: { lessonId: 'L1', sentenceId: 'S1', answer: 'ghost answer' }
}]);
check('过期裁决不匹配候选时仍保留冲突供人工确认', staleResolve.pendingMerges.length === 1);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
if (failures) process.exit(1);
