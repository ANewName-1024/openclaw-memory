/**
 * TTL Cleanup - Automatic expiration and cleanup of old memories
 */

import type { MemoryConfig, MemoryHeader } from './types/index.js'
import { MemoryStore } from './store/MemoryStore.js'

export interface TTLCleanupResult {
  scanned: number
  deleted: number
  errors: Error[]
  duration: number // ms
}

export interface TTLCleanupPolicy {
  enabled: boolean
  defaultTtlDays: number
  typeOverrides?: Partial<Record<string, number>> // days per type
  checkOnStartup: boolean
  maxAge?: number // absolute max age in days
}

/**
 * TTL-based memory cleanup
 */
export class TTLCleanupManager {
  private store: MemoryStore
  private policies: Map<string, TTLCleanupPolicy> = new Map()
  private lastCleanup: Map<string, Date> = new Map()

  constructor(store: MemoryStore, policies?: TTLCleanupPolicy[]) {
    this.store = store
    this.policies.set('default', {
      enabled: true,
      defaultTtlDays: 30,
      checkOnStartup: false,
    })

    if (policies) {
      for (const policy of policies) {
        this.policies.set(policy.enabled ? 'default' : 'disabled', policy)
      }
    }
  }

  /**
   * Set cleanup policy for a scope
   */
  setPolicy(scope: string, policy: TTLCleanupPolicy): void {
    this.policies.set(scope, policy)
  }

  /**
   * Get policy for a scope
   */
  getPolicy(scope: string): TTLCleanupPolicy | undefined {
    return this.policies.get(scope)
  }

  /**
   * Check if a memory has expired based on its metadata
   */
  hasExpired(header: MemoryHeader, policy: TTLCleanupPolicy): boolean {
    const ageMs = Date.now() - header.mtimeMs
    const ageDays = ageMs / (1000 * 60 * 60 * 24)

    // Check absolute max age
    if (policy.maxAge && ageDays > policy.maxAge) {
      return true
    }

    // Check type-specific TTL
    const ttlDays = policy.typeOverrides?.[header.type ?? ''] ?? policy.defaultTtlDays

    return ageDays > ttlDays
  }

  /**
   * Run cleanup for a specific scope
   */
  async cleanupScope(scope: string = 'private'): Promise<TTLCleanupResult> {
    const startTime = Date.now()
    const result: TTLCleanupResult = {
      scanned: 0,
      deleted: 0,
      errors: [],
      duration: 0,
    }

    const policy = this.policies.get(scope)
    if (!policy || !policy.enabled) {
      result.duration = Date.now() - startTime
      return result
    }

    try {
      // Scan all memories
      const headers = await this.store.scan()

      for (const header of headers) {
        result.scanned++

        try {
          if (this.hasExpired(header, policy)) {
            if (header.name && header.type) {
              await this.store.delete(header.type, header.name)
              result.deleted++
            }
          }
        } catch (error) {
          result.errors.push(error as Error)
        }
      }

      this.lastCleanup.set(scope, new Date())
    } catch (error) {
      result.errors.push(error as Error)
    }

    result.duration = Date.now() - startTime
    return result
  }

  /**
   * Run cleanup for all scopes
   */
  async cleanupAll(): Promise<Map<string, TTLCleanupResult>> {
    const results = new Map<string, TTLCleanupResult>()

    for (const scope of ['private', 'team', 'both']) {
      results.set(scope, await this.cleanupScope(scope))
    }

    return results
  }

  /**
   * Get last cleanup time for a scope
   */
  getLastCleanup(scope: string): Date | undefined {
    return this.lastCleanup.get(scope)
  }

  /**
   * Estimate space that would be freed
   */
  async estimateCleanup(scope: string = 'private'): Promise<{
    wouldDelete: number
    wouldFreeBytes: number
    oldestEntry: Date | null
  }> {
    const policy = this.policies.get(scope)
    if (!policy) {
      return { wouldDelete: 0, wouldFreeBytes: 0, oldestEntry: null }
    }

    const headers = await this.store.scan()
    let wouldDelete = 0
    let wouldFreeBytes = 0
    let oldestEntry: Date | null = null

    for (const header of headers) {
      if (this.hasExpired(header, policy)) {
        wouldDelete++
        // Estimate ~500 bytes per memory file
        wouldFreeBytes += 500
        if (!oldestEntry || header.mtimeMs < oldestEntry.getTime()) {
          oldestEntry = new Date(header.mtimeMs)
        }
      }
    }

    return { wouldDelete, wouldFreeBytes, oldestEntry }
  }
}

/**
 * Scheduled cleanup runner
 */
export class ScheduledCleanup {
  private manager: TTLCleanupManager
  private intervalMs: number
  private running: boolean = false
  private timer: ReturnType<typeof setInterval> | null = null
  private onCleanup?: (results: Map<string, TTLCleanupResult>) => void | Promise<void>

  constructor(
    manager: TTLCleanupManager,
    intervalHours: number = 24,
    onCleanup?: (results: Map<string, TTLCleanupResult>) => void | Promise<void>
  ) {
    this.manager = manager
    this.intervalMs = intervalHours * 60 * 60 * 1000
    this.onCleanup = onCleanup
  }

  /**
   * Start scheduled cleanup
   */
  start(): void {
    if (this.running) return
    this.running = true

    // Run immediately
    this.run()

    // Schedule recurring runs
    this.timer = setInterval(() => {
      this.run()
    }, this.intervalMs)
  }

  /**
   * Stop scheduled cleanup
   */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Run cleanup now
   */
  async run(): Promise<Map<string, TTLCleanupResult>> {
    const results = await this.manager.cleanupAll()

    if (this.onCleanup) {
      try {
        await this.onCleanup(results)
      } catch (error) {
        console.error('Cleanup callback error:', error)
      }
    }

    return results
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running
  }
}
