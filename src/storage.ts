import type {
  Attempt,
  PersistedLibrary,
  PersistedPractice,
  PracticeLibrary,
  PracticeProject,
  RecordingEntry
} from './types'
import { createInitialVersion, stripAudioBlobs } from './versions'

const DB_NAME = 'sologsb-1018-prosody'
const DB_VERSION = 2
// v1 的对象仓库名为 practice，沿用原名以保证升级时读到旧练习
const LIBRARY_STORE = 'practice'
const RECORDING_STORE = 'recordings'
const LIBRARY_KEY = 'current'
const FALLBACK_KEY = 'sologsb-1018-fallback'

/** 已写入 IndexedDB 的录音，重复保存版本时不再重复写入 */
const persistedRecordings = new Set<string>()

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = request.result
      const oldVersion = event.oldVersion
      if (oldVersion < 1 && !db.objectStoreNames.contains(LIBRARY_STORE)) db.createObjectStore(LIBRARY_STORE)
      if (oldVersion < 2 && !db.objectStoreNames.contains(RECORDING_STORE)) db.createObjectStore(RECORDING_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function reqAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readLibraryDoc(db: IDBDatabase): Promise<PersistedLibrary | PersistedPractice | undefined> {
  const transaction = db.transaction(LIBRARY_STORE, 'readonly')
  return reqAsPromise(transaction.objectStore(LIBRARY_STORE).get(LIBRARY_KEY)) as Promise<PersistedLibrary | PersistedPractice | undefined>
}

/** v1 的单份练习转为版本库：录音搬进录音库，并自动生成第 1 版 */
function migrateLegacy(project: PracticeProject): PracticeLibrary {
  const recordings: Record<string, RecordingEntry> = {}
  const now = new Date().toISOString()
  const migrated: PracticeProject = {
    ...project,
    attempts: project.attempts.map((attempt) => {
      if (attempt.audioBlob) {
        recordings[attempt.id] = { blob: attempt.audioBlob, mime: attempt.audioMime, createdAt: attempt.createdAt || now }
        return { ...attempt, recordingId: attempt.id, audioBlob: undefined }
      }
      return attempt
    })
  }
  const initial = createInitialVersion(migrated)
  return {
    draft: migrated,
    currentVersionId: initial.id,
    versions: [initial],
    recordings
  }
}

function normalizeLibrary(library: PracticeLibrary): PracticeLibrary {
  // 版本快照里不应携带 Blob（防御性处理，正常流程落盘前已剔除）
  return {
    ...library,
    versions: library.versions.map((version) => ({ ...version, snapshot: stripAudioBlobs(version.snapshot) })),
    draft: stripAudioBlobs(library.draft)
  }
}

async function loadFromIndexedDb(): Promise<PracticeLibrary | null> {
  const db = await openDb()
  try {
    const doc = await readLibraryDoc(db)
    if (doc && (doc as PersistedLibrary).version === 2) {
      const persisted = doc as PersistedLibrary
      return { ...persisted.library, recordings: {} }
    }
    if (doc && (doc as PersistedPractice).version === 1 && (doc as PersistedPractice).project) {
      const library = migrateLegacy((doc as PersistedPractice).project)
      await persistLibrary(db, library)
      return library
    }
    // 老版本数据库里也可能没有版本号，按单份练习兜底迁移
    const maybeProject = (doc as PersistedPractice | undefined)?.project
    if (maybeProject) {
      const library = migrateLegacy(maybeProject)
      await persistLibrary(db, library)
      return library
    }
    return null
  } finally {
    db.close()
  }
}

async function persistLibrary(db: IDBDatabase, library: PracticeLibrary): Promise<void> {
  const normalized = normalizeLibrary(library)
  const transaction = db.transaction([LIBRARY_STORE, RECORDING_STORE], 'readwrite')
  const libraryStore = transaction.objectStore(LIBRARY_STORE)
  const recordingStore = transaction.objectStore(RECORDING_STORE)

  // 录音按 recordingId 去重写入：新录的在 draft 尝试上，旧练习迁移的在 recordings 映射里。
  // 多个版本引用同一份音频，保存版本不会重复写入。
  const pending = new Map<string, RecordingEntry>()
  for (const attempt of library.draft.attempts) {
    const id = attempt.recordingId || attempt.id
    if (attempt.audioBlob && !persistedRecordings.has(id)) {
      pending.set(id, { blob: attempt.audioBlob, mime: attempt.audioMime, createdAt: attempt.createdAt })
    }
  }
  for (const [id, entry] of Object.entries(library.recordings)) {
    if (!persistedRecordings.has(id)) pending.set(id, entry)
  }

  const writes: Promise<void>[] = []
  for (const [id, entry] of pending) {
    writes.push(reqAsPromise(recordingStore.put(entry, id)).then(() => { persistedRecordings.add(id) }))
  }
  writes.push(
    reqAsPromise(
      libraryStore.put(
        {
          library: { draft: normalized.draft, currentVersionId: normalized.currentVersionId, versions: normalized.versions },
          version: 2
        } satisfies PersistedLibrary,
        LIBRARY_KEY
      )
    ).then(() => undefined)
  )
  await Promise.all(writes)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

/** localStorage 兜底：与旧版一致，不保存录音 Blob */
function readFallback(): PracticeLibrary | null {
  const raw = localStorage.getItem(FALLBACK_KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw) as PersistedLibrary | (PersistedPractice & { project: PracticeProject })
  if ((parsed as PersistedLibrary).version === 2) {
    return { ...(parsed as PersistedLibrary).library, recordings: {} }
  }
  const legacy = (parsed as PersistedPractice).project
  if (legacy) {
    const library = migrateLegacy(legacy)
    writeFallback(library)
    return library
  }
  return null
}

function writeFallback(library: PracticeLibrary): void {
  const normalized = normalizeLibrary(library)
  const doc: PersistedLibrary = {
    library: { draft: normalized.draft, currentVersionId: normalized.currentVersionId, versions: normalized.versions },
    version: 2
  }
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(doc))
}

export async function loadLibrary(): Promise<PracticeLibrary | null> {
  try {
    return await loadFromIndexedDb()
  } catch {
    return readFallback()
  }
}

export async function saveLibrary(library: PracticeLibrary): Promise<'indexeddb' | 'localstorage'> {
  try {
    const db = await openDb()
    try {
      await persistLibrary(db, library)
    } finally {
      db.close()
    }
    return 'indexeddb'
  } catch {
    writeFallback(library)
    return 'localstorage'
  }
}

/** 打开版本或刷新后，把录音库里的 Blob 挂回当前稿的各轮尝试 */
export async function hydrateRecordings(project: PracticeProject): Promise<PracticeProject> {
  let db: IDBDatabase | null = null
  try {
    db = await openDb()
  } catch {
    return project
  }
  try {
    const missing = project.attempts.filter((attempt) => !attempt.audioBlob)
    if (!missing.length) return project
    const transaction = db.transaction(RECORDING_STORE, 'readonly')
    const store = transaction.objectStore(RECORDING_STORE)
    const entries = await Promise.all(
      missing.map(async (attempt): Promise<[string, RecordingEntry | undefined]> => {
        const id = attempt.recordingId || attempt.id
        try {
          return [attempt.id, (await reqAsPromise(store.get(id))) as RecordingEntry | undefined]
        } catch {
          return [attempt.id, undefined]
        }
      })
    )
    const byAttemptId = new Map(entries)
    return {
      ...project,
      attempts: project.attempts.map((attempt): Attempt => {
        const entry = byAttemptId.get(attempt.id)
        if (!entry) return attempt
        persistedRecordings.add(attempt.recordingId || attempt.id)
        return { ...attempt, recordingId: attempt.recordingId || attempt.id, audioBlob: entry.blob, audioMime: entry.mime || attempt.audioMime }
      })
    }
  } finally {
    db.close()
  }
}

export async function clearLibrary(): Promise<void> {
  persistedRecordings.clear()
  try {
    const db = await openDb()
    try {
      const transaction = db.transaction([LIBRARY_STORE, RECORDING_STORE], 'readwrite')
      transaction.objectStore(LIBRARY_STORE).delete(LIBRARY_KEY)
      transaction.objectStore(RECORDING_STORE).clear()
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
  } catch {
    // 忽略 IndexedDB 清理失败，继续清理下面的兜底存储
  }
  localStorage.removeItem(FALLBACK_KEY)
}
