/**
 * Cache Layer - In-memory cache for frequently accessed memories
 */

import type { Memory, MemoryHeader } from './types/index.js'

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number // time to live in ms
  accessCount: number
}

interface CacheConfig {
  maxSize: number
  defaultTtl: number // ms
  maxMemory: number // max bytes
}

/**
 * LRU Cache with TTL support
 */
export class MemoryCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map()
  private config: CacheConfig
  private totalSize: number = 0

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize ?? 100,
      defaultTtl: config.defaultTtl ?? 5 * 60 * 1000, // 5 minutes
      maxMemory: config.maxMemory ?? 10 * 1024 * 1024, // 10MB
    }
  }

  /**
   * Get item from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.delete(key)
      return undefined
    }

    // Update access count (for LRU)
    entry.accessCount++

    return entry.data
  }

  /**
   * Set item in cache
   */
  set(key: string, data: T, ttl?: number): void {
    // Calculate size (rough estimate)
    const size = this.estimateSize(data)

    // Evict if necessary
    while (
      (this.cache.size >= this.config.maxSize || 
       this.totalSize + size > this.config.maxMemory) &&
      this.cache.size > 0
    ) {
      this.evictLRU()
    }

    // Remove existing entry if present
    const existing = this.cache.get(key)
    if (existing) {
      this.totalSize -= this.estimateSize(existing.data)
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.config.defaultTtl,
      accessCount: 0,
    })
    this.totalSize += size
  }

  /**
   * Delete item from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key)
    if (entry) {
      this.totalSize -= this.estimateSize(entry.data)
      return this.cache.delete(key)
    }
    return false
  }

  /**
   * Check if key exists in cache (without TTL check)
   */
  has(key: string): boolean {
    return this.cache.has(key)
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear()
    this.totalSize = 0
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number
    itemCount: number
    totalSize: number
  } {
    return {
      size: this.cache.size,
      itemCount: this.cache.size,
      totalSize: this.totalSize,
    }
  }

  /**
   * Invalidate entries matching a pattern
   */
  invalidatePattern(pattern: RegExp): number {
    let count = 0
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.delete(key)
        count++
      }
    }
    return count
  }

  /**
   * Evict least recently used item
   */
  private evictLRU(): void {
    let lruKey: string | undefined
    let lruCount = Infinity

    for (const [key, entry] of this.cache) {
      if (entry.accessCount < lruCount) {
        lruCount = entry.accessCount
        lruKey = key
      }
    }

    if (lruKey) {
      this.delete(lruKey)
    }
  }

  /**
   * Estimate size of data in bytes
   */
  private estimateSize(data: T): number {
    try {
      return Buffer.byteLength(JSON.stringify(data), 'utf8')
    } catch {
      return 100 // default estimate
    }
  }
}

/**
 * Specialized cache for MemoryStore
 */
export class MemoryStoreCache {
  private headersCache: MemoryCache<MemoryHeader[]>
  private memoryCache: MemoryCache<Memory>

  constructor() {
    this.headersCache = new MemoryCache({ maxSize: 10, defaultTtl: 60 * 1000 })
    this.memoryCache = new MemoryCache({ maxSize: 50, defaultTtl: 5 * 60 * 1000 })
  }

  /**
   * Get cached headers for a scan result
   */
  getHeaders(key: string): MemoryHeader[] | undefined {
    return this.headersCache.get(key)
  }

  /**
   * Cache headers from a scan
   */
  setHeaders(key: string, headers: MemoryHeader[]): void {
    this.headersCache.set(key, headers)
  }

  /**
   * Get cached memory
   */
  getMemory(type: string, name: string): Memory | undefined {
    return this.memoryCache.get(`${type}:${name}`)
  }

  /**
   * Cache a memory
   */
  setMemory(type: string, name: string, memory: Memory): void {
    this.memoryCache.set(`${type}:${name}`, memory)
  }

  /**
   * Invalidate memory cache
   */
  invalidateMemory(type: string, name: string): void {
    this.memoryCache.delete(`${type}:${name}`)
  }

  /**
   * Invalidate all caches for a type
   */
  invalidateType(type: string): void {
    this.headersCache.invalidatePattern(new RegExp(`^${type}:`))
    this.memoryCache.invalidatePattern(new RegExp(`^${type}:`))
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.headersCache.clear()
    this.memoryCache.clear()
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      headers: this.headersCache.getStats(),
      memories: this.memoryCache.getStats(),
    }
  }
}
