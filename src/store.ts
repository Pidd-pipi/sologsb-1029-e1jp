import { reactive, watch } from 'vue';
import { createV2InitialState, decodeMergeCode, encodeMergeCode, reduceOps, upgradeState } from './sync';
import type {
  ErrorCategory,
  MergeSummary,
  PersistedState,
  PracticeAttempt,
  SyncOp,
  SyncOpType
} from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';
const ANSWER_DEBOUNCE_MS = 600;

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const upgraded = upgradeState(parsed);
      if (upgraded) return upgraded;
    }
  } catch {
    // 存储损坏时回退到演示数据，但不覆盖磁盘，避免误删学习者记录。
  }
  return createV2InitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

/** 追加一条本机操作，并把操作日志重新归约到所有视图共用的记录上。 */
function appendOp(type: SyncOpType, payload: SyncOp['payload'], at = new Date().toISOString()): SyncOp {
  const seq = state.deviceSeq;
  const op: SyncOp = {
    id: `${state.deviceId}:${seq}`,
    type,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    seq,
    at,
    payload
  };
  state.deviceSeq += 1;
  state.ops.push(op);
  rebuildViews(op.at);
  return op;
}

/** 由操作日志重建作答、进度与待确认冲突，保证所有功能读取同一份合并记录。 */
function rebuildViews(at?: string) {
  const reduced = reduceOps(state.ops);
  state.attempts = reduced.attempts;
  state.progress = reduced.progress;
  state.pendingMerges = reduced.pendingMerges;
  if (at) touchDevice(state.deviceId, state.deviceName, at);
}

function touchDevice(deviceId: string, deviceName: string, at: string) {
  const entry = state.devices.find((item) => item.deviceId === deviceId);
  if (entry) {
    entry.deviceName = deviceName;
    if (at > entry.lastSeenAt) entry.lastSeenAt = at;
  } else {
    state.devices.push({ deviceId, deviceName, lastSeenAt: at });
  }
}

export const lessons = (): PersistedState['courses'][number]['lessons'] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string) => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

export function setDeviceName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  state.deviceName = trimmed;
  touchDevice(state.deviceId, trimmed, new Date().toISOString());
  persist();
}

/** 整课提交：整份作答（答案 + 逐词结果）作为一条追加操作进入日志。 */
export function saveAttempt(attempt: PracticeAttempt) {
  appendOp('attempt-submit', { attempt });
}

/** 记录停留句，重复停留在同一句不产生冗余操作。 */
export function recordPosition(lessonId: string, activeSentenceId: string) {
  const lastSameType = [...state.ops].reverse().find((op) => op.deviceId === state.deviceId && op.type === 'progress-position' && op.payload.lessonId === lessonId);
  if (lastSameType?.payload.activeSentenceId === activeSentenceId) return;
  appendOp('progress-position', { lessonId, activeSentenceId });
}

/** 错误分类/原因修订：逐词修订形成追加操作，任何一端的修订都会合并保留。 */
export function updateTokenClassification(
  attemptId: string,
  sentenceId: string,
  tokenIndex: number,
  patch: { category: ErrorCategory; reason: string }
) {
  appendOp('classification', { attemptId, sentenceId, tokenIndex, category: patch.category, reason: patch.reason });
}

/** 教师反馈作为教师设备视角的追加修订，不会覆盖作答本身。 */
export function saveTeacherFeedbackOp(attemptId: string, feedback: string) {
  appendOp('teacher-feedback', { attemptId, feedback });
}

/** 学习者在冲突中确认某一句采用的答案，裁决本身也是可同步的追加操作。 */
export function resolveAnswer(lessonId: string, sentenceId: string, answer: string) {
  appendOp('answer-resolve', { lessonId, sentenceId, answer });
  persist();
}

// ---- 未提交草稿：输入时乐观更新进度，停止输入 600ms 后形成一条作答操作 ----

let answerTimer = 0;
let pendingAnswer: { lessonId: string; sentenceId: string; answer: string } | null = null;

function optimisticallyWriteAnswer(lessonId: string, sentenceId: string, answer: string, at: string) {
  const progress = state.progress[lessonId] ?? { answers: {}, activeSentenceId: sentenceId, updatedAt: at };
  progress.answers[sentenceId] = answer;
  if (at > progress.updatedAt) progress.updatedAt = at;
  state.progress[lessonId] = progress;
}

export function recordAnswer(lessonId: string, sentenceId: string, answer: string) {
  const at = new Date().toISOString();
  const duplicateOfPending = pendingAnswer?.lessonId === lessonId && pendingAnswer.sentenceId === sentenceId && pendingAnswer.answer === answer;
  const current = state.progress[lessonId]?.answers[sentenceId];
  if (!duplicateOfPending && current !== answer) optimisticallyWriteAnswer(lessonId, sentenceId, answer, at);
  pendingAnswer = { lessonId, sentenceId, answer };
  window.clearTimeout(answerTimer);
  answerTimer = window.setTimeout(flushAnswer, ANSWER_DEBOUNCE_MS);
}

/** 立即落盘待写入的草稿答案操作（切句、提交、生成合并码前调用）。 */
export function flushAnswer() {
  window.clearTimeout(answerTimer);
  if (!pendingAnswer) return;
  const { lessonId, sentenceId, answer } = pendingAnswer;
  pendingAnswer = null;
  const lastSameSentence = [...state.ops].reverse().find((op) =>
    op.deviceId === state.deviceId &&
    (op.type === 'progress-answer' || op.type === 'answer-resolve') &&
    op.payload.lessonId === lessonId && op.payload.sentenceId === sentenceId);
  if (lastSameSentence?.payload.answer === answer) return;
  appendOp('progress-answer', { lessonId, sentenceId, answer });
  persist();
}

// ---- 合并码：生成 / 粘贴导入（失败回滚） ----

export function generateMergeCode(): string {
  flushAnswer();
  return encodeMergeCode({
    format: 'echostep-merge',
    version: 1,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    ops: state.ops.filter((op) => op.deviceId === state.deviceId),
    generatedAt: new Date().toISOString()
  });
}

/**
 * 粘贴导入：先解析校验，再以操作 id 幂等去重追加，最后统一归约。
 * 任何一步失败都恢复导入前的本机内容，并抛出错误供界面提示重试。
 */
export function importMergeCode(text: string): MergeSummary {
  const snapshot = JSON.stringify(state);
  try {
    const envelope = decodeMergeCode(text);
    const known = new Set(state.ops.map((op) => op.id));
    const incoming = envelope.ops;
    const fresh = incoming.filter((op) => !known.has(op.id));
    const duplicates = incoming.length - fresh.length;

    state.ops.push(...fresh);
    for (const op of fresh) touchDevice(op.deviceId, op.deviceName, op.at);
    touchDevice(envelope.deviceId, envelope.deviceName, envelope.generatedAt);
    rebuildViews();

    const summary: MergeSummary = {
      received: incoming.length,
      applied: fresh.length,
      duplicates,
      conflicts: state.pendingMerges.length,
      fromDeviceId: envelope.deviceId,
      fromDeviceName: envelope.deviceName
    };
    persist();
    return summary;
  } catch (error) {
    try {
      const restored = JSON.parse(snapshot) as PersistedState;
      const normalized = upgradeState(restored) ?? restored;
      Object.assign(state, normalized);
      persist();
    } catch {
      // 快照本身可解析为同一 reactive 结构；仍失败时保持现状并提示。
    }
    throw error instanceof Error ? error : new Error('合并失败，已恢复导入前的本机内容');
  }
}

export function exportRecords(): string {
  flushAnswer();
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    mergedFromDevices: state.devices,
    pendingMerges: state.pendingMerges,
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  window.clearTimeout(answerTimer);
  pendingAnswer = null;
  Object.assign(state, createV2InitialState());
}
