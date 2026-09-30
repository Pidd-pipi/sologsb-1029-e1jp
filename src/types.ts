export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
  /** 产生该作答的设备，多设备同句冲突时展示来源。 */
  deviceId?: string;
  deviceName?: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

/** 追加式操作日志的操作种类：作答、进度、分类修订、教师反馈、冲突裁决。 */
export type SyncOpType = 'attempt-submit' | 'progress-answer' | 'progress-position' | 'classification' | 'teacher-feedback' | 'answer-resolve';

export interface SyncOp {
  /** 全局唯一操作号（设备标识 + 设备内顺序号），重复导入据此去重。 */
  id: string;
  type: SyncOpType;
  /** 设备标识。 */
  deviceId: string;
  /** 产生该操作时设备使用的名称，合并端可据此识别来源。 */
  deviceName: string;
  /** 该设备上的单调递增顺序号。 */
  seq: number;
  /** ISO 时间戳，用于按时间排序与“最新优先”。 */
  at: string;
  payload: {
    // attempt-submit：整课作答（含逐词结果）
    attempt?: PracticeAttempt;
    // progress-answer / answer-resolve：某课某句的未提交草稿答案
    lessonId?: string;
    sentenceId?: string;
    answer?: string;
    // progress-position：该课最后停留在第几句
    activeSentenceId?: string;
    // classification：逐词错误分类与原因修订
    attemptId?: string;
    tokenIndex?: number;
    category?: ErrorCategory;
    reason?: string;
    // teacher-feedback：教师对某次作答的反馈
    feedback?: string;
  };
}

/** 不同设备对同一句留下了不同草稿答案，等待学习者人工确认。 */
export interface PendingMerge {
  lessonId: string;
  sentenceId: string;
  candidates: Array<{ answer: string; deviceId: string; deviceName: string; at: string }>;
  /** 已被裁决时记录答案本身，防止裁决操作被重复导入后再次弹出冲突。 */
  resolvedAnswer?: string;
}

/** 合并码信封：一段可复制粘贴的 base64 文本。 */
export interface MergeEnvelope {
  format: 'echostep-merge';
  version: 1;
  deviceId: string;
  deviceName: string;
  ops: SyncOp[];
  generatedAt: string;
}

/** 粘贴导入的统计结果。 */
export interface MergeSummary {
  received: number;
  applied: number;
  duplicates: number;
  conflicts: number;
  fromDeviceId: string;
  fromDeviceName: string;
}

export interface DeviceDirectoryEntry {
  deviceId: string;
  deviceName: string;
  lastSeenAt: string;
}

export interface PersistedState {
  schemaVersion: 2;
  courses: Course[];
  /** 由操作日志归约出的作答记录（课程进度/最近练习/教师复核/导出都读它）。 */
  attempts: PracticeAttempt[];
  /** 由操作日志归约出的每课进度（草稿答案、停留句）。 */
  progress: Record<string, LessonProgress>;
  /** 多设备同句异答的待确认冲突列表。 */
  pendingMerges: PendingMerge[];
  /** 操作日志的唯一真相源，所有数据变更只允许追加。 */
  ops: SyncOp[];
  deviceId: string;
  deviceName: string;
  /** 本设备已产生的操作顺序号。 */
  deviceSeq: number;
  devices: DeviceDirectoryEntry[];
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

/** 旧版（v1）存储结构，仅用于首次打开时迁移。 */
export interface LegacyPersistedState {
  schemaVersion: 1;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
