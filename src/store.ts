import { reactive, watch } from 'vue';
import { createDeviceId, createInitialState } from './data';
import type { ErrorCategory, Lesson, MergeConflict, OpEnvelope, PersistedState, PracticeAttempt } from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';
const MERGE_CODE_PREFIX = 'EchoStepMerge1:';

// ---------- 旧数据迁移（v1 → v2） ----------

function migrateV1ToV2(raw: Record<string, any>): PersistedState {
  const deviceId = createDeviceId();
  const ops: OpEnvelope[] = [];
  let seq = 0;
  const push = (type: OpEnvelope['type'], createdAt: string, payload: Record<string, unknown>) => {
    seq += 1;
    ops.push({ id: `${deviceId}:${seq}`, deviceId, seq, type, createdAt, payload });
  };

  // 旧答案、反馈、分类都嵌在 attempt 快照里，整体作为一条 attempt 操作保留。
  for (const attempt of raw.attempts ?? []) {
    push('attempt', attempt.submittedAt ?? new Date(0).toISOString(), { attempt });
  }
  for (const [lessonId, rawProgress] of Object.entries(raw.progress ?? {})) {
    const progress = rawProgress as { answers?: Record<string, string>; activeSentenceId?: string; updatedAt?: string };
    for (const [sentenceId, answer] of Object.entries(progress.answers ?? {})) {
      push('answer', progress.updatedAt ?? new Date(0).toISOString(), { lessonId, sentenceId, answer });
    }
    if (progress.activeSentenceId) {
      push('progress', progress.updatedAt ?? new Date(0).toISOString(), { lessonId, activeSentenceId: progress.activeSentenceId });
    }
  }
  for (const course of raw.courses ?? []) {
    for (const lesson of course.lessons ?? []) {
      push('download', '2026-01-01T00:00:00.000Z', { lessonId: lesson.id, downloaded: !!lesson.downloaded });
    }
  }

  return {
    schemaVersion: 2,
    deviceId,
    ops,
    mergeConflicts: [],
    courses: raw.courses ?? [],
    attempts: raw.attempts ?? [],
    progress: raw.progress ?? {},
    activeLessonId: raw.activeLessonId ?? '',
    activeSentenceId: raw.activeSentenceId ?? '',
    theme: raw.theme ?? 'light',
    fontScale: raw.fontScale ?? 1,
    role: raw.role ?? 'learner'
  };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.schemaVersion === 2 && Array.isArray(parsed.ops)) return parsed as PersistedState;
      if (parsed.schemaVersion === 1) return migrateV1ToV2(parsed);
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
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

const now = () => new Date().toISOString();

// ---------- 追加操作 ----------

function appendOp(type: OpEnvelope['type'], payload: Record<string, unknown>): OpEnvelope {
  const seq = state.ops.reduce((max, op) => (op.deviceId === state.deviceId ? Math.max(max, op.seq) : max), 0) + 1;
  const op: OpEnvelope = { id: `${state.deviceId}:${seq}`, deviceId: state.deviceId, seq, type, createdAt: now(), payload };
  state.ops.push(op);
  return op;
}

export function ensureProgress(lessonId: string) {
  if (!state.progress[lessonId]) {
    state.progress[lessonId] = { answers: {}, activeSentenceId: '', updatedAt: now() };
  }
}

export function setAnswer(lessonId: string, sentenceId: string, answer: string) {
  ensureProgress(lessonId);
  const progress = state.progress[lessonId];
  progress.answers[sentenceId] = answer;
  progress.updatedAt = now();
  appendOp('answer', { lessonId, sentenceId, answer });
}

export function setActiveSentence(lessonId: string, sentenceId: string) {
  ensureProgress(lessonId);
  const progress = state.progress[lessonId];
  progress.activeSentenceId = sentenceId;
  progress.updatedAt = now();
  if (state.activeLessonId === lessonId) state.activeSentenceId = sentenceId;
  appendOp('progress', { lessonId, activeSentenceId: sentenceId });
}

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
  appendOp('download', { lessonId, downloaded: value });
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
  appendOp('attempt', { attempt });
}

export function updateTokenClassification(
  attemptId: string,
  sentenceId: string,
  tokenIndex: number,
  patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }
) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
  // 即使目标尝试尚未同步到本机，也先记录操作，合并时再落到对应记录上。
  appendOp('classification', { attemptId, sentenceId, tokenIndex, category: token?.category ?? patch.category ?? 'unclassified', reason: token?.reason ?? patch.reason ?? '' });
}

export function setTeacherFeedback(attemptId: string, feedback: string) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  if (attempt) attempt.teacherFeedback = feedback;
  // 反馈可能在尝试同步后才到达，操作始终入日志。
  appendOp('feedback', { attemptId, feedback });
}

// ---------- 合并码 ----------

export function generateMergeCode(): string {
  const payload = {
    app: 'echostep-dictation',
    kind: 'merge-code',
    version: 1,
    deviceId: state.deviceId,
    exportedAt: now(),
    ops: state.ops
  };
  const json = JSON.stringify(payload);
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return MERGE_CODE_PREFIX + base64;
}

function decodeMergeCode(code: string): { deviceId: string; ops: OpEnvelope[] } {
  const trimmed = code.trim();
  let json: string;
  if (trimmed.startsWith(MERGE_CODE_PREFIX)) {
    json = decodeURIComponent(escape(atob(trimmed.slice(MERGE_CODE_PREFIX.length))));
  } else if (trimmed.startsWith('{')) {
    json = trimmed;
  } else {
    json = decodeURIComponent(escape(atob(trimmed)));
  }
  const parsed = JSON.parse(json);
  if (!parsed || parsed.app !== 'echostep-dictation' || parsed.kind !== 'merge-code' || parsed.version !== 1) {
    throw new Error('invalid merge code');
  }
  if (typeof parsed.deviceId !== 'string' || !Array.isArray(parsed.ops)) throw new Error('invalid merge code');
  for (const op of parsed.ops as unknown[]) {
    const item = op as Record<string, unknown>;
    if (!item || typeof item.id !== 'string' || typeof item.deviceId !== 'string' || typeof item.seq !== 'number'
      || typeof item.type !== 'string' || typeof item.createdAt !== 'string' || typeof item.payload !== 'object' || item.payload === null) {
      throw new Error('invalid op');
    }
  }
  return { deviceId: parsed.deviceId, ops: parsed.ops as OpEnvelope[] };
}

// ---------- 归并 ----------

interface MergedSlices {
  answers: Map<string, Map<string, { answer: string; createdAt: string }>>;
  progress: Map<string, { activeSentenceId: string; createdAt: string }>;
  attempts: Map<string, { attempt: PracticeAttempt; createdAt: string }>;
  classifications: Map<string, { category: ErrorCategory; reason: string; createdAt: string }>;
  feedback: Map<string, { feedback: string; createdAt: string }>;
  downloads: Map<string, { downloaded: boolean; createdAt: string }>;
  conflicts: MergeConflict[];
}

function reduceOps(ops: OpEnvelope[]): MergedSlices {
  // 全序：先按操作时间，再按设备与顺序号，保证多设备归并结果确定。
  const sorted = [...ops].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);

  const answers = new Map<string, Map<string, { answer: string; createdAt: string }>>();
  const progress = new Map<string, { activeSentenceId: string; createdAt: string }>();
  const attempts = new Map<string, { attempt: PracticeAttempt; createdAt: string }>();
  const classifications = new Map<string, { category: ErrorCategory; reason: string; createdAt: string }>();
  const feedback = new Map<string, { feedback: string; createdAt: string }>();
  const downloads = new Map<string, { downloaded: boolean; createdAt: string }>();

  for (const op of sorted) {
    const p = op.payload;
    switch (op.type) {
      case 'answer': {
        const key = `${p.lessonId as string}|${p.sentenceId as string}`;
        let perDevice = answers.get(key);
        if (!perDevice) {
          perDevice = new Map();
          answers.set(key, perDevice);
        }
        // 同一设备只保留最后一次作答。
        perDevice.set(op.deviceId, { answer: p.answer as string, createdAt: op.createdAt });
        break;
      }
      case 'progress': {
        const lessonId = p.lessonId as string;
        const prev = progress.get(lessonId);
        if (!prev || op.createdAt >= prev.createdAt) {
          progress.set(lessonId, { activeSentenceId: p.activeSentenceId as string, createdAt: op.createdAt });
        }
        break;
      }
      case 'attempt': {
        const attempt = p.attempt as PracticeAttempt;
        const prev = attempts.get(attempt.id);
        if (!prev || op.createdAt >= prev.createdAt) attempts.set(attempt.id, { attempt, createdAt: op.createdAt });
        break;
      }
      case 'classification': {
        const key = `${p.attemptId as string}|${p.sentenceId as string}|${p.tokenIndex as number}`;
        const prev = classifications.get(key);
        if (!prev || op.createdAt >= prev.createdAt) {
          classifications.set(key, { category: p.category as ErrorCategory, reason: p.reason as string, createdAt: op.createdAt });
        }
        break;
      }
      case 'feedback': {
        const attemptId = p.attemptId as string;
        const prev = feedback.get(attemptId);
        if (!prev || op.createdAt >= prev.createdAt) {
          feedback.set(attemptId, { feedback: p.feedback as string, createdAt: op.createdAt });
        }
        break;
      }
      case 'download': {
        const lessonId = p.lessonId as string;
        const prev = downloads.get(lessonId);
        if (!prev || op.createdAt >= prev.createdAt) {
          downloads.set(lessonId, { downloaded: p.downloaded as boolean, createdAt: op.createdAt });
        }
        break;
      }
    }
  }

  // 同句不同答案：保留多份供人工确认。
  const conflicts: MergeConflict[] = [];
  for (const [key, perDevice] of answers) {
    const options = [...perDevice.entries()]
      .map(([deviceId, value]) => ({ deviceId, answer: value.answer, createdAt: value.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (new Set(options.map((option) => option.answer)).size > 1) {
      const separator = key.indexOf('|');
      const lessonId = key.slice(0, separator);
      const sentenceId = key.slice(separator + 1);
      conflicts.push({ key, lessonId, sentenceId, options });
    }
  }

  return { answers, progress, attempts, classifications, feedback, downloads, conflicts };
}

function applyMergedSlices(draft: PersistedState, slices: MergedSlices) {
  for (const course of draft.courses) {
    for (const lesson of course.lessons) {
      const downloaded = slices.downloads.get(lesson.id);
      if (downloaded) lesson.downloaded = downloaded.downloaded;
    }
  }

  for (const [key, perDevice] of slices.answers) {
    const separator = key.indexOf('|');
    const lessonId = key.slice(0, separator);
    const sentenceId = key.slice(separator + 1);
    let lessonProgress = draft.progress[lessonId];
    if (!lessonProgress) {
      lessonProgress = { answers: {}, activeSentenceId: '', updatedAt: '' };
      draft.progress[lessonId] = lessonProgress;
    }
    const distinct = new Set([...perDevice.values()].map((entry) => entry.answer));
    if (distinct.size === 1) {
      const onlyAnswer = [...perDevice.values()][0]?.answer ?? '';
      lessonProgress.answers[sentenceId] = onlyAnswer;
    }
    // 冲突答案保留本机现状，待人工确认后写入。
  }

  for (const [lessonId, value] of slices.progress) {
    let lessonProgress = draft.progress[lessonId];
    if (!lessonProgress) {
      lessonProgress = { answers: {}, activeSentenceId: '', updatedAt: '' };
      draft.progress[lessonId] = lessonProgress;
    }
    if (value.activeSentenceId) lessonProgress.activeSentenceId = value.activeSentenceId;
    lessonProgress.updatedAt = value.createdAt;
  }
  if (draft.activeLessonId) {
    const activeProgress = slices.progress.get(draft.activeLessonId);
    if (activeProgress?.activeSentenceId) draft.activeSentenceId = activeProgress.activeSentenceId;
  }

  const mergedAttempts = [...slices.attempts.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((entry) => entry.attempt);
  for (const attempt of mergedAttempts) {
    for (const sentenceAttempt of attempt.sentenceAttempts) {
      for (const token of sentenceAttempt.tokens) {
        const classification = slices.classifications.get(`${attempt.id}|${sentenceAttempt.sentenceId}|${token.index}`);
        if (classification) {
          token.category = classification.category;
          token.reason = classification.reason;
        }
      }
    }
    const feedbackEntry = slices.feedback.get(attempt.id);
    if (feedbackEntry) attempt.teacherFeedback = feedbackEntry.feedback;
  }
  draft.attempts = mergedAttempts;
  draft.mergeConflicts = slices.conflicts;
}

export interface MergeResult {
  ok: boolean;
  message: string;
  importedOps: number;
  totalOps: number;
  conflicts: number;
}

export function importMergeCode(code: string): MergeResult {
  let decoded: { deviceId: string; ops: OpEnvelope[] };
  try {
    decoded = decodeMergeCode(code);
  } catch {
    return { ok: false, message: '合并码无效或已损坏，本机内容未更改，请重新粘贴后再试。', importedOps: 0, totalOps: state.ops.length, conflicts: 0 };
  }
  if (decoded.deviceId === state.deviceId) {
    return { ok: false, message: '这是本机生成的合并码，无需导入。请在另一台设备上生成合并码后粘贴。', importedOps: 0, totalOps: state.ops.length, conflicts: 0 };
  }

  // 在草稿上归并，任何一步失败都不触碰本机状态，天然支持重试。
  // 状态全部是可 JSON 序列化的普通数据，用 JSON 往返克隆响应式代理。
  try {
    const draft = JSON.parse(JSON.stringify(state)) as PersistedState;
    const beforeIds = new Set(draft.ops.map((op) => op.id));
    const seen = new Set<string>();
    const union: OpEnvelope[] = [];
    for (const op of [...draft.ops, ...decoded.ops]) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      union.push(op);
    }
    const slices = reduceOps(union);
    applyMergedSlices(draft, slices);
    draft.ops = union;
    Object.assign(state, draft);
    persist();

    const importedOps = decoded.ops.filter((op) => !beforeIds.has(op.id)).length;
    const conflictNote = slices.conflicts.length ? `，其中 ${slices.conflicts.length} 处答案冲突待确认` : '';
    return {
      ok: true,
      message: `合并完成：新增 ${importedOps} 条操作，累计 ${union.length} 条${conflictNote}。`,
      importedOps,
      totalOps: union.length,
      conflicts: slices.conflicts.length
    };
  } catch {
    return { ok: false, message: '合并过程中出现错误，本机内容已恢复到导入前，请重试。', importedOps: 0, totalOps: state.ops.length, conflicts: 0 };
  }
}

export function resolveMergeConflict(key: string, answer: string) {
  const conflict = state.mergeConflicts.find((item) => item.key === key);
  if (!conflict) return;
  setAnswer(conflict.lessonId, conflict.sentenceId, answer);
  state.mergeConflicts = state.mergeConflicts.filter((item) => item.key !== key);
  persist();
}

// ---------- 读取 ----------

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    deviceId: state.deviceId,
    schemaVersion: state.schemaVersion,
    attempts: state.attempts,
    progress: state.progress,
    ops: state.ops,
    mergeConflicts: state.mergeConflicts
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
