import type { PracticeProject, PracticeVersion, SenseGroup, StressLevel, VersionChange, VersionOrigin } from './types'

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 深拷贝；录音 Blob 在内存中可直接结构化克隆，落盘前会另行剔除 */
export const clone = <T,>(value: T): T => structuredClone(value)

const intonationLabels: Record<string, string> = {
  fall: '下降 ↘',
  rise: '上升 ↗',
  flat: '平稳 →',
  'rise-fall': '先升后降 ↗↘',
  'fall-rise': '先降后升 ↘↗'
}

const stressLevelLabel = (level: StressLevel) => (level === 0 ? '无重音' : '●'.repeat(level))

/** 去掉版本快照里的录音 Blob，录音统一存放在录音库 */
export function stripAudioBlobs(project: PracticeProject): PracticeProject {
  return {
    ...project,
    attempts: project.attempts.map((attempt) => ({ ...attempt, audioBlob: undefined }))
  }
}

/** 签名仅比较会进入版本的文本与韵律标注，忽略录音、评分、反馈和更新时间 */
function markupSignature(project: PracticeProject): string {
  return JSON.stringify({
    title: project.title,
    sentence: project.sentence,
    translation: project.translation,
    teacher: project.teacher,
    groups: project.groups.map((group) => ({
      id: group.id,
      text: group.text,
      stressWords: group.stressWords,
      stressLevel: group.stressLevel,
      pauseMs: group.pauseMs,
      intonation: group.intonation
    })),
    categories: project.errorCategories,
    targets: [project.targetAttempts, project.targetDuration]
  })
}

/** 当前稿相对已保存版本是否改过标注（评分与录音的变动不算未保存改动） */
export function isDraftDirty(project: PracticeProject, base: PracticeProject | undefined): boolean {
  if (!base) return true
  return markupSignature(project) !== markupSignature(base)
}

function labelFor(group: SenseGroup | undefined, index: number): string {
  const text = group?.text?.trim()
  return text ? `意群 ${index + 1}「${text.length > 10 ? `${text.slice(0, 10)}…` : text}」` : `意群 ${index + 1}`
}

/**
 * 比较两个版本的标题、原文及各意群的重音、停顿、语调。
 * 增删意群各记 1 处；共有意群的不同标注字段合并为 1 处，明细列入 detail。
 */
export function diffProjects(prev: PracticeProject | undefined, next: PracticeProject): VersionChange[] {
  const changes: VersionChange[] = []

  if (!prev) {
    next.groups.forEach((group, index) => {
      changes.push({ kind: 'added', groupId: group.id, groupLabel: labelFor(group, index), detail: '新建意群' })
    })
    return changes
  }

  if (prev.title !== next.title) changes.push({ kind: 'title', detail: `标题「${prev.title}」→「${next.title}」` })
  if (prev.sentence !== next.sentence) changes.push({ kind: 'sentence', detail: '原文内容已修改' })

  const prevById = new Map(prev.groups.map((group) => [group.id, group]))
  const nextById = new Map(next.groups.map((group) => [group.id, group]))
  const prevOrder = prev.groups.map((group) => group.id)
  const nextOrder = next.groups.map((group) => group.id)

  next.groups.forEach((group, index) => {
    const old = prevById.get(group.id)
    if (!old) {
      changes.push({ kind: 'added', groupId: group.id, groupLabel: labelFor(group, index), detail: '新增意群' })
      return
    }
    const details: string[] = []
    if (old.text !== group.text) details.push('意群文字修改')
    if (JSON.stringify(old.stressWords) !== JSON.stringify(group.stressWords)) {
      details.push(`重音词：${old.stressWords.join('、') || '未设'} → ${group.stressWords.join('、') || '未设'}`)
    }
    if (old.stressLevel !== group.stressLevel) {
      details.push(`重音强度：${stressLevelLabel(old.stressLevel)} → ${stressLevelLabel(group.stressLevel)}`)
    }
    if (old.pauseMs !== group.pauseMs) details.push(`停顿：${old.pauseMs}ms → ${group.pauseMs}ms`)
    if (old.intonation !== group.intonation) {
      details.push(`语调：${intonationLabels[old.intonation] ?? old.intonation} → ${intonationLabels[group.intonation] ?? group.intonation}`)
    }
    if (details.length) {
      changes.push({ kind: 'group', groupId: group.id, groupLabel: labelFor(group, index), detail: details.join('；') })
    }
  })

  prev.groups.forEach((group, index) => {
    if (!nextById.has(group.id)) {
      changes.push({ kind: 'removed', groupId: group.id, groupLabel: labelFor(group, index), detail: '删除意群' })
    }
  })

  // 共有意群的相对顺序变化（不与增删重复计数）
  const sharedPrev = prevOrder.filter((id) => nextById.has(id))
  const sharedNext = nextOrder.filter((id) => prevById.has(id))
  if (sharedPrev.join('|') !== sharedNext.join('|') && sharedPrev.length > 1) {
    changes.push({ kind: 'reordered', detail: '意群顺序调整' })
  }

  return changes
}

export function createVersion(
  project: PracticeProject,
  versions: PracticeVersion[],
  origin: VersionOrigin,
  note: string,
  basedOnId: string | null
): PracticeVersion {
  // 正常线性保存时上一版就是基线；从旧版继续编辑产生分支时，按所基于的版本比较
  const base = (basedOnId ? versions.find((version) => version.id === basedOnId) : undefined) ?? versions.at(-1)
  return {
    id: uid('version'),
    number: versions.length + 1,
    title: project.title.trim() || `练习版本 ${versions.length + 1}`,
    note: note.trim(),
    origin,
    savedAt: new Date().toISOString(),
    basedOnId,
    changes: diffProjects(base?.snapshot, project),
    snapshot: stripAudioBlobs(project)
  }
}

/** 旧练习首次打开时，把当时的整份练习固化为第 1 版 */
export function createInitialVersion(project: PracticeProject): PracticeVersion {
  return {
    id: uid('version'),
    number: 1,
    title: project.title.trim() || '初始版本',
    note: '',
    origin: 'legacy',
    savedAt: project.updatedAt || new Date().toISOString(),
    basedOnId: null,
    changes: project.groups.map((group, index) => ({
      kind: 'added' as const,
      groupId: group.id,
      groupLabel: labelFor(group, index),
      detail: '旧练习首次打开时收录'
    })),
    snapshot: stripAudioBlobs(project)
  }
}

export const originLabel: Record<VersionOrigin, string> = {
  manual: '手动保存',
  switch: '切换前留存',
  legacy: '旧练习收录'
}

export const changeKindLabel: Record<VersionChange['kind'], string> = {
  title: '标题',
  sentence: '原文',
  group: '意群标注',
  added: '新增意群',
  removed: '删除意群',
  reordered: '意群顺序'
}
