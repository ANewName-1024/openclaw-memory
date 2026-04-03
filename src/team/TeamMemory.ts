/**
 * TeamMemory - Team-scoped memory management
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import {
  validatePath,
  validatePathWithSymlinks,
  PathTraversalError,
  SymlinkEscapeError,
  sanitizePathKey,
  isSymlink,
} from '../security/pathValidator.js'
import type {
  Memory,
  MemoryHeader,
  MemoryType,
  TeamMemoryConfig,
} from '../types/index.js'
import { DEFAULT_MEMORY_CONFIG } from '../types/index.js'

// =============================================================================
// Team Memory Manager
// =============================================================================

export class TeamMemoryManager {
  private config: Required<TeamMemoryConfig>
  private baseDir: string

  constructor(
    config: Partial<TeamMemoryConfig> = {},
    baseDir: string = './memory'
  ) {
    this.config = { ...DEFAULT_MEMORY_CONFIG.teamMemory, ...config } as Required<TeamMemoryConfig>
    this.baseDir = path.join(baseDir, 'team')
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  getDirectory(): string {
    return this.baseDir
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  // ===========================================================================
  // Team Memory Operations
  // ===========================================================================

  /**
   * Save a team memory
   */
  async save(memory: Omit<Memory, 'createdAt' | 'updatedAt' | 'scope'>): Promise<Memory> {
    if (!this.config.enabled) {
      throw new Error('Team memory is not enabled')
    }

    // Ensure directory exists
    await fs.mkdir(this.baseDir, { recursive: true })

    // Validate and sanitize path
    const filename = this.generateFilename(memory.name, memory.type)
    const filepath = path.join(this.baseDir, filename)

    if (this.config.enabled) {
      await this.validateTeamPath(filepath)
    }

    // Serialize and save
    const now = new Date()
    const fullMemory: Memory = {
      ...memory,
      scope: 'team',
      createdAt: now,
      updatedAt: now,
      filePath: filepath,
    }

    const content = this.serializeMemory(fullMemory)
    await fs.writeFile(filepath, content, 'utf-8')

    // Update team index
    await this.updateTeamIndex(fullMemory)

    return fullMemory
  }

  /**
   * Load a team memory
   */
  async load(type: MemoryType, name: string): Promise<Memory | null> {
    if (!this.config.enabled) {
      return null
    }

    const filename = this.generateFilename(name, type)
    const filepath = path.join(this.baseDir, filename)

    try {
      await this.validateTeamPath(filepath)
      const content = await fs.readFile(filepath, 'utf-8')
      return this.deserializeMemory(content, filepath)
    } catch {
      return null
    }
  }

  /**
   * Delete a team memory
   */
  async delete(type: MemoryType, name: string): Promise<boolean> {
    if (!this.config.enabled) {
      return false
    }

    const filename = this.generateFilename(name, type)
    const filepath = path.join(this.baseDir, filename)

    try {
      await this.validateTeamPath(filepath)
      await fs.unlink(filepath)
      await this.removeFromTeamIndex(type, name)
      return true
    } catch {
      return false
    }
  }

  /**
   * Scan all team memories
   */
  async scan(): Promise<MemoryHeader[]> {
    if (!this.config.enabled) {
      return []
    }

    const headers: MemoryHeader[] = []

    try {
      const entries = await fs.readdir(this.baseDir)

      for (const entry of entries) {
        if (entry.endsWith('.md') && entry !== 'MEMORY.md') {
          const filepath = path.join(this.baseDir, entry)
          const header = await this.readHeader(filepath)
          if (header) {
            headers.push(header)
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return headers.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  // ===========================================================================
  // Team Index (MEMORY.md)
  // ===========================================================================

  /**
   * Get team memory index
   */
  async getTeamIndex(): Promise<string> {
    const indexPath = path.join(this.baseDir, 'MEMORY.md')

    try {
      return await fs.readFile(indexPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /**
   * Update team memory index
   */
  async updateTeamIndex(memory: Memory): Promise<void> {
    const indexPath = path.join(this.baseDir, 'MEMORY.md')
    const entry = `- [${memory.name}](${this.generateFilename(memory.name, memory.type)}) — ${memory.description}`

    try {
      const existing = await this.getTeamIndex()
      const lines = existing.split('\n').filter(Boolean)

      // Check if entry already exists
      const existingIndex = lines.findIndex(l => l.includes(`[${memory.name}]`))
      if (existingIndex >= 0) {
        lines[existingIndex] = entry
      } else {
        lines.push(entry)
      }

      // Keep index manageable (max 200 lines)
      const truncated = lines.length > 200 ? lines.slice(0, 200) : lines
      await fs.writeFile(indexPath, truncated.join('\n') + '\n', 'utf-8')
    } catch {
      await fs.writeFile(indexPath, entry + '\n', 'utf-8')
    }
  }

  /**
   * Remove entry from team index
   */
  async removeFromTeamIndex(type: MemoryType, name: string): Promise<void> {
    const indexPath = path.join(this.baseDir, 'MEMORY.md')

    try {
      const existing = await this.getTeamIndex()
      const lines = existing.split('\n').filter(l => !l.includes(`[${name}]`))
      await fs.writeFile(indexPath, lines.join('\n') + '\n', 'utf-8')
    } catch {
      // Ignore
    }
  }

  // ===========================================================================
  // Sync
  // ===========================================================================

  /**
   * Sync team memories (for startup)
   */
  async sync(): Promise<{ loaded: number; errors: string[] }> {
    if (!this.config.syncOnStart) {
      return { loaded: 0, errors: [] }
    }

    const errors: string[] = []
    const headers = await this.scan()

    for (const header of headers) {
      try {
        // Validate each team memory
        await this.validateTeamPath(header.filePath)
      } catch (e) {
        errors.push(`${header.filename}: ${(e as Error).message}`)
      }
    }

    return { loaded: headers.length, errors }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private async validateTeamPath(filepath: string): Promise<void> {
    // Sanitize input
    const relative = path.relative(this.baseDir, filepath)
    sanitizePathKey(relative)

    // Check if within base directory
    if (this.config.enabled) {
      if (this.config.enabled) {
        // Symlink check enabled
        await validatePathWithSymlinks(this.baseDir, filepath)
        
        // Check for dangling symlinks
        if (await isSymlink(filepath)) {
          const realPath = await fs.realpath(filepath)
          if (!realPath.startsWith(this.baseDir)) {
            throw new SymlinkEscapeError(`Symlink escapes team directory: ${filepath}`)
          }
        }
      } else {
        validatePath(this.baseDir, filepath)
      }
    }
  }

  private generateFilename(name: string, type: MemoryType): string {
    const safe = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50)

    return `${type}-${safe}.md`
  }

  private async readHeader(filepath: string): Promise<MemoryHeader | null> {
    try {
      const stat = await fs.stat(filepath)
      const content = await fs.readFile(filepath, 'utf-8')
      const { frontmatter } = this.parseFrontmatter(content.slice(0, 1000))

      return {
        filename: path.basename(filepath),
        filePath: filepath,
        mtimeMs: stat.mtimeMs,
        description: (frontmatter.description as string) || null,
        type: frontmatter.type as MemoryType | undefined,
        scope: 'team',
        name: frontmatter.name as string | undefined,
      }
    } catch {
      return null
    }
  }

  private parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    if (!content.startsWith('---')) {
      return { frontmatter: {}, body: content }
    }

    const endIndex = content.indexOf('\n---', 3)
    if (endIndex === -1) {
      return { frontmatter: {}, body: content }
    }

    const frontmatterStr = content.slice(4, endIndex)
    const body = content.slice(endIndex + 4)

    // Simple YAML parsing
    const frontmatter: Record<string, unknown> = {}
    for (const line of frontmatterStr.split('\n')) {
      const match = line.match(/^(\w+):\s*(.*)$/)
      if (match) {
        frontmatter[match[1]] = match[2].trim()
      }
    }

    return { frontmatter, body }
  }

  private serializeMemory(memory: Memory): string {
    const frontmatter = [
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `scope: team`,
      `createdAt: ${(memory.createdAt || new Date()).toISOString()}`,
      `updatedAt: ${new Date().toISOString()}`,
    ].join('\n')

    return `---\n${frontmatter}---\n\n${memory.content}\n`
  }

  private deserializeMemory(content: string, filepath: string): Memory {
    const { frontmatter, body } = this.parseFrontmatter(content)

    return {
      name: String(frontmatter.name || ''),
      description: String(frontmatter.description || ''),
      type: (frontmatter.type as MemoryType) || 'reference',
      scope: 'team',
      content: body,
      createdAt: frontmatter.createdAt ? new Date(frontmatter.createdAt as string) : new Date(),
      updatedAt: frontmatter.updatedAt ? new Date(frontmatter.updatedAt as string) : new Date(),
      filePath: filepath,
    }
  }
}

export default TeamMemoryManager
