import type {
  Attempt,
  AttemptBundle,
  PracticeProject,
  SenseGroup,
  SharedAttemptMeta,
  VersionRecord,
  VersionSnapshotData,
  WorkspaceState
} from './types'

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function clone<T>(value: T): T {
  return structuredClone(value)
}

/** 一轮尝试在给定意群方案下的默认标注：每个意群一条初始评分 */
export function freshBundle(groups: SenseGroup[]): AttemptBundle {
  return {
    scores: groups.map((group) => ({ groupId: group.id, accuracy: 70, rhythm: 70, deviation: 0, note: '' })),
    wordIssues: [],
    feedback: []
  }
}

function metaFromAttempt(attempt: Attempt): SharedAttemptMeta {
  return {
    id: attempt.id,
    number: attempt.number,
    label: attempt.label,
    createdAt: attempt.createdAt,
    duration: attempt.duration,
    audioMime: attempt.audioMime,
    simulated: attempt.simulated,
    rangeStart: attempt.rangeStart,
    rangeEnd: attempt.rangeEnd,
    selfNote: attempt.selfNote,
    hasAudio: Boolean(attempt.audioBlob)
  }
}

/** 从旧的单稿项目建立工作区（首次打开旧练习时自动生成一份版本） */
export function workspaceFromProject(project: PracticeProject): WorkspaceState {
  const draft: VersionSnapshotData = {
    title: project.title,
    sentence: project.sentence,
    translation: project.translation,
    groups: clone(project.groups),
    bundles: {}
  }
  for (const attempt of project.attempts) {
    draft.bundles[attempt.id] = {
      scores: clone(attempt.scores),
      wordIssues: clone(attempt.wordIssues),
      feedback: clone(attempt.feedback)
    }
  }
  const record: VersionRecord = {
    id: uid('ver'),
    savedAt: project.updatedAt || new Date().toISOString(),
    ...clone(draft)
  }
  return {
    schema: 2,
    teacher: project.teacher,
    targetAttempts: project.targetAttempts,
    targetDuration: project.targetDuration,
    errorCategories: clone(project.errorCategories),
    attempts: project.attempts.map(metaFromAttempt),
    baseVersionId: record.id,
    draft,
    versions: [record]
  }
}

/** 组装出 App 使用的 PracticeProject；录音 Blob 按尝试 ID 从共享表注入 */
export function assembleProject(
  workspace: WorkspaceState,
  audioMap: Map<string, Blob | null>
): PracticeProject {
  const groups = workspace.draft.groups
  const attempts: Attempt[] = workspace.attempts.map((meta) => {
    const bundle = workspace.draft.bundles[meta.id] ?? freshBundle(groups)
    const blob = audioMap.get(meta.id) ?? null
    const attempt: Attempt = {
      id: meta.id,
      number: meta.number,
      label: meta.label,
      createdAt: meta.createdAt,
      duration: meta.duration,
      audioMime: meta.audioMime,
      simulated: meta.simulated,
      rangeStart: meta.rangeStart,
      rangeEnd: meta.rangeEnd,
      scores: clone(bundle.scores),
      wordIssues: clone(bundle.wordIssues),
      feedback: clone(bundle.feedback),
      selfNote: meta.selfNote
    }
    if (blob) attempt.audioBlob = blob
    return attempt
  })
  return {
    title: workspace.draft.title,
    sentence: workspace.draft.sentence,
    translation: workspace.draft.translation,
    teacher: workspace.teacher,
    targetAttempts: workspace.targetAttempts,
    targetDuration: workspace.targetDuration,
    groups: clone(groups),
    attempts,
    errorCategories: workspace.errorCategories,
    updatedAt: new Date().toISOString()
  }
}

export function makeSnapshot(draft: VersionSnapshotData): VersionSnapshotData {
  return {
    title: draft.title,
    sentence: draft.sentence,
    translation: draft.translation,
    groups: clone(draft.groups),
    bundles: clone(draft.bundles)
  }
}

export function snapshotsEqual(a: VersionSnapshotData, b: VersionSnapshotData): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface DiffParts {
  title: number
  sentence: number
  translation: number
  added: number
  removed: number
  reordered: number
  text: number
  stress: number
  pause: number
  intonation: number
  note: number
  scores: number
  issues: number
  feedback: number
}

export interface SnapshotDiff {
  total: number
  parts: DiffParts
}

/** 比较两份快照：标题/原文/释义各计一处，意群按位置对齐，逐字段统计改动处数 */
export function diffSnapshots(prev: VersionSnapshotData | null, next: VersionSnapshotData): SnapshotDiff {
  const parts: DiffParts = {
    title: 0,
    sentence: 0,
    translation: 0,
    added: 0,
    removed: 0,
    reordered: 0,
    text: 0,
    stress: 0,
    pause: 0,
    intonation: 0,
    note: 0,
    scores: 0,
    issues: 0,
    feedback: 0
  }
  if (!prev) {
    parts.added = next.groups.length
    parts.scores = Object.keys(next.bundles).length
    return { total: parts.added + parts.scores + 3, parts }
  }
  if (prev.title !== next.title) parts.title += 1
  if (prev.sentence !== next.sentence) parts.sentence += 1
  if (prev.translation !== next.translation) parts.translation += 1

  const prevById = new Map(prev.groups.map((group) => [group.id, group]))
  const nextById = new Map(next.groups.map((group) => [group.id, group]))

  for (const group of next.groups) {
    if (!prevById.has(group.id)) parts.added += 1
  }
  for (const group of prev.groups) {
    if (!nextById.has(group.id)) parts.removed += 1
  }

  const sharedPairs: Array<[SenseGroup, SenseGroup]> = []
  next.groups.forEach((group) => {
    const other = prevById.get(group.id)
    if (other) sharedPairs.push([other, group])
  })
  const prevOrder = sharedPairs.map(([group]) => prev.groups.findIndex((item) => item.id === group.id))
  for (let i = 1; i < prevOrder.length; i += 1) {
    if (prevOrder[i] <= prevOrder[i - 1]) {
      parts.reordered = 1
      break
    }
  }

  for (const [before, after] of sharedPairs) {
    if (before.text !== after.text) parts.text += 1
    if (
      JSON.stringify(before.stressWords) !== JSON.stringify(after.stressWords) ||
      before.stressLevel !== after.stressLevel
    ) {
      parts.stress += 1
    }
    if (before.pauseMs !== after.pauseMs) parts.pause += 1
    if (before.intonation !== after.intonation) parts.intonation += 1
    if (before.note !== after.note) parts.note += 1
  }

  // 每轮尝试在该方案下的评分、错词、教师反馈按轮统计改动
  const attemptIds = new Set([...Object.keys(prev.bundles), ...Object.keys(next.bundles)])
  for (const attemptId of attemptIds) {
    const before = prev.bundles[attemptId]
    const after = next.bundles[attemptId]
    if (!before || !after) {
      if (after) parts.scores += 1
      continue
    }
    if (JSON.stringify(before.scores) !== JSON.stringify(after.scores)) parts.scores += 1
    if (JSON.stringify(before.wordIssues) !== JSON.stringify(after.wordIssues)) parts.issues += 1
    if (JSON.stringify(before.feedback) !== JSON.stringify(after.feedback)) parts.feedback += 1
  }

  const total = Object.values(parts).reduce((sum, value) => sum + value, 0)
  return { total, parts }
}

export function createVersion(draft: VersionSnapshotData, savedAt = new Date().toISOString()): VersionRecord {
  return { id: uid('ver'), savedAt, ...makeSnapshot(draft) }
}
