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

export interface PersistedPractice {
  project: PracticeProject
  version: 1
}

/** 一轮尝试在某个断句方案下产生的标注，按意群绑定，随版本保存 */
export interface AttemptBundle {
  scores: GroupScore[]
  wordIssues: WordIssue[]
  feedback: SegmentFeedback[]
}

/** 一轮录音的共享信息：所有版本共用同一条尝试与同一份录音，不随版本复制 */
export interface SharedAttemptMeta {
  id: string
  number: number
  label: string
  createdAt: string
  duration: number
  audioMime: string
  simulated: boolean
  rangeStart: number
  rangeEnd: number
  selfNote: string
  hasAudio: boolean
}

/** 版本快照内容：标题、原文、意群标注，以及各尝试在该方案下的评分/错词/反馈 */
export interface VersionSnapshotData {
  title: string
  sentence: string
  translation: string
  groups: SenseGroup[]
  bundles: Record<string, AttemptBundle>
}

export interface VersionRecord extends VersionSnapshotData {
  id: string
  savedAt: string
}

/** 本机工作区：全局共享的尝试列表 + 当前编辑稿 + 版本库 */
export interface WorkspaceState {
  schema: 2
  teacher: string
  targetAttempts: number
  targetDuration: number
  errorCategories: string[]
  attempts: SharedAttemptMeta[]
  baseVersionId: string | null
  draft: VersionSnapshotData
  versions: VersionRecord[]
}
