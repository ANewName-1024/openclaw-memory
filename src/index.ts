/**
 * OpenClaw Memory System - Main Entry Point
 */

// Types
export * from './types/index.js'

// Core Store
export { MemoryStore } from './store/MemoryStore.js'

// AI Selector
export { MemorySelector, createMemorySelector } from './selector/MemorySelector.js'
export type { SelectionResult, ModelClient } from './selector/MemorySelector.js'

// Session Memory
export { SessionMemoryManager, createSessionMemoryManager } from './session/SessionMemory.js'
export type { ExtractionAgent } from './session/SessionMemory.js'

// Team Memory
export { TeamMemoryManager } from './team/TeamMemory.js'

// Security
export {
  validatePath,
  validatePathWithSymlinks,
  sanitizePathKey,
  PathTraversalError,
  SymlinkEscapeError,
} from './security/pathValidator.js'

// Utilities
export { parseFrontmatter, serializeFrontmatter } from './utils/frontmatter.js'

// =============================================================================
// Default Instance Factory
// =============================================================================

import { MemoryStore } from './store/MemoryStore.js'
import { MemorySelector } from './selector/MemorySelector.js'
import { SessionMemoryManager } from './session/SessionMemory.js'
import { TeamMemoryManager } from './team/TeamMemory.js'
import type { MemoryConfig } from './types/index.js'
import { DEFAULT_MEMORY_CONFIG } from './types/index.js'

export interface MemorySystem {
  store: MemoryStore
  selector: MemorySelector
  session: SessionMemoryManager
  team: TeamMemoryManager
}

/**
 * Create a complete memory system with all components
 */
export function createMemorySystem(config?: Partial<MemoryConfig>): MemorySystem {
  const fullConfig = { ...DEFAULT_MEMORY_CONFIG, ...config }

  const store = new MemoryStore(fullConfig)
  const selector = new MemorySelector(fullConfig.aiSelection)
  const session = new SessionMemoryManager(fullConfig.sessionMemory)
  const team = new TeamMemoryManager(fullConfig.teamMemory, fullConfig.directory)

  return {
    store,
    selector,
    session,
    team,
  }
}

/**
 * Default memory system instance
 */
export const defaultMemorySystem = createMemorySystem()
