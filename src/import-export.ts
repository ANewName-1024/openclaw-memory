/**
 * Import/Export - Backup and restore functionality
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { Memory, MemoryType, MemoryScope } from './types/index.js'
import { MemoryStore } from './store/MemoryStore.js'
import { MemoryBatchProcessor } from './batch.js'

export interface ExportMetadata {
  version: string
  exportedAt: string
  memoryCount: number
  types: Record<string, number>
  scopes: Record<string, number>
}

export interface ExportData {
  metadata: ExportMetadata
  memories: Array<Omit<Memory, 'createdAt' | 'updatedAt' | 'filePath'>>
}

export interface ImportOptions {
  overwrite: boolean
  skipOnError: boolean
  validateOnly: boolean
}

export interface ImportResult {
  imported: number
  skipped: number
  errors: Array<{ memory: string; error: Error }>
  duration: number
}

/**
 * Export memories to a JSON file
 */
export class MemoryExporter {
  private store: MemoryStore

  constructor(store: MemoryStore) {
    this.store = store
  }

  /**
   * Export all memories to a structured JSON object
   */
  async exportToJSON(): Promise<ExportData> {
    const headers = await this.store.scan()
    const memories: Array<Omit<Memory, 'createdAt' | 'updatedAt' | 'filePath'>> = []
    const types: Record<string, number> = {}
    const scopes: Record<string, number> = {}

    for (const header of headers) {
      if (header.type && header.name) {
        const memory = await this.store.load(header.type, header.name)
        if (memory) {
          const { createdAt, updatedAt, filePath, ...rest } = memory
          memories.push(rest)
          
          types[rest.type] = (types[rest.type] || 0) + 1
          scopes[rest.scope] = (scopes[rest.scope] || 0) + 1
        }
      }
    }

    return {
      metadata: {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        memoryCount: memories.length,
        types,
        scopes,
      },
      memories,
    }
  }

  /**
   * Export memories to a JSON file
   */
  async exportToFile(filePath: string): Promise<ExportMetadata> {
    const data = await this.exportToJSON()
    const json = JSON.stringify(data, null, 2)
    await fs.writeFile(filePath, json, 'utf8')
    return data.metadata
  }

  /**
   * Export memories to a directory structure
   */
  async exportToDirectory(dirPath: string): Promise<ExportMetadata> {
    const data = await this.exportToJSON()
    
    // Create directory structure
    await fs.mkdir(dirPath, { recursive: true })
    
    // Save metadata
    await fs.writeFile(
      path.join(dirPath, 'metadata.json'),
      JSON.stringify(data.metadata, null, 2),
      'utf8'
    )

    // Group memories by type
    const byType: Record<string, typeof data.memories> = {}
    for (const memory of data.memories) {
      if (!byType[memory.type]) {
        byType[memory.type] = []
      }
      byType[memory.type].push(memory)
    }

    // Save each type to its own file
    for (const [type, memories] of Object.entries(byType)) {
      await fs.writeFile(
        path.join(dirPath, `${type}.json`),
        JSON.stringify(memories, null, 2),
        'utf8'
      )
    }

    return data.metadata
  }
}

/**
 * Import memories from backup
 */
export class MemoryImporter {
  private store: MemoryStore

  constructor(store: MemoryStore) {
    this.store = store
  }

  /**
   * Import memories from a JSON file
   */
  async importFromFile(
    filePath: string,
    options: Partial<ImportOptions> = {}
  ): Promise<ImportResult> {
    const startTime = Date.now()
    const opts: ImportOptions = {
      overwrite: options.overwrite ?? false,
      skipOnError: options.skipOnError ?? true,
      validateOnly: options.validateOnly ?? false,
    }

    const content = await fs.readFile(filePath, 'utf8')
    const data = JSON.parse(content) as ExportData

    return this.importFromData(data, opts, startTime)
  }

  /**
   * Import memories from JSON data
   */
  async importFromData(
    data: ExportData,
    options: Partial<ImportOptions> = {},
    startTime: number = Date.now()
  ): Promise<ImportResult> {
    const opts: ImportOptions = {
      overwrite: options.overwrite ?? false,
      skipOnError: options.skipOnError ?? true,
      validateOnly: options.validateOnly ?? false,
    }

    const result: ImportResult = {
      imported: 0,
      skipped: 0,
      errors: [],
      duration: 0,
    }

    // Validate data structure
    if (!data.memories || !Array.isArray(data.memories)) {
      result.errors.push({
        memory: '',
        error: new Error('Invalid export data: missing memories array'),
      })
      result.duration = Date.now() - startTime
      return result
    }

    const processor = new MemoryBatchProcessor(this.store)

    for (const memory of data.memories) {
      try {
        // Check if memory exists
        if (!opts.overwrite) {
          const existing = await this.store.load(memory.type, memory.name)
          if (existing) {
            result.skipped++
            continue
          }
        }

        if (!opts.validateOnly) {
          await this.store.save(memory)
        }
        result.imported++
      } catch (error) {
        if (!opts.skipOnError) {
          throw error
        }
        result.errors.push({
          memory: `${memory.type}/${memory.name}`,
          error: error as Error,
        })
        result.skipped++
      }
    }

    result.duration = Date.now() - startTime
    return result
  }

  /**
   * Validate import data without importing
   */
  async validateImport(data: ExportData): Promise<{
    valid: boolean
    errors: string[]
    warnings: string[]
  }> {
    const errors: string[] = []
    const warnings: string[] = []

    // Check metadata
    if (!data.metadata) {
      warnings.push('Missing metadata')
    } else {
      if (!data.metadata.version) {
        warnings.push('Missing version in metadata')
      }
    }

    // Validate memories
    if (!Array.isArray(data.memories)) {
      errors.push('memories must be an array')
    } else {
      const validTypes = ['user', 'feedback', 'project', 'reference']
      const validScopes = ['private', 'team', 'both']

      for (let i = 0; i < data.memories.length; i++) {
        const m = data.memories[i]

        if (!m.name) {
          errors.push(`Memory at index ${i}: missing name`)
        }
        if (!m.type || !validTypes.includes(m.type)) {
          errors.push(`Memory "${m.name || i}": invalid type "${m.type}"`)
        }
        if (!m.scope || !validScopes.includes(m.scope)) {
          errors.push(`Memory "${m.name || i}": invalid scope "${m.scope}"`)
        }
        if (!m.content) {
          warnings.push(`Memory "${m.name || i}": missing content`)
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }
}

/**
 * Create a backup with timestamp
 */
export async function createBackup(
  store: MemoryStore,
  backupDir: string
): Promise<string> {
  const exporter = new MemoryExporter(store)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `backup-${timestamp}`)

  await exporter.exportToDirectory(backupPath)
  return backupPath
}

/**
 * List available backups
 */
export async function listBackups(backupDir: string): Promise<
  Array<{
    name: string
    path: string
    date: Date
    memoryCount?: number
  }>
> {
  try {
    const entries = await fs.readdir(backupDir)
    const backups = []

    for (const entry of entries) {
      if (entry.startsWith('backup-')) {
        const metadataPath = path.join(backupDir, entry, 'metadata.json')
        try {
          const metadata = JSON.parse(
            await fs.readFile(metadataPath, 'utf8')
          ) as ExportMetadata
          backups.push({
            name: entry,
            path: path.join(backupDir, entry),
            date: new Date(metadata.exportedAt),
            memoryCount: metadata.memoryCount,
          })
        } catch {
          backups.push({
            name: entry,
            path: path.join(backupDir, entry),
            date: new Date(),
          })
        }
      }
    }

    return backups.sort((a, b) => b.date.getTime() - a.date.getTime())
  } catch {
    return []
  }
}
