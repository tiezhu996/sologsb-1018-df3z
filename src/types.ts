export type Intonation = 'fall' | 'rise' | 'flat' | 'rise-fall' | 'fall-rise'
export type StressLevel = 0 | 1 | 2 | 3

export interface SenseGroup {
  id: string
  text: string
  stressWords: string[]
  stressLevel: StressLevel
  pauseMs: number
  intonation: Intonation
  note: string
}

export interface GroupScore {
  groupId: string
  accuracy: number
  rhythm: number
  deviation: number
  note: string
}

export interface WordIssue {
  id: string
  groupId: string
  word: string
  category: string
  note: string
}

export interface SegmentFeedback {
  id: string
  groupId: string
  teacher: string
  text: string
  createdAt: string
}

export interface Attempt {
  id: string
  /** 与录音库条目一致的键：各版本引用同一条录音，不重复占用空间 */
  recordingId?: string
  number: number
  label: string
  createdAt: string
  duration: number
  audioBlob?: Blob
  audioMime: string
  simulated: boolean
  rangeStart: number
  rangeEnd: number
  scores: GroupScore[]
  wordIssues: WordIssue[]
  feedback: SegmentFeedback[]
  selfNote: string
}

export interface PracticeProject {
  title: string
  sentence: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  groups: SenseGroup[]
  attempts: Attempt[]
  errorCategories: string[]
  updatedAt: string
}

/** 版本来源：手动保存 / 打开其他版本前自动留存 / 旧练习首次打开时生成 */
export type VersionOrigin = 'manual' | 'switch' | 'legacy'

export interface VersionChange {
  kind: 'title' | 'sentence' | 'group' | 'added' | 'removed' | 'reordered'
  groupId?: string
  groupLabel?: string
  detail: string
}

export interface PracticeVersion {
  id: string
  number: number
  title: string
  note: string
  origin: VersionOrigin
  savedAt: string
  basedOnId: string | null
  changes: VersionChange[]
  /** 保存时的完整练习；录音 Blob 不放入版本，统一存于录音库 */
  snapshot: PracticeProject
}

/** 录音库条目，多个版本通过 recordingId 共用同一份录音 */
export interface RecordingEntry {
  blob: Blob
  mime: string
  createdAt: string
}

export interface PracticeLibrary {
  /** 当前正在编辑的练习稿 */
  draft: PracticeProject
  /** 当前稿基于的版本；为 null 表示尚未保存过版本 */
  currentVersionId: string | null
  versions: PracticeVersion[]
  recordings: Record<string, RecordingEntry>
}

export interface PersistedLibrary {
  library: {
    draft: PracticeProject
    currentVersionId: string | null
    versions: PracticeVersion[]
  }
  version: 2
}

export interface PersistedPractice {
  project: PracticeProject
  version: 1
}
