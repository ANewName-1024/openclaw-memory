/**
 * MemoryStore - Core memory storage management
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import {
  parseFrontmatter,
  serializeFrontmatter,
  generateFilename,
  validateFrontmatter,
} from '../utils/frontmatter.js'
import {
  validatePath,
  validatePathWithSymlinks,
  PathTraversalError,
  validateFileSize,
} from '../security/pathValidator.js'
import type {
  Memory,
  MemoryHeader,
  MemoryType,
  MemoryScope,
  MemoryConfig,
  MemorySearchOptions,
} from '../types/index.js'
import {
  MEMORY_TYPES,
  DEFAULT_MEMORY_CONFIG,
} from '../types/index.js'

// =============================================================================
// MemoryStore
// =============================================================================

export class MemoryStore {
  private config: Required<MemoryConfig>
  private baseDir: string

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config } as Required<MemoryConfig>
    this.baseDir = this.config.directory
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  getDirectory(): string {
    return this.baseDir
  }

  setDirectory(dir: string): void {
    this.baseDir = dir
  }

  getConfig(): Readonly<Required<MemoryConfig>> {
    return this.config
  }

  // ===========================================================================
  // CRUD Operations
  // ===========================================================================

  /**
   * Save a memory to the store
   */
  async save(memory: Omit<Memory, 'createdAt' | 'updatedAt'>): Promise<Memory> {
    // Validate frontmatter
    const frontmatter = {
      name: memory.name,
      description: memory.description,
      type: memory.type,
      scope: memory.scope,
      tags: memory.tags,
    }

    const errors = validateFrontmatter(frontmatter)
    if (errors.length > 0) {
      throw new Error(`Invalid memory: ${errors.join(', ')}`)
    }

    // Determine directory based on scope and type
    const dir = this.getMemoryDir(memory.type, memory.scope)
    
    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true })

    // Generate filename
    const filename = generateFilename(memory.name, memory.type)
    const filepath = path.join(dir, filename)

    // Validate path
    if (this.config.security.validatePaths) {
      validatePath(this.baseDir, filepath)
    }

    // Check file size
    if (memory.content.length > this.config.maxFileSize) {
      throw new Error(
        `Memory content exceeds maximum size of ${this.config.maxFileSize} bytes`
      )
    }

    // Serialize and save
    const now = new Date()
    const fullMemory: Memory = {
      ...memory,
      createdAt: memory.createdAt || now,
      updatedAt: now,
      filePath: filepath,
    }

    const content = serializeFrontmatter(frontmatter, memory.content)
    await fs.writeFile(filepath, content, 'utf-8')

    // Update index if using MEMORY.md index
    await this.updateIndex(memory)

    return fullMemory
  }

  /**
   * Load a single memory by type and name
   */
  async load(type: MemoryType, name: string): Promise<Memory | null> {
    const dir = this.getMemoryDir(type, 'both')
    const filename = generateFilename(name, type)
    const filepath = path.join(dir, filename)

    try {
      const content = await fs.readFile(filepath, 'utf-8')
      return this.deserializeMemory(content, filepath)
    } catch {
      return null
    }
  }

  /**
   * Load a memory by its file path
   */
  async loadByPath(filePath: string): Promise<Memory | null> {
    // Validate path
    if (this.config.security.validatePaths) {
      if (this.config.security.checkSymlinks) {
        validatePathWithSymlinks(this.baseDir, filePath)
      } else {
        validatePath(this.baseDir, filePath)
      }
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return this.deserializeMemory(content, filePath)
    } catch {
      return null
    }
  }

  /**
   * Update an existing memory
   */
  async update(
    type: MemoryType,
    name: string,
    updates: Partial<Omit<Memory, 'type' | 'createdAt'>>
  ): Promise<Memory | null> {
    const existing = await this.load(type, name)
    if (!existing) {
      return null
    }

    const updated: Omit<Memory, 'createdAt' | 'updatedAt'> = {
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      type: existing.type,
      scope: updates.scope ?? existing.scope,
      content: updates.content ?? existing.content,
      tags: updates.tags ?? existing.tags,
    }

    // If name changed, delete old and create new
    if (updates.name && updates.name !== existing.name) {
      await this.delete(type, existing.name)
      return this.save(updated)
    }

    // Otherwise just update in place
    const filepath = existing.filePath!
    const frontmatter = {
      name: updated.name,
      description: updated.description,
      type: updated.type,
      scope: updated.scope,
      tags: updated.tags,
    }

    const content = serializeFrontmatter(frontmatter, updated.content)
    await fs.writeFile(filepath, content, 'utf-8')

    return {
      ...updated,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
      filePath: filepath,
    }
  }

  /**
   * Delete a memory
   */
  async delete(type: MemoryType, name: string): Promise<boolean> {
    const dir = this.getMemoryDir(type, 'both')
    const filename = generateFilename(name, type)
    const filepath = path.join(dir, filename)

    try {
      await fs.unlink(filepath)
      await this.removeFromIndex(type, name)
      return true
    } catch {
      return false
    }
  }

  // ===========================================================================
  // Scanning and Search
  // ===========================================================================

  /**
   * Scan all memories in the store
   */
  async scan(signal?: AbortSignal): Promise<MemoryHeader[]> {
    const headers: MemoryHeader[] = []

    for (const type of MEMORY_TYPES) {
      try {
        const typeHeaders = await this.scanType(type, signal)
        headers.push(...typeHeaders)
      } catch {
        // Directory doesn't exist, skip
      }
    }

    // Sort by modification time (newest first)
    return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.config.maxFiles)
  }

  /**
   * Scan memories of a specific type
   */
  async scanType(type: MemoryType, signal?: AbortSignal): Promise<MemoryHeader[]> {
    const headers: MemoryHeader[] = []
    const dirs = this.getTypeDirs(type)

    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir)
        
        for (const entry of entries) {
          if (signal?.aborted) break
          
          if (entry.endsWith('.md') && entry !== 'MEMORY.md') {
            const filepath = path.join(dir, entry)
            const header = await this.readHeader(filepath)
            if (header) {
              headers.push(header)
            }
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    }

    return headers.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /**
   * Search memories with optional filters
   */
  async search(options: MemorySearchOptions): Promise<Memory[]> {
    let headers = await this.scan()

    // Filter by type
    if (options.type) {
      headers = headers.filter(h => h.type === options.type)
    }

    // Filter by scope
    if (options.scope && options.scope !== 'both') {
      headers = headers.filter(h => h.scope === options.scope)
    }

    // Limit results
    const maxResults = options.maxResults ?? this.config.aiSelection.maxResults
    headers = headers.slice(0, maxResults)

    // Load full memories
    const memories: Memory[] = []
    for (const header of headers) {
      const memory = await this.loadByPath(header.filePath)
      if (memory) {
        memories.push(memory)
      }
    }

    return memories
  }

  // ===========================================================================
  // Index Management
  // ===========================================================================

  /**
   * Get MEMORY.md index content
   */
  async getIndex(scope: MemoryScope = 'private'): Promise<string> {
    const indexPath = path.join(
      this.getMemoryDir('project', scope),
      'MEMORY.md'
    )

    try {
      return await fs.readFile(indexPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /**
   * Update MEMORY.md index
   */
  async updateIndex(memory: Omit<Memory, 'createdAt' | 'updatedAt'>): Promise<void> {
    const indexPath = path.join(
      this.getMemoryDir(memory.type, memory.scope),
      'MEMORY.md'
    )

    const entry = `- [${memory.name}](${generateFilename(memory.name, memory.type)}) — ${memory.description}`

    try {
      const existing = await this.getIndex(memory.scope)
      const lines = existing.split('\n').filter(Boolean)
      
      // Check if entry already exists
      const existingIndex = lines.findIndex(l => l.includes(`[${memory.name}]`))
      if (existingIndex >= 0) {
        lines[existingIndex] = entry
      } else {
        lines.push(entry)
      }

      // Truncate if too long (>200 lines)
      const truncated = lines.length > 200 ? lines.slice(0, 200) : lines
      await fs.writeFile(indexPath, truncated.join('\n') + '\n', 'utf-8')
    } catch {
      // Index file doesn't exist, create it
      await fs.writeFile(indexPath, entry + '\n', 'utf-8')
    }
  }

  /**
   * Remove entry from index
   */
  async removeFromIndex(type: MemoryType, name: string): Promise<void> {
    const scope = this.guessScope(type)
    const indexPath = path.join(
      this.getMemoryDir(type, scope),
      'MEMORY.md'
    )

    try {
      const existing = await this.getIndex(scope)
      const lines = existing.split('\n').filter(l => !l.includes(`[${name}]`))
      await fs.writeFile(indexPath, lines.join('\n') + '\n', 'utf-8')
    } catch {
      // Ignore
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private getMemoryDir(type: MemoryType, scope: MemoryScope): string {
    if (scope === 'team') {
      return path.join(this.baseDir, 'team')
    }
    return path.join(this.baseDir, type)
  }

  private getTypeDirs(type: MemoryType): string[] {
    const dirs: string[] = [path.join(this.baseDir, type)]
    
    // For types that can be team-scoped
    if (['feedback', 'project', 'reference'].includes(type)) {
      dirs.push(path.join(this.baseDir, 'team'))
    }

    return dirs
  }

  private guessScope(type: MemoryType): MemoryScope {
    // Default scopes based on type
    const defaults: Record<MemoryType, MemoryScope> = {
      user: 'private',
      feedback: 'private',
      project: 'team',
      reference: 'team',
    }
    return defaults[type]
  }

  private async readHeader(filepath: string): Promise<MemoryHeader | null> {
    try {
      const stat = await fs.stat(filepath)
      const content = await fs.readFile(filepath, 'utf-8')
      const { frontmatter } = parseFrontmatter(content.slice(0, 1000))

      return {
        filename: path.basename(filepath),
        filePath: filepath,
        mtimeMs: stat.mtimeMs,
        description: frontmatter.description || null,
        type: frontmatter.type,
        scope: frontmatter.scope || this.guessScope(frontmatter.type || 'reference'),
        name: frontmatter.name,
      }
    } catch {
      return null
    }
  }

  private deserializeMemory(content: string, filepath: string): Memory {
    const { frontmatter, body } = parseFrontmatter(content)
    
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      type: frontmatter.type || 'reference',
      scope: frontmatter.scope || 'private',
      content: body,
      tags: frontmatter.tags || [],
      createdAt: frontmatter.createdAt ? new Date(frontmatter.createdAt) : new Date(),
      updatedAt: frontmatter.updatedAt ? new Date(frontmatter.updatedAt) : new Date(),
      filePath: filepath,
    }
  }
}

export default MemoryStore
