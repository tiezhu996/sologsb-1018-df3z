<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { ProgressBar } from '@skeletonlabs/skeleton'
  import { createSampleProject } from './sample'
  import { clearLibrary, hydrateRecordings, loadLibrary, saveLibrary } from './storage'
  import type { Attempt, Intonation, PracticeProject, PracticeVersion, SenseGroup, StressLevel, VersionOrigin } from './types'
  import { changeKindLabel, clone, createInitialVersion, createVersion, isDraftDirty, originLabel, uid } from './versions'

  const intonationOptions: Array<{ value: Intonation; label: string }> = [
    { value: 'fall', label: '下降 ↘' },
    { value: 'rise', label: '上升 ↗' },
    { value: 'flat', label: '平稳 →' },
    { value: 'rise-fall', label: '先升后降 ↗↘' },
    { value: 'fall-rise', label: '先降后升 ↘↗' }
  ]

  let project: PracticeProject = createSampleProject()
  let versions: PracticeVersion[] = []
  let currentVersionId: string | null = null
  let loaded = false
  let saveStatus = '正在读取本机练习…'
  let online = true
  let selectedGroupId = project.groups[0]?.id ?? ''
  let selectedAttemptId = project.attempts.at(-1)?.id ?? ''
  let workspaceTab: 'annotate' | 'review' | 'progress' | 'versions' = 'annotate'
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
  let versionNote = ''
  let undoStack: PracticeProject[] = []
  let redoStack: PracticeProject[] = []
  let selectedGroup: SenseGroup | undefined
  let selectedAttempt: Attempt | undefined

  $: selectedGroup = project.groups.find((group) => group.id === selectedGroupId) ?? project.groups[0]
  $: selectedAttempt = project.attempts.find((attempt) => attempt.id === selectedAttemptId) ?? project.attempts.at(-1)
  $: selectedScore = selectedAttempt && selectedGroup ? selectedAttempt.scores.find((score) => score.groupId === selectedGroup?.id) : undefined
  $: completedAttempts = Math.min(project.attempts.length, project.targetAttempts)
  $: progress = Math.round((completedAttempts / Math.max(project.targetAttempts, 1)) * 100)
  $: averageAccuracy = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / selectedAttempt.scores.length) : 0
  $: averageDeviation = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.deviation, 0) / selectedAttempt.scores.length) : 0
  $: totalIssueCategories = project.errorCategories.map((category) => ({ category, count: project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length }))
  $: currentVersion = versions.find((version) => version.id === currentVersionId) ?? null
  $: baseSnapshot = currentVersion?.snapshot
  $: draftDirty = isDraftDirty(project, baseSnapshot)
  $: orderedVersions = [...versions].reverse()

  const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
  const originClass: Record<VersionOrigin, string> = { manual: 'origin-manual', switch: 'origin-switch', legacy: 'origin-legacy' }

  function editProject(mutator: (draft: PracticeProject) => void) {
    const before = clone(project)
    const draft = clone(project)
    mutator(draft)
    draft.updatedAt = new Date().toISOString()
    project = draft
    undoStack = [...undoStack.slice(-59), before]
    redoStack = []
    scheduleSave()
  }

  /** 自动保存：只更新当前稿，不生成新版本，刷新或断网也不会丢标注 */
  function scheduleSave() {
    saveStatus = online ? '正在保存…' : '离线编辑中，稍后继续保存'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { void persistLibrary() }, 250)
  }

  async function persistLibrary(): Promise<'indexeddb' | 'localstorage'> {
    const target = await saveLibrary({ draft: project, currentVersionId, versions, recordings: {} })
    saveStatus = target === 'indexeddb' ? '已保存到本机' : '已保存到离线备份'
    return target
  }

  /** 手动保存：把标题、原文、意群重音/停顿/语调固化为一个新版本 */
  async function saveVersionManually() {
    if (!isDraftDirty(project, baseSnapshot)) {
      saveStatus = '当前稿与已保存版本一致，无需另存'
      return
    }
    window.clearTimeout(saveTimer)
    const version = createVersion(project, versions, 'manual', versionNote, currentVersionId)
    versions = [...versions, version]
    currentVersionId = version.id
    versionNote = ''
    undoStack = []
    redoStack = []
    const target = await persistLibrary()
    saveStatus = `已保存为第 ${version.number} 版 · ${version.changes.length} 处改动${target === 'localstorage' ? '（离线备份）' : ''}`
  }

  /** 打开某版：先把当前稿自动留存，再恢复该版；恢复后可继续编辑与录音 */
  async function openVersion(version: PracticeVersion) {
    if (version.id === currentVersionId) {
      workspaceTab = 'annotate'
      return
    }
    window.clearTimeout(saveTimer)
    stopPlayback()
    let nextVersions = versions
    if (isDraftDirty(project, baseSnapshot)) {
      const retained = createVersion(project, versions, 'switch', `打开第 ${version.number} 版前自动留存`, currentVersionId)
      nextVersions = [...versions, retained]
    }
    const restored = clone(version.snapshot)
    const hydrated = await hydrateRecordings(restored)
    // 录音 Blob 仍在录音库，ObjectURL 可安全释放并在回听时按需重建
    audioUrls.forEach((url) => URL.revokeObjectURL(url))
    audioUrls = new Map()
    versions = nextVersions
    project = hydrated
    currentVersionId = version.id
    selectedGroupId = hydrated.groups[0]?.id ?? ''
    selectedAttemptId = hydrated.attempts.at(-1)?.id ?? ''
    undoStack = []
    redoStack = []
    workspaceTab = 'annotate'
    await persistLibrary()
    const retained = nextVersions.at(-1)
    saveStatus = retained && retained.origin === 'switch'
      ? `已先留存当前稿为第 ${retained.number} 版，现打开第 ${version.number} 版`
      : `已打开第 ${version.number} 版`
  }

  /** 移除旧版本只影响该版本身；录音由各版本共用，不会被删除 */
  async function removeVersion(version: PracticeVersion) {
    if (versions.length <= 1 || version.id === currentVersionId) return
    if (!confirm(`确定移除第 ${version.number} 版「${version.title}」吗？只影响该版本，录音和其他版本保留。`)) return
    const remaining = versions.filter((item) => item.id !== version.id)
    versions = remaining.map((item, index) => ({ ...item, number: index + 1 }))
    await persistLibrary()
  }

  function undo() {
    const target = undoStack.pop()
    if (!target) return
    redoStack = [...redoStack, clone(project)]
    project = target
    scheduleSave()
  }

  function redo() {
    const target = redoStack.pop()
    if (!target) return
    undoStack = [...undoStack, clone(project)]
    project = target
    scheduleSave()
  }

  function selectGroup(groupId: string) {
    selectedGroupId = groupId
    stopPlayback()
  }

  function updateGroup(field: keyof SenseGroup, value: string | number | string[]) {
    editProject((draft) => {
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
    editProject((draft) => {
      draft.groups.push({ id, text: '新的意群', stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'flat', note: '' })
    })
    selectedGroupId = id
  }

  function deleteGroup() {
    if (!selectedGroup || project.groups.length <= 1) return
    const index = project.groups.findIndex((group) => group.id === selectedGroup.id)
    editProject((draft) => { draft.groups = draft.groups.filter((group) => group.id !== selectedGroup?.id) })
    selectedGroupId = project.groups[Math.max(0, index - 1)]?.id ?? ''
  }

  function moveGroup(direction: -1 | 1) {
    if (!selectedGroup) return
    const index = project.groups.findIndex((group) => group.id === selectedGroup?.id)
    const next = index + direction
    if (next < 0 || next >= project.groups.length) return
    editProject((draft) => {
      const [group] = draft.groups.splice(index, 1)
      draft.groups.splice(next, 0, group)
    })
  }

  function splitSentence() {
    const parts = project.sentence.split(/[，。！？；、\n]+/).map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return
    editProject((draft) => {
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
    editProject((draft) => { draft.sentence = value })
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
      mediaRecorder.onstop = () => finishRecording(recordingFallback)
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
    else finishRecording(true)
  }

  function finishRecording(simulated: boolean) {
    if (!recording) return
    recording = false
    window.clearInterval(recordingTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null
    mediaRecorder = null
    const blob = !simulated && mediaChunks.length ? new Blob(mediaChunks, { type: mediaChunks[0].type || 'audio/webm' }) : undefined
    const attemptId = uid('attempt')
    const number = project.attempts.length + 1
    const duration = Number(Math.max(0.5, recordingSeconds).toFixed(1))
    const attempt: Attempt = {
      id: attemptId,
      recordingId: blob ? attemptId : undefined,
      number,
      label: simulated ? `第 ${number} 轮 · 离线模拟` : `第 ${number} 轮`,
      createdAt: new Date().toISOString(),
      duration,
      audioBlob: blob,
      audioMime: blob?.type ?? 'audio/webm',
      simulated,
      rangeStart: 0,
      rangeEnd: duration,
      scores: project.groups.map((group) => ({ groupId: group.id, accuracy: 70, rhythm: 70, deviation: 0, note: '' })),
      wordIssues: [],
      feedback: [],
      selfNote: ''
    }
    if (blob) audioUrls.set(attemptId, URL.createObjectURL(blob))
    editProject((draft) => { draft.attempts.push(attempt) })
    selectedAttemptId = attemptId
    workspaceTab = 'review'
    recordingSeconds = duration
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
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      let score = attempt?.scores.find((item) => item.groupId === selectedGroupId)
      if (!attempt || !score) {
        attempt?.scores.push({ groupId: selectedGroupId, accuracy: 70, rhythm: 70, deviation: 0, note: '' })
        score = attempt?.scores.at(-1)
      }
      if (score) score[field] = value
    })
  }

  function updateScoreNote(value: string) {
    if (!selectedAttempt || !selectedGroup) return
    editProject((draft) => {
      const score = draft.attempts.find((attempt) => attempt.id === selectedAttemptId)?.scores.find((item) => item.groupId === selectedGroupId)
      if (score) score.note = value
    })
  }

  function addWordIssue() {
    if (!selectedAttempt || !selectedGroup || !issueWord.trim()) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      attempt?.wordIssues.push({ id: uid('issue'), groupId: selectedGroupId, word: issueWord.trim(), category: issueCategory, note: issueNote.trim() })
    })
    issueWord = ''
    issueNote = ''
  }

  function removeWordIssue(issueId: string) {
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.wordIssues = attempt.wordIssues.filter((issue) => issue.id !== issueId)
    })
  }

  function addFeedback() {
    if (!selectedGroup || !feedbackText.trim()) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      attempt?.feedback.push({
        id: uid('feedback'),
        groupId: selectedGroupId,
        teacher: draft.teacher,
        text: feedbackText.trim(),
        createdAt: new Date().toISOString()
      })
    })
    feedbackText = ''
  }

  function updateRange(field: 'rangeStart' | 'rangeEnd', value: number) {
    if (!selectedAttempt) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (!attempt) return
      attempt[field] = value
      if (attempt.rangeEnd <= attempt.rangeStart) {
        if (field === 'rangeStart') attempt.rangeEnd = Math.min(attempt.duration, value + 0.5)
        else attempt.rangeStart = Math.max(0, value - 0.5)
      }
    })
  }

  function addCategory() {
    if (!newCategory.trim() || project.errorCategories.includes(newCategory.trim())) return
    editProject((draft) => { draft.errorCategories.push(newCategory.trim()) })
    newCategory = ''
  }

  /** 重新载入示例：与“清除本机数据”一致，版本库回到示例的初始版本 */
  async function resetSample() {
    if (!confirm('恢复示例会替换当前练习与全部版本，确定继续吗？')) return
    await rebuildWithSample('示例练习已回到初始版本')
  }

  async function rebuildWithSample(status: string) {
    stopPlayback()
    audioUrls.forEach((url) => URL.revokeObjectURL(url))
    audioUrls = new Map()
    await clearLibrary()
    const sample = createSampleProject()
    const initial = createInitialVersion(sample)
    project = { ...sample, updatedAt: initial.savedAt }
    versions = [initial]
    currentVersionId = initial.id
    versionNote = ''
    selectedGroupId = sample.groups[0]?.id ?? ''
    selectedAttemptId = sample.attempts.at(-1)?.id ?? ''
    undoStack = []
    redoStack = []
    workspaceTab = 'annotate'
    await saveLibrary({ draft: project, currentVersionId, versions, recordings: {} })
    saveStatus = status
  }

  async function deleteAllData() {
    if (!confirm('这会清除本机全部练习、版本、录音与反馈，且不能撤销。')) return
    await rebuildWithSample('本机数据已清除，示例练习已就绪')
  }

  function onKeydown(event: KeyboardEvent) {
    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveVersionManually()
    } else if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
    } else if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
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
    const library = await loadLibrary()
    if (library) {
      versions = library.versions
      currentVersionId = library.currentVersionId ?? library.versions.at(-1)?.id ?? null
      project = await hydrateRecordings(library.draft)
    } else {
      // 首次使用：示例稿自动生成第 1 版，旧练习也会在加载时走同样的迁移逻辑
      const sample = createSampleProject()
      const initial = createInitialVersion(sample)
      project = { ...sample, updatedAt: initial.savedAt }
      versions = [initial]
      currentVersionId = initial.id
      await saveLibrary({ draft: project, currentVersionId, versions, recordings: {} })
    }
    selectedGroupId = project.groups[0]?.id ?? ''
    selectedAttemptId = project.attempts.at(-1)?.id ?? ''
    loaded = true
    saveStatus = library ? '已恢复本机练习与版本库' : '示例练习已就绪'
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
        {project.teacher} · {currentVersion ? `第 ${currentVersion.number} 版${draftDirty ? '（有未存改动）' : ''}` : '未存版本'}
      </span>
    </div>
    <div class="header-actions">
      <span class:offline={!online} class="connection badge">{online ? '在线' : '离线编辑'}</span>
      <span class="save-state">{saveStatus}</span>
      <button class="btn btn-sm variant-soft-primary" on:click={saveVersionManually} title="把当前标注固化为新版本（⌘/Ctrl + S）">保存版本</button>
      <button class="btn btn-sm variant-ghost" on:click={() => workspaceTab = 'versions'} title="查看、打开或移除历史版本">版本库（{versions.length}）</button>
      <button class="btn btn-sm variant-ghost" on:click={undo} disabled={!undoStack.length}>撤销</button>
      <button class="btn btn-sm variant-ghost" on:click={redo} disabled={!redoStack.length}>重做</button>
      <button class="btn btn-sm variant-ghost" on:click={resetSample}>恢复示例</button>
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
    <div class="progress-metric"><span>版本库</span><strong>{versions.length} 版{draftDirty ? ' · 有未存改动' : ''}</strong></div>
  </section>

  <div class="mobile-tabs">
    <button class:active={workspaceTab === 'annotate'} on:click={() => workspaceTab = 'annotate'}>标注</button>
    <button class:active={workspaceTab === 'review'} on:click={() => workspaceTab = 'review'}>录音校对</button>
    <button class:active={workspaceTab === 'progress'} on:click={() => workspaceTab = 'progress'}>反馈进度</button>
    <button class:active={workspaceTab === 'versions'} on:click={() => workspaceTab = 'versions'}>版本</button>
  </div>

  <main class="workspace">
    <aside class:mobile-hidden={workspaceTab !== 'annotate'} class="group-column card">
      <div class="section-heading">
        <div><span class="eyebrow">TEXT</span><h2>原文与意群</h2></div>
        <button class="btn btn-sm variant-soft-primary" on:click={addGroup}>＋ 意群</button>
      </div>
      <label class="label">
        <span>录入句子</span>
        <textarea class="textarea" rows="4" value={project.sentence} on:input={(event) => updateSentence(event.currentTarget.value)}></textarea>
      </label>
      <label class="label">
        <span>英文释义 / 参考</span>
        <textarea class="textarea" rows="3" value={project.translation} on:input={(event) => editProject((draft) => draft.translation = event.currentTarget.value)}></textarea>
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
        <span>← / → 切换意群 · ⌘S 保存新版本 · ⌘Z 撤销</span>
        <span>打开旧版本前会自动留存当前稿，录音各版本共用</span>
      </div>
    </aside>

    {#if selectedGroup}
      <section class:mobile-hidden={workspaceTab !== 'annotate'} class="annotation-column">
        <div class="card annotation-card">
          <div class="section-heading">
            <div>
              <span class="eyebrow">PROSODY MARKUP</span>
              <h2>发音与韵律标注</h2>
            </div>
            <span class="chapter-badge">
              {currentVersion ? `第 ${currentVersion.number} 版` : '当前稿'} · 意群 {project.groups.findIndex((group) => group.id === selectedGroup?.id) + 1}
            </span>
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
            <p>{recordingFallback ? '当前浏览器未授权麦克风，将保存一轮可校对的离线模拟记录。' : '录音仅保存在当前设备 IndexedDB，所有版本共用，不会重复占用空间。'}</p>
          </div>
        </div>
      </section>
    {/if}

    <aside class:mobile-hidden={workspaceTab !== 'review' && workspaceTab !== 'progress'} class="review-column">
      <div class="card attempts-card">
        <div class="section-heading">
          <div><span class="eyebrow">TAKES</span><h2>多轮尝试</h2></div>
          <span class="chapter-badge">{project.attempts.length} 轮</span>
        </div>
        <div class="attempt-list">
          {#each [...project.attempts].reverse() as attempt}
            <button class:active={attempt.id === selectedAttempt?.id} class="attempt-item" on:click={() => { selectedAttemptId = attempt.id; stopPlayback() }}>
              <span class="attempt-number">{attempt.number}</span>
              <span><strong>{attempt.label}</strong><small>{attempt.duration.toFixed(1)}s · {attempt.simulated ? '模拟' : '录音'}</small></span>
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
          <label class="label"><span>本轮自评</span><textarea class="textarea" rows="2" value={selectedAttempt.selfNote} on:input={(event) => editProject((draft) => { const attempt = draft.attempts.find((item) => item.id === selectedAttemptId); if (attempt) attempt.selfNote = event.currentTarget.value })}></textarea></label>
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
          <button class="btn btn-sm variant-ghost" on:click={() => workspaceTab = 'versions'}>查看版本库（{versions.length} 版）</button>
          <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteAllData}>清除本机数据</button>
        </div>
      </section>
    {/if}

    {#if workspaceTab === 'versions'}
      <section class="versions-dashboard card">
        <div class="section-heading">
          <div><span class="eyebrow">VERSIONS</span><h2>本机版本库</h2></div>
          <span class="chapter-badge">{versions.length} 个版本 · 录音共用</span>
        </div>
        <div class="versions-layout">
          <div class="version-save-card">
            <span class="eyebrow">SAVE SNAPSHOT</span>
            <h3>把当前稿存成新版本</h3>
            <p class="version-hint">保存标题、原文和各意群的重音、停顿、语调；评分、错词与教师反馈按保存时的意群原样保留。打开其他版本前，这里也会先自动留存当前稿。</p>
            <label class="label">
              <span>练习标题</span>
              <input class="input" value={project.title} on:input={(event) => editProject((draft) => { draft.title = event.currentTarget.value })} />
            </label>
            <label class="label">
              <span>本版备注（可选）</span>
              <textarea class="textarea" rows="2" bind:value={versionNote} placeholder="例如：第二意群后改成短停，句尾试升调"></textarea>
            </label>
            <button class="btn variant-filled-primary" on:click={saveVersionManually}>
              {draftDirty ? '保存当前标注为新版本' : '当前稿与已保存版本一致'}
            </button>
            <p class="version-hint">⌘ / Ctrl + S 同样可以保存版本；平时编辑会自动保存当前稿，不会丢内容。</p>
          </div>

          <div class="version-list-card">
            <div class="version-list">
              {#each orderedVersions as version}
                {@const isCurrent = version.id === currentVersionId}
                <div class="version-row" class:current={isCurrent}>
                  <div class="version-main">
                    <div class="version-head">
                      <span class="version-number">第 {version.number} 版</span>
                      <span class={`version-origin badge ${originClass[version.origin]}`}>{originLabel[version.origin]}</span>
                      {#if isCurrent}<span class="badge version-current-badge">当前稿</span>{/if}
                      {#if version.origin === 'legacy'}<span class="badge origin-legacy">首次打开自动生成</span>{/if}
                    </div>
                    <strong class="version-title">{version.title}</strong>
                    {#if version.note}<p class="version-note">{version.note}</p>{/if}
                    <small class="version-time">{formatTime(version.savedAt)}</small>
                    <div class="version-changes">
                      {#if version.origin === 'legacy' || version.number === 1}
                        <span class="change-count">初次收录 · {version.snapshot.groups.length} 个意群</span>
                      {:else}
                        <span class="change-count">{version.changes.length} 处改动{#if version.changes.length === 0}（标注无变化）{/if}</span>
                        {#each version.changes.slice(0, 4) as change}
                          <span class="change-tag">{change.groupLabel ?? changeKindLabel[change.kind]}{change.detail ? ` · ${change.detail}` : ''}</span>
                        {/each}
                        {#if version.changes.length > 4}<span class="change-tag">其余 {version.changes.length - 4} 处…</span>{/if}
                      {/if}
                    </div>
                  </div>
                  <div class="version-actions">
                    <button class="btn btn-sm variant-soft-primary" on:click={() => openVersion(version)} disabled={isCurrent}>
                      {isCurrent ? '编辑中' : '打开'}
                    </button>
                    <button class="btn btn-sm variant-ghost text-error-500" on:click={() => removeVersion(version)} disabled={isCurrent || versions.length <= 1}>移除</button>
                  </div>
                </div>
              {/each}
            </div>
            <p class="version-footnote">移除旧版本只删除该版的标注快照；录音在各版本之间共用，不会重复占用本机空间，也不会因移除版本而丢失。</p>
          </div>
        </div>
      </section>
    {/if}
  </main>

  {#if !loaded}
    <div class="loading-overlay"><span class="loading-bar">正在恢复离线练习…</span></div>
  {/if}
</div>
