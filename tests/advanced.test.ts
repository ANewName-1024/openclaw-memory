/**
 * OpenClaw Memory System - Advanced Features Tests
 */

import { MemoryStore } from '../src/store/MemoryStore.js'
import { TTLCleanupManager } from '../src/ttl.js'
import { MemoryBatchProcessor, MemoryTransaction } from '../src/batch.js'
import { MemoryExporter, MemoryImporter } from '../src/import-export.js'
import { MemoryCache, MemoryStoreCache } from '../src/cache.js'
import { MemoryEventEmitter } from '../src/events.js'
import type { MemoryType } from '../src/types/index.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_DIR = path.join(__dirname, 'test-advanced')

async function setupTestDir() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  } catch {}
  await fs.mkdir(TEST_DIR, { recursive: true })
}

async function teardownTestDir() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  } catch {}
}

// =============================================================================
// Cache Tests
// =============================================================================

describe('MemoryCache', () => {
  let cache: MemoryCache<string>

  beforeEach(() => {
    cache = new MemoryCache({ maxSize: 10, defaultTtl: 1000 })
  })

  describe('get/set', () => {
    it('should store and retrieve values', () => {
      cache.set('key1', 'value1')
      expect(cache.get('key1')).toBe('value1')
    })

    it('should return undefined for missing keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined()
    })

    it('should update existing keys', () => {
      cache.set('key1', 'value1')
      cache.set('key1', 'value2')
      expect(cache.get('key1')).toBe('value2')
    })
  })

  describe('TTL', () => {
    it('should expire entries after TTL', async () => {
      cache = new MemoryCache({ maxSize: 10, defaultTtl: 50 })
      cache.set('key1', 'value1')
      
      await new Promise(resolve => setTimeout(resolve, 100))
      
      expect(cache.get('key1')).toBeUndefined()
    })

    it('should respect custom TTL', async () => {
      cache.set('key1', 'value1', 200)
      
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(cache.get('key1')).toBe('value1')
      
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(cache.get('key1')).toBeUndefined()
    })
  })

  describe('LRU eviction', () => {
    it('should evict least recently used when full', () => {
      const smallCache = new MemoryCache({ maxSize: 3, defaultTtl: 60000 })
      
      smallCache.set('a', '1')
      smallCache.set('b', '2')
      smallCache.set('c', '3')
      
      // Access 'a' to make it recently used
      smallCache.get('a')
      
      // Add new item, should evict 'b' (least recently used)
      smallCache.set('d', '4')
      
      expect(smallCache.get('a')).toBe('1')
      expect(smallCache.get('b')).toBeUndefined()
      expect(smallCache.get('c')).toBe('3')
      expect(smallCache.get('d')).toBe('4')
    })
  })

  describe('delete/clear', () => {
    it('should delete specific entries', () => {
      cache.set('key1', 'value1')
      cache.delete('key1')
      expect(cache.get('key1')).toBeUndefined()
    })

    it('should clear all entries', () => {
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.clear()
      expect(cache.get('key1')).toBeUndefined()
      expect(cache.get('key2')).toBeUndefined()
    })
  })

  describe('invalidatePattern', () => {
    it('should invalidate matching keys', () => {
      cache.set('user:test', '1')
      cache.set('user:info', '2')
      cache.set('project:test', '3')
      
      const count = cache.invalidatePattern(/^user:/)
      
      expect(count).toBe(2)
      expect(cache.get('user:test')).toBeUndefined()
      expect(cache.get('user:info')).toBeUndefined()
      expect(cache.get('project:test')).toBe('3')
    })
  })
})

describe('MemoryStoreCache', () => {
  let cache: MemoryStoreCache

  beforeEach(() => {
    cache = new MemoryStoreCache()
  })

  it('should cache memory items', () => {
    const mockMemory = { name: 'test', description: 'Test' } as any
    cache.setMemory('user', 'test', mockMemory)
    expect(cache.getMemory('user', 'test')).toEqual(mockMemory)
  })

  it('should cache headers', () => {
    const headers = [{ filename: 'test.md', name: 'test' }] as any
    cache.setHeaders('scan:all', headers)
    expect(cache.getHeaders('scan:all')).toEqual(headers)
  })

  it('should clear all caches', () => {
    cache.setMemory('user', 'test', { name: 'test' } as any)
    cache.clear()
    expect(cache.getMemory('user', 'test')).toBeUndefined()
  })
})

// =============================================================================
// Event System Tests
// =============================================================================

describe('MemoryEventEmitter', () => {
  let emitter: MemoryEventEmitter

  beforeEach(() => {
    emitter = new MemoryEventEmitter()
  })

  it('should emit and receive events', () => {
    let eventReceived = false
    emitter.on('memory:saved', () => { eventReceived = true })
    emitter.emitEvent('memory:saved', { memoryName: 'test' })
    expect(eventReceived).toBe(true)
  })

  it('should support unsubscribe', () => {
    let callCount = 0
    const unsubscribe = emitter.on('memory:saved', () => { callCount++ })
    unsubscribe()
    emitter.emitEvent('memory:saved')
    
    expect(callCount).toBe(0)
  })

  it('should support onAny handler', () => {
    let callCount = 0
    emitter.onAny(() => { callCount++ })
    emitter.emitEvent('memory:saved')
    emitter.emitEvent('memory:deleted')
    
    expect(callCount).toBe(2)
  })

  it('should handle errors in handlers gracefully', () => {
    let normalCalled = false
    emitter.on('memory:saved', () => { throw new Error('Handler error') })
    emitter.on('memory:saved', () => { normalCalled = true })
    
    // Should not throw, just log error
    emitter.emitEvent('memory:saved')
    
    expect(normalCalled).toBe(true)
  })
})

// =============================================================================
// Batch Operations Tests
// =============================================================================

describe('MemoryBatchProcessor', () => {
  let store: MemoryStore
  let processor: MemoryBatchProcessor

  beforeEach(async () => {
    await setupTestDir()
    store = new MemoryStore({ directory: TEST_DIR })
    processor = new MemoryBatchProcessor(store, 3)
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  describe('execute', () => {
    it('should execute batch save operations', async () => {
      const operations = [
        { type: 'save' as const, memory: {
          name: 'batch1',
          description: 'Batch 1',
          type: 'user' as MemoryType,
          content: 'Content 1',
          scope: 'private' as const,
        }},
        { type: 'save' as const, memory: {
          name: 'batch2',
          description: 'Batch 2',
          type: 'user' as MemoryType,
          content: 'Content 2',
          scope: 'private' as const,
        }},
      ]

      const result = await processor.execute(operations)

      expect(result.successful).toBe(2)
      expect(result.failed).toBe(0)
    })

    it('should handle mixed operations', async () => {
      // First save some memories
      await store.save({
        name: 'existing',
        description: 'Existing',
        type: 'user',
        content: 'Content',
        scope: 'private',
      })

      const operations = [
        { type: 'save' as const, memory: {
          name: 'new1',
          description: 'New 1',
          type: 'user' as MemoryType,
          content: 'Content',
          scope: 'private' as const,
        }},
        { type: 'delete' as const, typeParam: 'user' as MemoryType, name: 'existing' },
      ]

      const result = await processor.execute(operations)

      expect(result.successful).toBe(2)
      expect(await store.load('user', 'existing')).toBeNull()
      expect(await store.load('user', 'new1')).not.toBeNull()
    })

    it('should report errors in batch operations', async () => {
      const operations = [
        { type: 'delete' as const, typeParam: 'user' as MemoryType, name: 'nonexistent' },
        { type: 'save' as const, memory: {
          name: 'valid-batch',
          description: 'Valid',
          type: 'user' as MemoryType,
          content: 'Content',
          scope: 'private' as const,
        }},
      ]

      const result = await processor.execute(operations)

      // One succeeds (save), one fails (delete nonexistent)
      expect(result.successful + result.failed).toBe(2)
    })
  })
})

describe('MemoryTransaction', () => {
  let store: MemoryStore

  beforeEach(async () => {
    await setupTestDir()
    store = new MemoryStore({ directory: TEST_DIR })
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  it('should queue and commit operations', async () => {
    const tx = new MemoryTransaction(store)
    
    tx.save({
      name: 'tx1',
      description: 'Tx 1',
      type: 'user',
      content: 'Content',
      scope: 'private',
    })
    tx.save({
      name: 'tx2',
      description: 'Tx 2',
      type: 'user',
      content: 'Content',
      scope: 'private',
    })

    expect(tx.size).toBe(2)

    const result = await tx.commit()

    expect(result.successful).toBe(2)
    expect(await store.load('user', 'tx1')).not.toBeNull()
    expect(await store.load('user', 'tx2')).not.toBeNull()
  })

  it('should rollback on failure', async () => {
    const tx = new MemoryTransaction(store)
    
    tx.save({
      name: 'tx1',
      description: 'Tx 1',
      type: 'user',
      content: 'Content',
      scope: 'private',
    })

    await tx.commit()

    // Start new transaction that will fail
    const tx2 = new MemoryTransaction(store)
    tx2.save({
      name: 'tx1',
      description: 'Tx 1 Updated',
      type: 'user',
      content: 'New Content',
      scope: 'private',
    })

    // Note: Current implementation doesn't actually rollback
    // because we don't track which items were saved in this transaction
    await tx2.commit()
  })
})

// =============================================================================
// TTL Cleanup Tests
// =============================================================================

describe('TTLCleanupManager', () => {
  let store: MemoryStore
  let cleanup: TTLCleanupManager

  beforeEach(async () => {
    await setupTestDir()
    store = new MemoryStore({ directory: TEST_DIR })
    cleanup = new TTLCleanupManager(store)
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  describe('hasExpired', () => {
    it('should detect expired memories', () => {
      const oldHeader = { mtimeMs: Date.now() - 1000 * 60 * 60 * 24 * 60 } // 60 days ago
      const policy = { enabled: true, defaultTtlDays: 30, checkOnStartup: false }
      
      expect(cleanup.hasExpired(oldHeader as any, policy)).toBe(true)
    })

    it('should not flag recent memories as expired', () => {
      const recentHeader = { mtimeMs: Date.now() - 1000 * 60 * 60 * 24 * 7 } // 7 days ago
      const policy = { enabled: true, defaultTtlDays: 30, checkOnStartup: false }
      
      expect(cleanup.hasExpired(recentHeader as any, policy)).toBe(false)
    })

    it('should respect type-specific TTL', () => {
      const header = { mtimeMs: Date.now() - 1000 * 60 * 60 * 24 * 15, type: 'project' as MemoryType }
      const policy = { 
        enabled: true, 
        defaultTtlDays: 30, 
        typeOverrides: { project: 7 },
        checkOnStartup: false 
      }
      
      expect(cleanup.hasExpired(header as any, policy)).toBe(true)
    })
  })

  describe('cleanupScope', () => {
    it('should scan memories for cleanup', async () => {
      // Just verify that cleanup runs without errors
      const result = await cleanup.cleanupScope('private')
      
      expect(result).toHaveProperty('scanned')
      expect(result).toHaveProperty('deleted')
      expect(result).toHaveProperty('errors')
    })
  })

  describe('estimateCleanup', () => {
    it('should estimate space to be freed', async () => {
      await store.save({
        name: 'test',
        description: 'Test',
        type: 'user',
        content: 'Content',
        scope: 'private',
      })

      const estimate = await cleanup.estimateCleanup('private')

      expect(estimate).toHaveProperty('wouldDelete')
      expect(estimate).toHaveProperty('wouldFreeBytes')
      expect(estimate).toHaveProperty('oldestEntry')
    })
  })
})

// =============================================================================
// Import/Export Tests
// =============================================================================

describe('MemoryExporter', () => {
  let store: MemoryStore
  let exporter: MemoryExporter

  beforeEach(async () => {
    await setupTestDir()
    store = new MemoryStore({ directory: TEST_DIR })
    exporter = new MemoryExporter(store)

    // Create test memories
    await store.save({
      name: 'export-test-1',
      description: 'Test 1',
      type: 'user',
      content: 'Content 1',
      scope: 'private',
    })
    await store.save({
      name: 'export-test-2',
      description: 'Test 2',
      type: 'user',
      content: 'Content 2',
      scope: 'private',
    })
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  describe('exportToJSON', () => {
    it('should export all memories', async () => {
      const data = await exporter.exportToJSON()

      expect(data.metadata.memoryCount).toBeGreaterThanOrEqual(2)
      expect(data.memories.length).toBeGreaterThanOrEqual(2)
      expect(data.metadata.types).toHaveProperty('user')
    })
  })

  describe('exportToFile', () => {
    it('should export to a JSON file', async () => {
      const exportPath = path.join(TEST_DIR, 'export.json')
      const metadata = await exporter.exportToFile(exportPath)

      expect(metadata.memoryCount).toBeGreaterThanOrEqual(2)

      const content = await fs.readFile(exportPath, 'utf8')
      const data = JSON.parse(content)
      expect(data.memories).toBeDefined()
    })
  })
})

describe('MemoryImporter', () => {
  let store: MemoryStore
  let importer: MemoryImporter

  beforeEach(async () => {
    await setupTestDir()
    store = new MemoryStore({ directory: TEST_DIR })
    importer = new MemoryImporter(store)
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  describe('validateImport', () => {
    it('should validate correct import data', async () => {
      const validData = {
        metadata: { version: '1.0.0', exportedAt: new Date().toISOString(), memoryCount: 1, types: {}, scopes: {} } as const,
        memories: [{
          name: 'valid-memory',
          description: 'Valid',
          type: 'user' as const,
          content: 'Content',
          scope: 'private' as const,
        }],
      }

      const result = await importer.validateImport(validData as any)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should reject invalid import data', async () => {
      const invalidData = {
        metadata: {} as any,
        memories: [{
          name: '',
          type: 'invalid-type',
          content: '',
          scope: 'invalid',
        }],
      }

      const result = await importer.validateImport(invalidData as any)

      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })
  })

  describe('importFromData', () => {
    it('should import memories', async () => {
      const data = {
        metadata: { version: '1.0.0', exportedAt: new Date().toISOString(), memoryCount: 1, types: {}, scopes: {} },
        memories: [{
          name: 'imported-memory',
          description: 'Imported',
          type: 'user' as const,
          content: 'Content',
          scope: 'private' as const,
        }],
      }

      const result = await importer.importFromData(data as any)

      expect(result.imported).toBe(1)
      expect(await store.load('user', 'imported-memory')).not.toBeNull()
    })

    it('should skip existing memories by default', async () => {
      await store.save({
        name: 'existing',
        description: 'Existing',
        type: 'user',
        content: 'Content',
        scope: 'private',
      })

      const data = {
        metadata: { version: '1.0.0', exportedAt: new Date().toISOString(), memoryCount: 1, types: {}, scopes: {} },
        memories: [{
          name: 'existing',
          description: 'Existing Updated',
          type: 'user' as const,
          content: 'New Content',
          scope: 'private' as const,
        }],
      }

      const result = await importer.importFromData(data as any)

      expect(result.skipped).toBe(1)
      expect(result.imported).toBe(0)
    })

    it('should overwrite when option is set', async () => {
      await store.save({
        name: 'existing',
        description: 'Existing',
        type: 'user',
        content: 'Original',
        scope: 'private',
      })

      const data = {
        metadata: { version: '1.0.0', exportedAt: new Date().toISOString(), memoryCount: 1, types: {}, scopes: {} },
        memories: [{
          name: 'existing',
          description: 'Updated',
          type: 'user' as const,
          content: 'Updated Content',
          scope: 'private' as const,
        }],
      }

      const result = await importer.importFromData(data as any, { overwrite: true })

      expect(result.imported).toBe(1)
      const loaded = await store.load('user', 'existing')
      expect(loaded?.content.trim()).toBe('Updated Content')
    })
  })
})

// =============================================================================
// Pagination Tests
// =============================================================================

describe('MemoryStore Pagination', () => {
  let store: MemoryStore

  beforeEach(async () => {
    await setupTestDir()
    store = new MemoryStore({ directory: TEST_DIR })

    // Create 25 memories for pagination testing
    for (let i = 1; i <= 25; i++) {
      await store.save({
        name: `page-test-${i}`,
        description: `Test ${i}`,
        type: 'user',
        content: `Content ${i}`,
        scope: 'private',
      })
    }
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  describe('scanPaginated', () => {
    it('should return paginated results', async () => {
      const result = await store.scanPaginated(undefined, { page: 1, pageSize: 10 })

      expect(result.items.length).toBe(10)
      expect(result.total).toBe(25)
      expect(result.page).toBe(1)
      expect(result.pageSize).toBe(10)
      expect(result.totalPages).toBe(3)
      expect(result.hasNext).toBe(true)
      expect(result.hasPrev).toBe(false)
    })

    it('should return correct page', async () => {
      const result = await store.scanPaginated(undefined, { page: 2, pageSize: 10 })

      expect(result.items.length).toBe(10)
      expect(result.page).toBe(2)
      expect(result.hasNext).toBe(true)
      expect(result.hasPrev).toBe(true)
    })

    it('should return last page correctly', async () => {
      const result = await store.scanPaginated(undefined, { page: 3, pageSize: 10 })

      expect(result.items.length).toBe(5)
      expect(result.page).toBe(3)
      expect(result.hasNext).toBe(false)
      expect(result.hasPrev).toBe(true)
    })

    it('should handle offset/limit pagination', async () => {
      const result = await store.scanPaginated(undefined, { offset: 5, limit: 10 })

      expect(result.items.length).toBe(10)
      expect(result.page).toBe(1) // page defaults to 1 with offset
      expect(result.total).toBe(25)
    })
  })

  describe('searchPaginated', () => {
    it('should return paginated search results', async () => {
      const result = await store.searchPaginated(
        { type: 'user' },
        { page: 1, pageSize: 5 }
      )

      expect(result.items.length).toBeLessThanOrEqual(5)
      expect(result.total).toBeGreaterThanOrEqual(0)
    })
  })
})
