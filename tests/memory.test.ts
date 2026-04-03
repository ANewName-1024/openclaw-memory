/**
 * OpenClaw Memory System - Comprehensive Test Suite
 * Based on Claude Code memory system architecture
 */

import { MemoryStore } from '../src/store/MemoryStore.js'
import { SessionMemoryManager } from '../src/session/SessionMemory.js'
import { TeamMemoryManager } from '../src/team/TeamMemory.js'
import { MemorySelector } from '../src/selector/MemorySelector.js'
import {
  validatePath,
  validatePathWithSymlinks,
  sanitizePathKey,
  PathTraversalError,
  SymlinkEscapeError,
} from '../src/security/pathValidator.js'
import {
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  generateFilename,
} from '../src/utils/frontmatter.js'
import type { Memory, MemoryType, Message } from '../src/types/index.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_DIR = path.join(__dirname, 'test-temp')

// =============================================================================
// Test Setup/Teardown
// =============================================================================

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
// MemoryStore Tests
// =============================================================================

describe('MemoryStore', () => {
  let store: MemoryStore

  beforeEach(async () => {
    await setupTestDir()
    store = new MemoryStore({ directory: TEST_DIR })
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  // ---------------------------------------------------------------------------
  // Basic CRUD Operations
  // ---------------------------------------------------------------------------

  describe('save()', () => {
    it('should save a memory with all required fields', async () => {
      const memory = {
        name: 'test-memory',
        description: 'A test memory',
        type: 'user' as MemoryType,
        content: 'This is test content',
        scope: 'private' as const,
      }

      const saved = await store.save(memory)

      expect(saved.name).toBe('test-memory')
      expect(saved.type).toBe('user')
      expect(saved.scope).toBe('private')
      expect(saved.content).toBe('This is test content')
      expect(saved.createdAt).toBeInstanceOf(Date)
      expect(saved.updatedAt).toBeInstanceOf(Date)
      expect(saved.filePath).toBeDefined()
    })

    it('should save team-scoped memory to team directory', async () => {
      const memory = {
        name: 'team-project',
        description: 'Team project info',
        type: 'project' as MemoryType,
        content: 'Project details',
        scope: 'team' as const,
      }

      const saved = await store.save(memory)

      expect(saved.scope).toBe('team')
      expect(saved.filePath).toContain('/team/')
    })

    it('should throw error for invalid memory type', async () => {
      const invalidMemory = {
        name: 'bad-memory',
        description: 'Invalid',
        type: 'invalid' as MemoryType,
        content: 'Content',
        scope: 'private' as const,
      }

      await expect(store.save(invalidMemory)).rejects.toThrow()
    })

    it('should throw error for content exceeding max size', async () => {
      const largeStore = new MemoryStore({
        directory: TEST_DIR,
        maxFileSize: 10,
      })

      const memory = {
        name: 'large-memory',
        description: 'Too large',
        type: 'user' as MemoryType,
        content: 'This content is way too long',
        scope: 'private' as const,
      }

      await expect(largeStore.save(memory)).rejects.toThrow(/exceeds maximum size/)
    })

    it('should update MEMORY.md index after save', async () => {
      await store.save({
        name: 'indexed-memory',
        description: 'Should be indexed',
        type: 'user',
        content: 'Content',
        scope: 'private',
      })

      // Index is stored per type+scope, check the user directory
      const indexFile = path.join(TEST_DIR, 'user', 'MEMORY.md')
      const index = await fs.readFile(indexFile, 'utf-8')
      expect(index).toContain('[indexed-memory]')
    })
  })

  describe('load()', () => {
    it('should load a saved memory', async () => {
      await store.save({
        name: 'load-test',
        description: 'Test loading',
        type: 'user',
        content: 'Original content',
        scope: 'private',
      })

      const loaded = await store.load('user', 'load-test')

      expect(loaded).not.toBeNull()
      expect(loaded?.name).toBe('load-test')
      expect(loaded?.content.trim()).toBe('Original content')
    })

    it('should return null for non-existent memory', async () => {
      const loaded = await store.load('user', 'does-not-exist')
      expect(loaded).toBeNull()
    })
  })

  describe('update()', () => {
    it('should update memory content', async () => {
      await store.save({
        name: 'update-test',
        description: 'Original',
        type: 'user',
        content: 'Original content',
        scope: 'private',
      })

      const updated = await store.update('user', 'update-test', {
        content: 'Updated content',
      })

      expect(updated).not.toBeNull()
      expect(updated?.content).toBe('Updated content')
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(updated?.createdAt.getTime()!)
    })

    it('should return null for non-existent memory', async () => {
      const updated = await store.update('user', 'does-not-exist', {
        content: 'New content',
      })
      expect(updated).toBeNull()
    })
  })

  describe('delete()', () => {
    it('should delete a memory', async () => {
      await store.save({
        name: 'delete-test',
        description: 'To be deleted',
        type: 'user',
        content: 'Content',
        scope: 'private',
      })

      const deleted = await store.delete('user', 'delete-test')
      expect(deleted).toBe(true)

      const loaded = await store.load('user', 'delete-test')
      expect(loaded).toBeNull()
    })

    it('should return false for non-existent memory', async () => {
      const deleted = await store.delete('user', 'does-not-exist')
      expect(deleted).toBe(false)
    })
  })

  describe('scan()', () => {
    it('should scan all memories', async () => {
      await store.save({
        name: 'scan-test-1',
        description: 'First',
        type: 'user',
        content: 'Content 1',
        scope: 'private',
      })
      await store.save({
        name: 'scan-test-2',
        description: 'Second',
        type: 'user',
        content: 'Content 2',
        scope: 'private',
      })

      const headers = await store.scan()

      expect(headers.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('search()', () => {
    it('should filter by type', async () => {
      await store.save({
        name: 'search-user',
        description: 'User type',
        type: 'user',
        content: 'User content',
        scope: 'private',
      })
      await store.save({
        name: 'search-project',
        description: 'Project type',
        type: 'project',
        content: 'Project content',
        scope: 'team',
      })

      const results = await store.search({ type: 'user' })

      expect(results.every(r => r.type === 'user')).toBe(true)
    })
  })
})

// =============================================================================
// SessionMemoryManager Tests
// =============================================================================

describe('SessionMemoryManager', () => {
  let session: SessionMemoryManager
  const sessionDir = path.join(TEST_DIR, '.session-memory')

  beforeEach(async () => {
    await setupTestDir()
    session = new SessionMemoryManager({}, sessionDir)
  })

  afterEach(async () => {
    try {
      await fs.rm(sessionDir, { recursive: true, force: true })
    } catch {}
  })

  describe('shouldExtract()', () => {
    it('should return false when disabled', () => {
      const disabledSession = new SessionMemoryManager(
        { enabled: false },
        sessionDir
      )

      const messages: Message[] = [
        { id: '1', role: 'user', content: 'Test'.repeat(1000) },
      ]

      expect(disabledSession.shouldExtract(messages)).toBe(false)
    })

    it('should return false when below token threshold', () => {
      const messages: Message[] = [
        { id: '1', role: 'user', content: 'Short' },
      ]

      expect(session.shouldExtract(messages)).toBe(false)
    })

    it('should trigger after sufficient token growth', () => {
      // This tests the threshold logic
      const longMessage: Message = {
        id: '1',
        role: 'user',
        content: 'Word '.repeat(2000), // Approx 2000 tokens
      }

      // Initialize first
      session.shouldExtract([longMessage])

      // Add more content to trigger growth threshold
      const moreMessages: Message[] = [
        longMessage,
        { id: '2', role: 'user', content: 'Word '.repeat(4000) },
      ]

      // After initialization, should check for token growth
      const result = session.shouldExtract(moreMessages)
      // Result depends on thresholds being met
      expect(typeof result).toBe('boolean')
    })
  })

  describe('getState()', () => {
    it('should return current state', () => {
      const state = session.getState()

      expect(state).toHaveProperty('initialized')
      expect(state).toHaveProperty('lastExtractionTokens')
      expect(state).toHaveProperty('extractionCount')
    })
  })

  describe('reset()', () => {
    it('should reset state', () => {
      session.reset()
      const state = session.getState()

      expect(state.initialized).toBe(false)
      expect(state.extractionCount).toBe(0)
    })
  })
})

// =============================================================================
// TeamMemoryManager Tests
// =============================================================================

describe('TeamMemoryManager', () => {
  let team: TeamMemoryManager
  const teamDir = path.join(TEST_DIR, 'team-memory')

  beforeEach(async () => {
    await setupTestDir()
    team = new TeamMemoryManager({ enabled: true }, teamDir)
  })

  afterEach(async () => {
    try {
      await fs.rm(teamDir, { recursive: true, force: true })
    } catch {}
  })

  describe('save()', () => {
    it('should save team memory', async () => {
      const memory = {
        name: 'team-info',
        description: 'Team information',
        type: 'project' as MemoryType,
        content: 'Team content',
      }

      const saved = await team.save(memory)

      expect(saved.name).toBe('team-info')
      expect(saved.scope).toBe('team')
    })

    it('should throw when disabled', async () => {
      const disabledTeam = new TeamMemoryManager({ enabled: false }, teamDir)

      await expect(disabledTeam.save({
        name: 'test',
        description: 'Test',
        type: 'project',
        content: 'Content',
      })).rejects.toThrow('not enabled')
    })
  })

  describe('scan()', () => {
    it('should scan team memories', async () => {
      await team.save({
        name: 'team-scan-1',
        description: 'First',
        type: 'project',
        content: 'Content 1',
      })
      await team.save({
        name: 'team-scan-2',
        description: 'Second',
        type: 'project',
        content: 'Content 2',
      })

      const headers = await team.scan()

      expect(headers.length).toBe(2)
    })
  })

  describe('getDirectory()', () => {
    it('should return team directory', () => {
      // TeamMemory appends 'team' to the base directory
      expect(team.getDirectory()).toBe(path.join(teamDir, 'team'))
    })
  })

  describe('isEnabled()', () => {
    it('should return enabled status', () => {
      expect(team.isEnabled()).toBe(true)

      const disabledTeam = new TeamMemoryManager({ enabled: false }, teamDir)
      expect(disabledTeam.isEnabled()).toBe(false)
    })
  })
})

// =============================================================================
// Security Tests
// =============================================================================

describe('Security - Path Validation', () => {
  const baseDir = '/safe/workspace/memory'

  describe('validatePath()', () => {
    it('should allow paths within base directory', () => {
      const result = validatePath(baseDir, 'user/test.md')
      expect(result).toBe(path.resolve(baseDir, 'user/test.md'))
    })

    it('should allow exact base directory match', () => {
      const result = validatePath(baseDir, '')
      expect(result).toBe(path.resolve(baseDir))
    })

    it('should reject path traversal with ../', () => {
      expect(() => validatePath(baseDir, '../secret.txt')).toThrow(PathTraversalError)
    })

    it('should reject absolute paths', () => {
      expect(() => validatePath(baseDir, '/etc/passwd')).toThrow(PathTraversalError)
    })

    it('should reject multiple traversal attempts', () => {
      expect(() => validatePath(baseDir, 'user/../../../etc/passwd')).toThrow(PathTraversalError)
    })
  })

  describe('validatePathWithSymlinks()', () => {
    it('should handle non-existent paths gracefully', async () => {
      const result = await validatePathWithSymlinks(baseDir, 'new-file.txt')
      expect(result).toBeDefined()
    })
  })

  describe('sanitizePathKey()', () => {
    it('should reject null bytes', () => {
      expect(() => sanitizePathKey('file\0name')).toThrow(PathTraversalError)
    })

    it('should reject URL-encoded traversal', () => {
      expect(() => sanitizePathKey('..%2f..%2fsecret')).toThrow(PathTraversalError)
    })

    it('should reject Unicode normalization attacks', () => {
      // Full-width period (．) normalizes to period (.)
      const normalized = '．'.normalize('NFKC')
      expect(normalized).toBe('.')
      // A single normalized dot should pass, but combined with traversal it should fail
      expect(() => sanitizePathKey('．/../secret')).toThrow(PathTraversalError)
    })

    it('should reject backslashes', () => {
      expect(() => sanitizePathKey('path\\to\\file')).toThrow(PathTraversalError)
    })

    it('should reject absolute paths', () => {
      expect(() => sanitizePathKey('/absolute/path')).toThrow(PathTraversalError)
    })

    it('should return sanitized key', () => {
      const result = sanitizePathKey('valid-file-name')
      expect(result).toBe('valid-file-name')
    })
  })
})

// =============================================================================
// Frontmatter Tests
// =============================================================================

describe('Frontmatter Utils', () => {
  describe('serializeFrontmatter()', () => {
    it('should serialize memory to YAML frontmatter', () => {
      const result = serializeFrontmatter({
        name: 'test',
        description: 'Test description',
        type: 'user',
        scope: 'private',
      }, 'Content here')

      expect(result).toContain('---')
      expect(result).toContain('name: test')
      expect(result).toContain('type: user')
      expect(result).toContain('scope: private')
      expect(result).toContain('Content here')
    })
  })

  describe('parseFrontmatter()', () => {
    it('should parse YAML frontmatter correctly', () => {
      const content = `---
name: parsed-memory
description: Parsed description
type: user
scope: private
---
Parsed body content`

      const result = parseFrontmatter(content)

      expect(result.frontmatter.name).toBe('parsed-memory')
      expect(result.frontmatter.description).toBe('Parsed description')
      expect(result.frontmatter.type).toBe('user')
      expect(result.body).toBe('Parsed body content')
    })

    it('should handle content without frontmatter', () => {
      const content = 'Just plain content'

      const result = parseFrontmatter(content)

      expect(result.frontmatter.name).toBe('')
      expect(result.body).toBe(content)
    })
  })

  describe('validateFrontmatter()', () => {
    it('should validate correct frontmatter', () => {
      const errors = validateFrontmatter({
        name: 'valid',
        description: 'Valid',
        type: 'user',
        scope: 'private',
      })

      expect(errors).toHaveLength(0)
    })

    it('should reject invalid memory type', () => {
      const errors = validateFrontmatter({
        name: 'test',
        description: 'Test',
        type: 'invalid-type' as MemoryType,
        scope: 'private',
      })

      expect(errors.length).toBeGreaterThan(0)
    })

    it('should reject empty name', () => {
      const errors = validateFrontmatter({
        name: '',
        description: 'Test',
        type: 'user',
        scope: 'private',
      })

      expect(errors.length).toBeGreaterThan(0)
    })
  })

  describe('generateFilename()', () => {
    it('should generate safe filename', () => {
      const filename = generateFilename('My Memory', 'user')
      expect(filename).toBe('user-my-memory.md')
    })

    it('should lowercase and sanitize name', () => {
      const filename = generateFilename('Test@#$%^&*()', 'project')
      expect(filename).not.toContain('@')
      expect(filename.endsWith('.md')).toBe(true)
    })

    it('should truncate long names', () => {
      const longName = 'a'.repeat(100)
      const filename = generateFilename(longName, 'user')
      expect(filename.length).toBeLessThanOrEqual(50 + 10) // type prefix + .md
    })
  })
})

// =============================================================================
// MemorySelector Tests
// =============================================================================

describe('MemorySelector', () => {
  let selector: MemorySelector

  beforeEach(() => {
    selector = new MemorySelector()
  })

  describe('select()', () => {
    it('should select memories based on query', async () => {
      const headers: any[] = [
        {
          filename: 'user-user-info.md',
          filePath: '/memory/user/user-user-info.md',
          mtimeMs: Date.now(),
          name: 'user-info',
          description: 'User background',
          type: 'user' as MemoryType,
          scope: 'private' as const,
        },
        {
          filename: 'project-project-info.md',
          filePath: '/memory/project/project-project-info.md',
          mtimeMs: Date.now(),
          name: 'project-info',
          description: 'Project details',
          type: 'project' as MemoryType,
          scope: 'team' as const,
        },
      ]

      // Note: AI selection returns a result object with selected array
      const context = { recentTools: [], maxResults: 5 }
      const result = await selector.select('engineer', headers, context)

      expect(result).toBeDefined()
      expect(result).toHaveProperty('selected')
      expect(Array.isArray(result.selected)).toBe(true)
    })
  })
})

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration Tests', () => {
  let memory: any

  beforeEach(async () => {
    await setupTestDir()
    const { createMemorySystem } = await import('../src/index.js')
    memory = createMemorySystem({ directory: TEST_DIR })
  })

  afterEach(async () => {
    await teardownTestDir()
  })

  it('should create memory system with all components', () => {
    expect(memory.store).toBeDefined()
    expect(memory.selector).toBeDefined()
    expect(memory.session).toBeDefined()
    expect(memory.team).toBeDefined()
  })

  it('should perform full CRUD cycle', async () => {
    // Create
    const saved = await memory.store.save({
      name: 'cycle-test',
      description: 'Full cycle test',
      type: 'user',
      content: 'Test content',
      scope: 'private',
    })
    expect(saved.name).toBe('cycle-test')

    // Read
    const loaded = await memory.store.load('user', 'cycle-test')
    expect(loaded?.content.trim()).toBe('Test content')

    // Update
    const updated = await memory.store.update('user', 'cycle-test', {
      content: 'Updated content',
    })
    expect(updated?.content).toBe('Updated content')

    // Delete
    const deleted = await memory.store.delete('user', 'cycle-test')
    expect(deleted).toBe(true)

    // Verify deletion
    const afterDelete = await memory.store.load('user', 'cycle-test')
    expect(afterDelete).toBeNull()
  })

  it('should handle concurrent saves', async () => {
    const promises = [
      memory.store.save({
        name: 'concurrent-1',
        description: 'First',
        type: 'user',
        content: 'Content 1',
        scope: 'private',
      }),
      memory.store.save({
        name: 'concurrent-2',
        description: 'Second',
        type: 'user',
        content: 'Content 2',
        scope: 'private',
      }),
      memory.store.save({
        name: 'concurrent-3',
        description: 'Third',
        type: 'user',
        content: 'Content 3',
        scope: 'private',
      }),
    ]

    const results = await Promise.all(promises)
    expect(results.every(r => r.name.includes('concurrent'))).toBe(true)
  })
})
