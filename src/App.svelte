<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { ProgressBar } from '@skeletonlabs/skeleton'
  import { createSampleWorkspace } from './sample'
  import { clearWorkspace, getAudio, loadWorkspace, persistWorkspace, putAudio } from './storage'
  import {
    assembleProject,
    clone,
    createVersion,
    diffSnapshots,
    freshBundle,
    makeSnapshot,
    snapshotsEqual,
    uid,
    type DiffParts
  } from './versioning'
  import type {
    Attempt,
    AttemptBundle,
    Intonation,
    PracticeProject,
    SenseGroup,
    StressLevel,
    WorkspaceState
  } from './types'

  const intonationOptions: Array<{ value: Intonation; label: string }> = [
    { value: 'fall', label: '下降 ↘' },
    { value: 'rise', label: '上升 ↗' },
    { value: 'flat', label: '平稳 →' },
    { value: 'rise-fall', label: '先升后降 ↗↘' },
    { value: 'fall-rise', label: '先降后升 ↘↗' }
  ]

  let workspace: WorkspaceState = createSampleWorkspace()
  let audioMap = new Map<string, Blob | null>()
  let project: PracticeProject = assembleProject(workspace, audioMap)
  let loaded = false
  let saveStatus = '正在读取本机练习…'
  let online = true
  let selectedGroupId = project.groups[0]?.id ?? ''
  let selectedAttemptId = project.attempts.at(-1)?.id ?? ''
  let workspaceTab: 'annotate' | 'review' | 'progress' = 'annotate'
  let versionPanelOpen = false
  let recording = false
  let recordingSeconds = 0
  let recordingFallback = false
  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let mediaChunks: Blob[] = []
  let recordingTimer: number | undefined
  let saveTimer: number | undefined
  let playbackTimer: number | undefined
  let audioElement: HTMLAudioElement | undefined
  let playing = false
  let playbackTime = 0
  let audioUrls = new Map<string, string>()
  let issueWord = ''
  let issueCategory = '声调'
  let issueNote = ''
  let feedbackText = ''
  let newCategory = ''
  let undoStack: WorkspaceState[] = []
  let redoStack: WorkspaceState[] = []
  let selectedGroup: SenseGroup | undefined
  let selectedAttempt: Attempt | undefined

  // 工作区变化（或录音加载完成）后重新组装出界面试图使用的项目；录音按尝试 ID 注入，不复制
  $: project = assembleProject(workspace, audioMap)
  $: selectedGroup = project.groups.find((group) => group.id === selectedGroupId) ?? project.groups[0]
  $: selectedAttempt = project.attempts.find((attempt) => attempt.id === selectedAttemptId) ?? project.attempts.at(-1)
  $: selectedScore = selectedAttempt && selectedGroup ? selectedAttempt.scores.find((score) => score.groupId === selectedGroup?.id) : undefined
  // 该轮尝试是否在当前断句方案下留下过标注；没有时仍可按当前意群新开一套评分
  $: selectedAttemptBound = selectedAttempt ? Boolean(workspace.draft.bundles[selectedAttempt.id]) : false
  $: completedAttempts = Math.min(project.attempts.length, project.targetAttempts)
  $: progress = Math.round((completedAttempts / Math.max(project.targetAttempts, 1)) * 100)
  $: averageAccuracy = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / selectedAttempt.scores.length) : 0
  $: averageDeviation = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.deviation, 0) / selectedAttempt.scores.length) : 0
  $: totalIssueCategories = project.errorCategories.map((category) => ({ category, count: project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length }))

  // 当前稿所基于的版本与最新版本；与基准内容不同即视为有未存入版本库的改动
  $: baseRecord = workspace.versions.find((item) => item.id === workspace.baseVersionId) ?? workspace.versions.at(-1) ?? null
  $: draftDirty = baseRecord ? !snapshotsEqual(baseRecord, workspace.draft) : true
  $: versionRows = workspace.versions
    .map((record, index) => ({
      record,
      index,
      diff: diffSnapshots(workspace.versions[index - 1] ?? null, record),
      isBase: record.id === workspace.baseVersionId
    }))
    .reverse()

  function mutate(mutator: (draft: WorkspaceState) => void) {
    const before = clone(workspace)
    const draft = clone(workspace)
    mutator(draft)
    workspace = draft
    undoStack = [...undoStack.slice(-59), before]
    redoStack = []
    scheduleSave()
  }

  function editDraft(mutator: (draft: WorkspaceState['draft']) => void) {
    mutate((ws) => mutator(ws.draft))
  }

  function editBundle(attemptId: string, mutator: (bundle: AttemptBundle) => void) {
    editDraft((draft) => {
      const bundle = draft.bundles[attemptId] ?? freshBundle(draft.groups)
      draft.bundles[attemptId] = bundle
      mutator(bundle)
    })
  }

  function scheduleSave() {
    saveStatus = online ? '正在保存…' : '离线编辑中，稍后继续保存'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      const target = await persistWorkspace(workspace)
      saveStatus = target === 'indexeddb' ? '已保存到本机' : '已保存到离线备份'
    }, 250)
  }

  /** 手动保存：把当前稿作为新版本存入本机版本库；与最新版本完全相同则不重复生成 */
  async function commitVersion(): Promise<void> {
    window.clearTimeout(saveTimer)
    const latest = workspace.versions.at(-1) ?? null
    if (latest && snapshotsEqual(latest, workspace.draft)) {
      saveStatus = '当前稿与最近保存的版本相同，未重复保存'
      return
    }
    const record = createVersion(workspace.draft)
    mutate((ws) => {
      ws.versions.push(record)
      ws.baseVersionId = record.id
    })
    const target = await persistWorkspace(workspace)
    saveStatus = target === 'indexeddb'
      ? `已存入版本库 · 第 ${workspace.versions.length} 版`
      : `已存入离线备份 · 第 ${workspace.versions.length} 版`
  }

  /** 打开某版：先把当前稿自动保存成新版本（若无改动则跳过），再恢复目标版本 */
  async function openVersion(id: string) {
    const target = workspace.versions.find((item) => item.id === id)
    if (!target) return
    stopPlayback()
    window.clearTimeout(saveTimer)
    const before = clone(workspace)
    const next = clone(workspace)
    const latest = next.versions.at(-1)
    let autoSaved = false
    if (!latest || !snapshotsEqual(latest, next.draft)) {
      next.versions.push(createVersion(makeSnapshot(next.draft)))
      autoSaved = true
    }
    const targetIndex = next.versions.findIndex((item) => item.id === id)
    next.draft = makeSnapshot(target)
    next.baseVersionId = id
    workspace = next
    undoStack = [...undoStack.slice(-59), before]
    redoStack = []
    selectedGroupId = next.draft.groups[0]?.id ?? ''
    // 优先选中该版本保存时已有评分/反馈的最后一轮，让恢复的标注直接可见
    const scoredInVersion = next.attempts.filter((meta) => target.bundles[meta.id])
    selectedAttemptId = scoredInVersion.at(-1)?.id ?? next.attempts.at(-1)?.id ?? ''
    versionPanelOpen = false
    const backend = await persistWorkspace(workspace)
    saveStatus = `已恢复第 ${targetIndex + 1} 版${autoSaved ? '，切换前的稿件已自动存为新版本' : ''}（${backend === 'indexeddb' ? '本机' : '离线备份'}）`
  }

  async function removeVersion(id: string) {
    const index = workspace.versions.findIndex((item) => item.id === id)
    if (index < 0) return
    if (!confirm(`删除第 ${index + 1} 版只影响这份快照，共用的录音与其他版本保留，确定删除吗？`)) return
    mutate((ws) => {
      ws.versions = ws.versions.filter((item) => item.id !== id)
      if (ws.baseVersionId === id) ws.baseVersionId = ws.versions.at(-1)?.id ?? null
    })
    saveStatus = `已删除第 ${index + 1} 版，录音与其他版本未受影响`
  }

  function undo() {
    const target = undoStack.pop()
    if (!target) return
    redoStack = [...redoStack, clone(workspace)]
    workspace = target
    scheduleSave()
  }

  function redo() {
    const target = redoStack.pop()
    if (!target) return
    undoStack = [...undoStack, clone(workspace)]
    workspace = target
    scheduleSave()
  }

  function selectGroup(groupId: string) {
    selectedGroupId = groupId
    stopPlayback()
  }

  function updateGroup(field: keyof SenseGroup, value: string | number | string[]) {
    editDraft((draft) => {
      const group = draft.groups.find((item) => item.id === selectedGroupId)
      if (!group) return
      ;(group as unknown as Record<string, unknown>)[field] = value
    })
  }

  function setStressLevel(level: number) {
    updateGroup('stressLevel', level as StressLevel)
  }

  function setIntonation(value: string) {
    updateGroup('intonation', value as Intonation)
  }

  function toggleStressWord(word: string) {
    if (!selectedGroup) return
    const words = selectedGroup.stressWords.includes(word) ? selectedGroup.stressWords.filter((item) => item !== word) : [...selectedGroup.stressWords, word]
    updateGroup('stressWords', words)
  }

  function addGroup() {
    const id = uid('group')
    editDraft((draft) => {
      draft.groups.push({ id, text: '新的意群', stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'flat', note: '' })
    })
    selectedGroupId = id
  }

  function deleteGroup() {
    if (!selectedGroup || workspace.draft.groups.length <= 1) return
    const index = workspace.draft.groups.findIndex((group) => group.id === selectedGroup?.id)
    editDraft((draft) => { draft.groups = draft.groups.filter((group) => group.id !== selectedGroup?.id) })
    const remaining = workspace.draft.groups
    selectedGroupId = remaining[Math.max(0, index - 1)]?.id ?? remaining[0]?.id ?? ''
  }

  function moveGroup(direction: -1 | 1) {
    if (!selectedGroup) return
    const index = project.groups.findIndex((group) => group.id === selectedGroup?.id)
    const next = index + direction
    if (next < 0 || next >= project.groups.length) return
    editDraft((draft) => {
      const [group] = draft.groups.splice(index, 1)
      draft.groups.splice(next, 0, group)
    })
  }

  function splitSentence() {
    const parts = project.sentence.split(/[，。！？；、\n]+/).map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return
    editDraft((draft) => {
      draft.groups = parts.map((text, index) => ({
        id: draft.groups[index]?.id ?? uid('group'),
        text,
        stressWords: draft.groups[index]?.stressWords ?? [],
        stressLevel: draft.groups[index]?.stressLevel ?? 1,
        pauseMs: draft.groups[index]?.pauseMs ?? 300,
        intonation: draft.groups[index]?.intonation ?? 'flat',
        note: draft.groups[index]?.note ?? ''
      }))
    })
    selectedGroupId = project.groups[0]?.id ?? ''
  }

  function updateSentence(value: string) {
    editDraft((draft) => { draft.sentence = value })
  }

  async function startRecording() {
    if (recording) return
    recordingFallback = false
    mediaChunks = []
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('unsupported')
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder = new MediaRecorder(mediaStream)
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) mediaChunks.push(event.data) }
      mediaRecorder.onstop = () => void finishRecording(recordingFallback)
      mediaRecorder.start()
    } catch {
      recordingFallback = true
      mediaRecorder = null
    }
    recording = true
    recordingSeconds = 0
    window.clearInterval(recordingTimer)
    recordingTimer = window.setInterval(() => { recordingSeconds += 0.1 }, 100)
  }

  function stopRecording() {
    if (!recording) return
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    else void finishRecording(true)
  }

  async function finishRecording(simulated: boolean) {
    if (!recording) return
    recording = false
    window.clearInterval(recordingTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null
    mediaRecorder = null
    const blob = !simulated && mediaChunks.length ? new Blob(mediaChunks, { type: mediaChunks[0].type || 'audio/webm' }) : undefined
    const attemptId = uid('attempt')
    const number = workspace.attempts.length + 1
    const duration = Number(Math.max(0.5, recordingSeconds).toFixed(1))
    if (blob) {
      // 录音只存这一份，之后所有版本通过尝试 ID 共用
      audioMap.set(attemptId, blob)
      audioMap = new Map(audioMap)
      audioUrls.set(attemptId, URL.createObjectURL(blob))
      await putAudio(attemptId, blob)
    }
    mutate((ws) => {
      ws.attempts.push({
        id: attemptId,
        number,
        label: simulated ? `第 ${number} 轮 · 离线模拟` : `第 ${number} 轮`,
        createdAt: new Date().toISOString(),
        duration,
        audioMime: blob?.type ?? 'audio/webm',
        simulated,
        rangeStart: 0,
        rangeEnd: duration,
        selfNote: '',
        hasAudio: Boolean(blob)
      })
      // 当前断句方案下的一套初始评分；旧方案下的评分仍保留在各自版本快照里
      ws.draft.bundles[attemptId] = freshBundle(ws.draft.groups)
    })
    selectedAttemptId = attemptId
    workspaceTab = 'review'
    recordingSeconds = duration
  }

  // 启动后从共享录音表懒加载 Blob；每轮录音只读取这一份
  async function hydrateAudio() {
    let changed = false
    for (const meta of workspace.attempts) {
      if (meta.hasAudio && !audioMap.has(meta.id)) {
        const blob = await getAudio(meta.id)
        audioMap.set(meta.id, blob)
        changed = true
      }
    }
    if (changed) audioMap = new Map(audioMap)
  }

  function audioUrlFor(attempt?: Attempt) {
    if (!attempt?.audioBlob) return ''
    if (!audioUrls.has(attempt.id)) audioUrls.set(attempt.id, URL.createObjectURL(attempt.audioBlob))
    return audioUrls.get(attempt.id) ?? ''
  }

  function togglePlayback() {
    if (!selectedAttempt) return
    if (playing) {
      stopPlayback()
      return
    }
    playing = true
    playbackTime = selectedAttempt.rangeStart
    const url = audioUrlFor(selectedAttempt)
    if (url && audioElement) {
      audioElement.src = url
      audioElement.currentTime = selectedAttempt.rangeStart
      audioElement.play().catch(() => startPlaybackTimer())
    } else {
      startPlaybackTimer()
    }
  }

  function startPlaybackTimer() {
    window.clearInterval(playbackTimer)
    playbackTimer = window.setInterval(() => {
      playbackTime = Number((playbackTime + 0.1).toFixed(1))
      if (playbackTime >= (selectedAttempt?.rangeEnd ?? 0)) stopPlayback()
    }, 100)
  }

  function stopPlayback() {
    playing = false
    window.clearInterval(playbackTimer)
    audioElement?.pause()
  }

  function onAudioTimeUpdate() {
    if (!audioElement || !selectedAttempt) return
    playbackTime = audioElement.currentTime
    if (playbackTime >= selectedAttempt.rangeEnd) stopPlayback()
  }

  function updateScore(field: 'accuracy' | 'rhythm' | 'deviation', value: number) {
    if (!selectedAttempt || !selectedGroup) return
    editBundle(selectedAttempt.id, (bundle) => {
      let score = bundle.scores.find((item) => item.groupId === selectedGroupId)
      if (!score) {
        bundle.scores.push({ groupId: selectedGroupId, accuracy: 70, rhythm: 70, deviation: 0, note: '' })
        score = bundle.scores.at(-1)
      }
      if (score) score[field] = value
    })
  }

  function updateScoreNote(value: string) {
    if (!selectedAttempt || !selectedGroup) return
    editBundle(selectedAttempt.id, (bundle) => {
      const score = bundle.scores.find((item) => item.groupId === selectedGroupId)
      if (score) score.note = value
    })
  }

  function addWordIssue() {
    if (!selectedAttempt || !selectedGroup || !issueWord.trim()) return
    editBundle(selectedAttempt.id, (bundle) => {
      bundle.wordIssues.push({ id: uid('issue'), groupId: selectedGroupId, word: issueWord.trim(), category: issueCategory, note: issueNote.trim() })
    })
    issueWord = ''
    issueNote = ''
  }

  function removeWordIssue(issueId: string) {
    if (!selectedAttempt) return
    editBundle(selectedAttempt.id, (bundle) => {
      bundle.wordIssues = bundle.wordIssues.filter((issue) => issue.id !== issueId)
    })
  }

  function addFeedback() {
    if (!selectedGroup || !feedbackText.trim()) return
    const attemptId = selectedAttemptId
    const teacher = workspace.teacher
    editBundle(attemptId, (bundle) => {
      bundle.feedback.push({
        id: uid('feedback'),
        groupId: selectedGroupId,
        teacher,
        text: feedbackText.trim(),
        createdAt: new Date().toISOString()
      })
    })
    feedbackText = ''
  }

  function updateRange(field: 'rangeStart' | 'rangeEnd', value: number) {
    if (!selectedAttempt) return
    mutate((ws) => {
      const attempt = ws.attempts.find((item) => item.id === selectedAttemptId)
      if (!attempt) return
      attempt[field] = value
      if (attempt.rangeEnd <= attempt.rangeStart) {
        if (field === 'rangeStart') attempt.rangeEnd = Math.min(attempt.duration, value + 0.5)
        else attempt.rangeStart = Math.max(0, value - 0.5)
      }
    })
  }

  function updateSelfNote(value: string) {
    mutate((ws) => {
      const attempt = ws.attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.selfNote = value
    })
  }

  function addCategory() {
    if (!newCategory.trim() || workspace.errorCategories.includes(newCategory.trim())) return
    mutate((ws) => { ws.errorCategories.push(newCategory.trim()) })
    newCategory = ''
  }

  async function resetToSample(wipe: boolean) {
    if (!confirm(wipe
      ? '这会清除本机全部练习、版本与录音，恢复成内置示例，且不能撤销。'
      : '恢复示例会替换当前练习与全部版本（共用录音保留在本机但不再被引用），确定继续吗？')) return
    stopPlayback()
    if (wipe) await clearWorkspace()
    audioUrls.forEach((url) => URL.revokeObjectURL(url))
    audioUrls = new Map()
    audioMap = new Map()
    const seeded = createSampleWorkspace()
    workspace = seeded
    selectedGroupId = seeded.draft.groups[0]?.id ?? ''
    selectedAttemptId = seeded.attempts.at(-1)?.id ?? ''
    undoStack = []
    redoStack = []
    versionPanelOpen = false
    await persistWorkspace(workspace)
    saveStatus = wipe ? '已清除本机数据并恢复示例' : '已恢复示例，版本库已重新生成'
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  function diffSummary(parts: DiffParts): string[] {
    const labels: Array<[keyof DiffParts, string]> = [
      ['title', '标题'],
      ['sentence', '原文'],
      ['translation', '释义'],
      ['added', '新增意群'],
      ['removed', '删除意群'],
      ['reordered', '意群顺序'],
      ['text', '意群文本'],
      ['stress', '重音'],
      ['pause', '停顿'],
      ['intonation', '语调'],
      ['note', '学习提示'],
      ['scores', '评分'],
      ['issues', '错词'],
      ['feedback', '教师反馈']
    ]
    return labels
      .filter(([key]) => parts[key] > 0)
      .map(([key, label]) => (key === 'reordered' ? label : `${label} ${parts[key]}`))
  }

  function onKeydown(event: KeyboardEvent) {
    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void commitVersion()
    } else if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
    } else if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
    } else if (event.key === 'Escape' && versionPanelOpen) {
      versionPanelOpen = false
    } else if (event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      recording ? stopRecording() : void startRecording()
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveGroup(event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
      const index = project.groups.findIndex((group) => group.id === selectedGroupId)
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (project.groups[next]) selectedGroupId = project.groups[next].id
    }
  }

  onMount(async () => {
    online = navigator.onLine
    let loadedWorkspace = await loadWorkspace()
    if (!loadedWorkspace) {
      // 旧练习会在存储层迁移时自动生成首版；全新环境用示例生成一份带首版的工作区
      loadedWorkspace = createSampleWorkspace()
      await persistWorkspace(loadedWorkspace)
    }
    workspace = loadedWorkspace
    selectedGroupId = workspace.draft.groups[0]?.id ?? ''
    selectedAttemptId = workspace.attempts.at(-1)?.id ?? ''
    loaded = true
    saveStatus = '已恢复本机练习'
    void hydrateAudio()
    window.addEventListener('online', () => { online = true })
    window.addEventListener('offline', () => { online = false })
    window.addEventListener('keydown', onKeydown)
  })

  onDestroy(() => {
    window.clearTimeout(saveTimer)
    window.clearInterval(recordingTimer)
    window.clearInterval(playbackTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    audioUrls.forEach((url) => URL.revokeObjectURL(url))
    window.removeEventListener('keydown', onKeydown)
  })
</script>

<svelte:head>
  <title>{project.title} · 声律场</title>
</svelte:head>

<div class="app-shell min-h-screen">
  <header class="top-header">
    <div class="brand-block">
      <div class="brand-mark">律</div>
      <div>
        <strong>声律场</strong>
        <span>PROSODY PRACTICE</span>
      </div>
    </div>
    <div class="practice-title">
      <h1>{project.title}</h1>
      <span>
        {project.teacher} ·
        {#if baseRecord}
          基于第 {workspace.versions.findIndex((item) => item.id === baseRecord.id) + 1} 版（{formatTime(baseRecord.savedAt)}）
        {:else}
          尚未存入版本
        {/if}
        {#if draftDirty}<em class="dirty-mark">· 当前稿有未保存改动</em>{/if}
      </span>
    </div>
    <div class="header-actions">
      <span class:offline={!online} class="connection badge">{online ? '在线' : '离线编辑'}</span>
      <span class="save-state">{saveStatus}</span>
      <button class="btn btn-sm variant-soft-primary" on:click={() => versionPanelOpen = true}>
        版本库 · {workspace.versions.length}
      </button>
      <button class="btn btn-sm variant-filled-primary" on:click={commitVersion}>存入版本库</button>
      <button class="btn btn-sm variant-ghost" on:click={undo} disabled={!undoStack.length}>撤销</button>
      <button class="btn btn-sm variant-ghost" on:click={redo} disabled={!redoStack.length}>重做</button>
      <button class="btn btn-sm variant-ghost" on:click={() => resetToSample(false)}>恢复示例</button>
    </div>
  </header>

  <section class="progress-strip">
    <div class="progress-copy">
      <span>练习进度</span>
      <strong>{completedAttempts} / {project.targetAttempts} 轮</strong>
    </div>
    <ProgressBar value={progress} />
    <div class="progress-metric"><span>当前准确度</span><strong>{averageAccuracy}%</strong></div>
    <div class="progress-metric"><span>平均偏差</span><strong>{averageDeviation}%</strong></div>
    <div class="progress-metric"><span>目标时长</span><strong>{project.targetDuration.toFixed(1)}s</strong></div>
  </section>

  <div class="mobile-tabs">
    <button class:active={workspaceTab === 'annotate'} on:click={() => workspaceTab = 'annotate'}>标注</button>
    <button class:active={workspaceTab === 'review'} on:click={() => workspaceTab = 'review'}>录音校对</button>
    <button class:active={workspaceTab === 'progress'} on:click={() => workspaceTab = 'progress'}>反馈进度</button>
  </div>

  <main class="workspace">
    <aside class:mobile-hidden={workspaceTab !== 'annotate'} class="group-column card">
      <div class="section-heading">
        <div><span class="eyebrow">TEXT</span><h2>原文与意群</h2></div>
        <button class="btn btn-sm variant-soft-primary" on:click={addGroup}>＋ 意群</button>
      </div>
      <label class="label">
        <span>练习标题</span>
        <input class="input" value={project.title} on:input={(event) => editDraft((draft) => { draft.title = event.currentTarget.value })} />
      </label>
      <label class="label">
        <span>录入句子</span>
        <textarea class="textarea" rows="4" value={project.sentence} on:input={(event) => updateSentence(event.currentTarget.value)}></textarea>
      </label>
      <label class="label">
        <span>英文释义 / 参考</span>
        <textarea class="textarea" rows="3" value={project.translation} on:input={(event) => editDraft((draft) => { draft.translation = event.currentTarget.value })}></textarea>
      </label>
      <div class="inline-actions">
        <button class="btn btn-sm variant-soft" on:click={splitSentence}>按标点智能切分</button>
        <span>{project.groups.length} 个意群</span>
      </div>
      <div class="group-list">
        {#each project.groups as group, index (group.id)}
          <button class:active={group.id === selectedGroup?.id} class="group-item" on:click={() => selectGroup(group.id)}>
            <span class="group-index">{String(index + 1).padStart(2, '0')}</span>
            <span class="group-copy">
              <strong>{group.text}</strong>
              <small>重音 {group.stressWords.join('、') || '未设'} · 停 {group.pauseMs}ms · {intonationOptions.find((item) => item.value === group.intonation)?.label}</small>
            </span>
          </button>
        {/each}
      </div>
      <div class="sidebar-actions">
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(-1)}>上移</button>
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(1)}>下移</button>
        <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteGroup}>删除意群</button>
      </div>
      <div class="shortcut-note">
        <strong>快捷操作</strong>
        <span>Alt + ↑/↓ 调整意群 · Alt+R 开始/停止录音</span>
        <span>← / → 切换意群 · ⌘S 存入版本库 · ⌘Z 撤销</span>
      </div>
    </aside>

    {#if selectedGroup}
      <section class:mobile-hidden={workspaceTab !== 'annotate'} class="annotation-column">
        <div class="card annotation-card">
          <div class="section-heading">
            <div><span class="eyebrow">PROSODY MARKUP</span><h2>发音与韵律标注</h2></div>
            <span class="chapter-badge">意群 {project.groups.findIndex((group) => group.id === selectedGroup?.id) + 1}</span>
          </div>
          <label class="label">
            <span>意群文本</span>
            <input class="input" value={selectedGroup.text} on:input={(event) => updateGroup('text', event.currentTarget.value)} />
          </label>
          <div class="token-board">
            <div class="token-label">点击文字切换重音词</div>
            <div class="token-list">
              {#each selectedGroup.text.split('') as char}
                <button class:stressed={selectedGroup.stressWords.some((word) => word.includes(char))} class="text-token" on:click={() => toggleStressWord(char)}>{char}</button>
              {/each}
            </div>
          </div>
          <div class="annotation-grid">
            <label class="label">
              <span>重音词（用逗号分隔）</span>
              <input class="input" value={selectedGroup.stressWords.join('，')} on:change={(event) => updateGroup('stressWords', event.currentTarget.value.split(/[，,]/).map((word) => word.trim()).filter(Boolean))} />
            </label>
            <div class="label">
              <span>重音强度</span>
              <div class="segmented">
                {#each [0, 1, 2, 3] as level}
                  <button class:active={selectedGroup.stressLevel === level} on:click={() => setStressLevel(level)}>{level === 0 ? '无' : '●'.repeat(level)}</button>
                {/each}
              </div>
            </div>
            <label class="label">
              <span>后接停顿：{selectedGroup.pauseMs}ms</span>
              <input class="range" type="range" min="0" max="1500" step="20" value={selectedGroup.pauseMs} on:input={(event) => updateGroup('pauseMs', Number(event.currentTarget.value))} />
            </label>
            <label class="label">
              <span>语调走向</span>
              <select class="select" value={selectedGroup.intonation} on:change={(event) => setIntonation(event.currentTarget.value)}>
                {#each intonationOptions as option}<option value={option.value}>{option.label}</option>{/each}
              </select>
            </label>
            <label class="label span-2">
              <span>学习提示</span>
              <input class="input" value={selectedGroup.note} on:input={(event) => updateGroup('note', event.currentTarget.value)} placeholder="例如：重音后短停，句尾自然下落" />
            </label>
          </div>
          <div class="prosody-preview">
            <div>
              <span class="eyebrow">PREVIEW</span>
              <strong>标注预览</strong>
            </div>
            <p>
              <span class="stress-line">{'●'.repeat(selectedGroup.stressLevel)}</span>
              <span>{selectedGroup.text}</span>
              <span class="pause-mark">{selectedGroup.pauseMs ? `／ ${selectedGroup.pauseMs}ms` : ''}</span>
              <span class="intonation-mark">{intonationOptions.find((item) => item.value === selectedGroup.intonation)?.label}</span>
            </p>
          </div>
        </div>

        <div class="card recorder-card">
          <div class="section-heading">
            <div><span class="eyebrow">RECORDING</span><h2>录下这一轮</h2></div>
            <span class:recording class="record-dot">{recording ? 'REC' : 'READY'}</span>
          </div>
          <div class="record-console">
            <div class="record-time">{Math.floor(recordingSeconds / 60).toString().padStart(2, '0')}:{Math.floor(recordingSeconds % 60).toString().padStart(2, '0')}.{Math.floor((recordingSeconds % 1) * 10)}</div>
            <div class="level-bars" aria-hidden="true">
              {#each Array(24) as _, index}<span style={`height:${recording ? 18 + ((index * 17) % 46) : 12}%`}></span>{/each}
            </div>
            <button class:variant-filled-error={recording} class:variant-filled-primary={!recording} class="btn record-button" on:click={() => recording ? stopRecording() : startRecording()}>
              {recording ? '■ 停止并保存尝试' : '● 开始录音'}
            </button>
            <p>{recordingFallback ? '当前浏览器未授权麦克风，将保存一轮可校对的离线模拟记录。' : '录音仅在各版本间共用一份，保存在当前设备 IndexedDB，不会上传。'}</p>
          </div>
        </div>
      </section>
    {/if}

    <aside class:mobile-hidden={workspaceTab !== 'review' && workspaceTab !== 'progress'} class="review-column">
      <div class="card attempts-card">
        <div class="section-heading">
          <div><span class="eyebrow">TAKES</span><h2>多轮尝试</h2></div>
          <span class="chapter-badge">{project.attempts.length} 轮 · 录音跨版本共用</span>
        </div>
        <div class="attempt-list">
          {#each [...project.attempts].reverse() as attempt}
            <button class:active={attempt.id === selectedAttempt?.id} class="attempt-item" on:click={() => { selectedAttemptId = attempt.id; stopPlayback() }}>
              <span class="attempt-number">{attempt.number}</span>
              <span><strong>{attempt.label}</strong><small>{attempt.duration.toFixed(1)}s · {attempt.simulated ? '模拟' : '录音'}{#if !workspace.draft.bundles[attempt.id]} · 本方案未评分{/if}</small></span>
              <span class="attempt-score">{attempt.scores.length ? Math.round(attempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / attempt.scores.length) : 0}%</span>
            </button>
          {/each}
        </div>
      </div>

      {#if selectedAttempt}
        <div class:recommended={workspaceTab !== 'progress'} class="card playback-card">
          <div class="section-heading">
            <div><span class="eyebrow">COMPARE</span><h2>回听与偏差</h2></div>
            <button class="btn btn-sm variant-filled-primary" on:click={togglePlayback}>{playing ? '■ 停止' : '▶ 播放范围'}</button>
          </div>
          {#if !selectedAttemptBound}
            <p class="bound-hint">这轮录音录自其他断句方案；下方评分会按当前意群新开一套，原方案的评分仍保留在对应版本里。</p>
          {/if}
          <audio bind:this={audioElement} src={audioUrlFor(selectedAttempt)} on:timeupdate={onAudioTimeUpdate} on:ended={stopPlayback}></audio>
          <div class="playback-timeline">
            <div class="playhead" style={`left:${selectedAttempt.duration ? Math.min(100, playbackTime / selectedAttempt.duration * 100) : 0}%`}></div>
            <span class="range-fill" style={`left:${selectedAttempt.duration ? selectedAttempt.rangeStart / selectedAttempt.duration * 100 : 0}%;right:${selectedAttempt.duration ? 100 - selectedAttempt.rangeEnd / selectedAttempt.duration * 100 : 0}%`}></span>
          </div>
          <div class="range-controls">
            <label><span>回听起点 {selectedAttempt.rangeStart.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeStart} on:input={(event) => updateRange('rangeStart', Number(event.currentTarget.value))} /></label>
            <label><span>回听终点 {selectedAttempt.rangeEnd.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeEnd} on:input={(event) => updateRange('rangeEnd', Number(event.currentTarget.value))} /></label>
          </div>
          {#if selectedScore}
            <div class="score-grid">
              <label><span>准确度 {selectedScore.accuracy}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.accuracy} on:input={(event) => updateScore('accuracy', Number(event.currentTarget.value))} /></label>
              <label><span>节奏 {selectedScore.rhythm}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.rhythm} on:input={(event) => updateScore('rhythm', Number(event.currentTarget.value))} /></label>
              <label><span>偏差 {selectedScore.deviation}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.deviation} on:input={(event) => updateScore('deviation', Number(event.currentTarget.value))} /></label>
            </div>
            <label class="label"><span>本意群偏差说明</span><textarea class="textarea" rows="2" value={selectedScore.note} on:input={(event) => updateScoreNote(event.currentTarget.value)}></textarea></label>
          {/if}
          <label class="label"><span>本轮自评</span><textarea class="textarea" rows="2" value={selectedAttempt.selfNote} on:input={(event) => updateSelfNote(event.currentTarget.value)}></textarea></label>
        </div>

        <div class:recommended={workspaceTab === 'review'} class="card issues-card">
          <div class="section-heading">
            <div><span class="eyebrow">ERROR TAGS</span><h2>错词分类</h2></div>
          </div>
          <div class="issue-form">
            <input class="input" placeholder="错词或字" value={issueWord} on:input={(event) => issueWord = event.currentTarget.value} />
            <select class="select" value={issueCategory} on:change={(event) => issueCategory = event.currentTarget.value}>
              {#each project.errorCategories as category}<option value={category}>{category}</option>{/each}
            </select>
            <input class="input span-2" placeholder="问题说明（可选）" value={issueNote} on:input={(event) => issueNote = event.currentTarget.value} />
            <button class="btn btn-sm variant-filled-secondary span-2" on:click={addWordIssue}>添加错词记录</button>
          </div>
          <div class="issue-list">
            {#each selectedAttempt.wordIssues.filter((issue) => issue.groupId === selectedGroupId) as issue}
              <div class="issue-item">
                <span class="badge variant-filled-warning">{issue.category}</span>
                <strong>{issue.word}</strong>
                <p>{issue.note || '暂无补充说明'}</p>
                <button class="btn btn-sm variant-ghost text-error-500" on:click={() => removeWordIssue(issue.id)}>移除</button>
              </div>
            {/each}
            {#if !selectedAttempt.wordIssues.some((issue) => issue.groupId === selectedGroupId)}<p class="empty-copy">本轮意群还没有错词记录。</p>{/if}
          </div>
        </div>
      {/if}

      <div class:recommended={workspaceTab === 'progress'} class="card feedback-card">
        <div class="section-heading">
          <div><span class="eyebrow">TEACHER FEEDBACK</span><h2>逐段反馈</h2></div>
        </div>
        <div class="feedback-list">
          {#each selectedAttempt?.feedback.filter((item) => item.groupId === selectedGroupId) ?? [] as feedback}
            <div class="feedback-item">
              <strong>{feedback.teacher}</strong>
              <p>{feedback.text}</p>
              <small>{new Date(feedback.createdAt).toLocaleString('zh-CN')}</small>
            </div>
          {/each}
        </div>
        <label class="label"><span>给当前意群留言</span><textarea class="textarea" rows="2" value={feedbackText} on:input={(event) => feedbackText = event.currentTarget.value} placeholder="教师反馈会绑定到这一轮和这个意群"></textarea></label>
        <button class="btn btn-sm variant-filled-tertiary" on:click={addFeedback}>留下反馈</button>
      </div>
    </aside>

    {#if workspaceTab === 'progress'}
      <section class="progress-dashboard card">
        <div class="section-heading">
          <div><span class="eyebrow">PROGRESS</span><h2>练习进度与错词归类</h2></div>
        </div>
        <div class="progress-grid">
          <div><strong>{project.attempts.length}</strong><span>累计尝试</span></div>
          <div><strong>{averageAccuracy}%</strong><span>当前准确度</span></div>
          <div><strong>{averageDeviation}%</strong><span>平均偏差</span></div>
          <div><strong>{project.errorCategories.reduce((sum, category) => sum + project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length, 0)}</strong><span>错词记录</span></div>
        </div>
        <div class="category-list">
          {#each totalIssueCategories as category}
            <div><span>{category.category}</span><div class="mini-bar"><i style={`width:${Math.min(100, category.count * 18)}%`}></i></div><strong>{category.count}</strong></div>
          {/each}
        </div>
        <div class="inline-actions">
          <input class="input" bind:value={newCategory} placeholder="新增错词分类" />
          <button class="btn btn-sm variant-soft" on:click={addCategory}>添加分类</button>
          <button class="btn btn-sm variant-ghost" on:click={() => versionPanelOpen = true}>版本库</button>
          <button class="btn btn-sm variant-ghost text-error-500" on:click={() => resetToSample(true)}>清除本机数据</button>
        </div>
      </section>
    {/if}
  </main>

  {#if versionPanelOpen}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
    <div class="version-overlay" on:click={() => (versionPanelOpen = false)} role="presentation">
      <div class="version-panel card" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="本机版本库">
        <div class="section-heading">
          <div><span class="eyebrow">VERSIONS</span><h2>本机版本库</h2></div>
          <button class="btn btn-sm variant-ghost" on:click={() => versionPanelOpen = false}>关闭</button>
        </div>
        <p class="version-note">
          手动保存（⌘S 或“存入版本库”）会记下标题、原文与意群的重音、停顿、语调；打开旧版前当前稿会自动先存一份。
          录音各版本共用，删除版本只删除该版标注。
        </p>
        <div class="version-list">
          {#each versionRows as row}
            <div class="version-row">
              <div class="version-main">
                <div class="version-line">
                  <strong>第 {row.index + 1} 版</strong>
                  <span class="version-time">{formatTime(row.record.savedAt)}</span>
                  {#if row.isBase}<span class="badge variant-filled-success">当前稿基于此版</span>{/if}
                </div>
                <div class="version-title">{row.record.title || '未命名练习'}</div>
                <div class="version-groups">{row.record.groups.map((group) => group.text).join(' / ')}</div>
                <div class="version-diff">
                  {#if row.index === 0}
                    <span>首个版本 · {row.record.groups.length} 个意群</span>
                  {:else}
                    <span class="diff-count">与上一版 {row.diff.total} 处改动</span>
                    {#if row.diff.total}
                      <span class="diff-parts">{diffSummary(row.diff.parts).join('、')}</span>
                    {/if}
                  {/if}
                </div>
              </div>
              <div class="version-ops">
                <button class="btn btn-sm variant-filled-primary" on:click={() => openVersion(row.record.id)}>打开</button>
                <button class="btn btn-sm variant-ghost text-error-500" on:click={() => removeVersion(row.record.id)}>删除</button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if !loaded}
    <div class="loading-overlay"><span class="loading-bar">正在恢复离线练习…</span></div>
  {/if}
</div>
