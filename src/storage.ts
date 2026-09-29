import type { PersistedPractice, WorkspaceState } from './types'
import { workspaceFromProject } from './versioning'

const DB_NAME = 'sologsb-1018-prosody'
const DB_VERSION = 2
const WORKSPACE_STORE = 'kv'
const AUDIO_STORE = 'audio'
const WORKSPACE_KEY = 'workspace'
const LEGACY_STORE = 'practice'
const LEGACY_KEY = 'current'
const FALLBACK_KEY = 'sologsb-1018-workspace-v2'
const LEGACY_FALLBACK_KEY = 'sologsb-1018-fallback'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const transaction = request.transaction
      const hasLegacy = db.objectStoreNames.contains(LEGACY_STORE)
      const legacyStore = hasLegacy ? transaction!.objectStore(LEGACY_STORE) : null
      const readRequest = legacyStore?.get(LEGACY_KEY)

      const migrate = (legacy: PersistedPractice | undefined) => {
        if (!db.objectStoreNames.contains(WORKSPACE_STORE)) db.createObjectStore(WORKSPACE_STORE)
        if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE)
        const upgradeTx = transaction!
        if (legacy?.project) {
          const workspace = workspaceFromProject(legacy.project)
          upgradeTx.objectStore(WORKSPACE_STORE).put(workspace, WORKSPACE_KEY)
          for (const attempt of legacy.project.attempts) {
            if (attempt.audioBlob) upgradeTx.objectStore(AUDIO_STORE).put(attempt.audioBlob, attempt.id)
          }
        }
        if (hasLegacy) db.deleteObjectStore(LEGACY_STORE)
      }

      if (readRequest) {
        readRequest.onsuccess = () => migrate(readRequest.result as PersistedPractice | undefined)
        readRequest.onerror = () => reject(readRequest.error)
      } else {
        migrate(undefined)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * 读取本机工作区。IndexedDB 不可用时退化到 localStorage：
 * localStorage 只能存 JSON，录音 Blob 无法保存（与旧版本行为一致）。
 */
export async function loadWorkspace(): Promise<WorkspaceState | null> {
  try {
    const db = await openDb()
    const value = await new Promise<WorkspaceState | undefined>((resolve, reject) => {
      const transaction = db.transaction(WORKSPACE_STORE, 'readonly')
      const request = transaction.objectStore(WORKSPACE_STORE).get(WORKSPACE_KEY)
      request.onsuccess = () => resolve(request.result as WorkspaceState | undefined)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (value) return value
  } catch {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (raw) return JSON.parse(raw) as WorkspaceState
    const legacy = localStorage.getItem(LEGACY_FALLBACK_KEY)
    if (legacy) {
      const migrated = workspaceFromProject(JSON.parse(legacy) as PersistedPractice['project'])
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(migrated))
      localStorage.removeItem(LEGACY_FALLBACK_KEY)
      return migrated
    }
  }
  return null
}

export async function persistWorkspace(workspace: WorkspaceState): Promise<'indexeddb' | 'localstorage'> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(WORKSPACE_STORE, 'readwrite')
      transaction.objectStore(WORKSPACE_STORE).put(workspace, WORKSPACE_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
    return 'indexeddb'
  } catch {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(workspace))
    return 'localstorage'
  }
}

/** 录音按尝试 ID 单独存一份，所有版本共用；localStorage 降级时不保存录音 */
export async function putAudio(attemptId: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, 'readwrite')
      transaction.objectStore(AUDIO_STORE).put(blob, attemptId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // localStorage 降级环境下无法持久化录音 Blob，本轮录音在当前会话仍可回听。
  }
}

export async function getAudio(attemptId: string): Promise<Blob | null> {
  try {
    const db = await openDb()
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, 'readonly')
      const request = transaction.objectStore(AUDIO_STORE).get(attemptId)
      request.onsuccess = () => resolve(request.result as Blob | undefined)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return blob ?? null
  } catch {
    return null
  }
}

export async function clearWorkspace(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([WORKSPACE_STORE, AUDIO_STORE], 'readwrite')
      transaction.objectStore(WORKSPACE_STORE).clear()
      transaction.objectStore(AUDIO_STORE).clear()
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // 清理失败时继续删除 localStorage 备份。
  }
  localStorage.removeItem(FALLBACK_KEY)
  localStorage.removeItem(LEGACY_FALLBACK_KEY)
}
