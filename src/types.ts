export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher';
export type ThemeMode = 'light' | 'dark';

// 追加操作日志：每次作答、进度变更、提交、分类修订、教师反馈、下载标记都生成一条操作。
export type OpType = 'answer' | 'progress' | 'attempt' | 'classification' | 'feedback' | 'download';

export interface OpEnvelope {
  /** 全局唯一操作标识：`${deviceId}:${seq}`，用于重复导入去重。 */
  id: string;
  deviceId: string;
  /** 单设备内单调递增的顺序号。 */
  seq: number;
  type: OpType;
  createdAt: string;
  payload: Record<string, unknown>;
}

/** 同一句在不同设备上答案不一致时，保留两份供人工确认。 */
export interface MergeConflictOption {
  deviceId: string;
  answer: string;
  createdAt: string;
}

export interface MergeConflict {
  key: string;
  lessonId: string;
  sentenceId: string;
  options: MergeConflictOption[];
}

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
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: 2;
  /** 本机设备标识，合并码中用于区分操作来源。 */
  deviceId: string;
  /** 追加操作日志，合并与迁移都以它为来源。 */
  ops: OpEnvelope[];
  /** 合并后待人工确认的答案冲突。 */
  mergeConflicts: MergeConflict[];
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
