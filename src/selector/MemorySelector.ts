/**
 * MemorySelector - AI-powered memory relevance selection
 */

import type { MemoryHeader, AISelectionConfig } from '../types/index.js'
import { DEFAULT_MEMORY_CONFIG } from '../types/index.js'

// =============================================================================
// Selection Result
// =============================================================================

export interface SelectionResult {
  selected: MemoryHeader[]
  scores: Map<string, number>
  model: string
  latencyMs: number
}

// =============================================================================
// Memory Selector
// =============================================================================

export class MemorySelector {
  private config: Required<AISelectionConfig>
  private modelClient?: ModelClient

  constructor(
    config: Partial<AISelectionConfig> = {},
    modelClient?: ModelClient
  ) {
    this.config = { ...DEFAULT_MEMORY_CONFIG.aiSelection, ...config } as Required<AISelectionConfig>
    this.modelClient = modelClient
  }

  /**
   * Select the most relevant memories for a query
   */
  async select(
    query: string,
    memories: MemoryHeader[],
    options: {
      recentTools?: string[]
      maxResults?: number
      excludeRecentTools?: boolean
    } = {}
  ): Promise<SelectionResult> {
    const startTime = Date.now()

    const maxResults = options.maxResults ?? this.config.maxResults
    const recentTools = options.recentTools ?? []
    const excludeRecent = options.excludeRecentTools ?? this.config.excludeRecentTools

    if (memories.length === 0) {
      return {
        selected: [],
        scores: new Map(),
        model: this.config.model,
        latencyMs: Date.now() - startTime,
      }
    }

    // Filter out recent tool documentation if enabled
    let candidates = memories
    if (excludeRecent && recentTools.length > 0) {
      candidates = this.filterRecentToolMemories(memories, recentTools)
    }

    if (candidates.length === 0) {
      return {
        selected: [],
        scores: new Map(),
        model: this.config.model,
        latencyMs: Date.now() - startTime,
      }
    }

    // If no AI model available, use keyword matching fallback
    if (!this.modelClient) {
      const selected = this.keywordSelect(query, candidates, maxResults)
      return {
        selected,
        scores: new Map(selected.map((m, i) => [m.filename, maxResults - i])),
        model: 'keyword-fallback',
        latencyMs: Date.now() - startTime,
      }
    }

    // Use AI model for selection
    try {
      const selected = await this.aiSelect(query, candidates, maxResults, recentTools)
      return {
        selected,
        scores: new Map(selected.map((m, i) => [m.filename, maxResults - i])),
        model: this.config.model,
        latencyMs: Date.now() - startTime,
      }
    } catch (error) {
      console.error('[MemorySelector] AI selection failed, falling back to keyword:', error)
      const selected = this.keywordSelect(query, candidates, maxResults)
      return {
        selected,
        scores: new Map(selected.map((m, i) => [m.filename, maxResults - i])),
        model: 'keyword-fallback',
        latencyMs: Date.now() - startTime,
      }
    }
  }

  /**
   * AI-powered selection using model
   */
  private async aiSelect(
    query: string,
    memories: MemoryHeader[],
    maxResults: number,
    recentTools: string[]
  ): Promise<MemoryHeader[]> {
    const manifest = this.formatManifest(memories)
    const toolsSection = recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

    const prompt = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}\n\nReturn a JSON object with a "selected_memories" array containing filenames (max ${maxResults}). Only include memories you are CERTAIN will be helpful. If unsure, return an empty array.`

    const response = await this.modelClient!.complete({
      model: this.config.model,
      prompt,
      maxTokens: 256,
      schema: {
        type: 'object',
        properties: {
          selected_memories: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['selected_memories']
      }
    })

    const validFilenames = new Set(memories.map(m => m.filename))
    const selectedNames: string[] = JSON.parse(response).selected_memories || []

    return selectedNames
      .filter((f: string) => validFilenames.has(f))
      .slice(0, maxResults)
      .map((f: string) => memories.find(m => m.filename === f)!)
  }

  /**
   * Keyword-based fallback selection
   */
  private keywordSelect(
    query: string,
    memories: MemoryHeader[],
    maxResults: number
  ): MemoryHeader[] {
    const queryWords = query.toLowerCase().split(/\s+/)
    
    // Score each memory by keyword overlap
    const scored = memories.map(memory => {
      let score = 0
      
      // Check description
      const descWords = (memory.description || '').toLowerCase().split(/\s+/)
      score += this.countOverlap(queryWords, descWords) * 2
      
      // Check name
      const nameWords = memory.name?.toLowerCase().split(/\s+/) || []
      score += this.countOverlap(queryWords, nameWords) * 3
      
      // Check type match (higher weight for exact type mention)
      if (queryWords.some(w => w === memory.type)) {
        score += 5
      }

      return { memory, score }
    })

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score)

    // Return top results
    return scored.slice(0, maxResults).map(s => s.memory)
  }

  /**
   * Count overlapping words between two arrays
   */
  private countOverlap(query: string[], target: string[]): number {
    const querySet = new Set(query)
    return target.filter(w => querySet.has(w)).length
  }

  /**
   * Filter out memories that are tool documentation for recently used tools
   */
  private filterRecentToolMemories(
    memories: MemoryHeader[],
    recentTools: string[]
  ): MemoryHeader[] {
    const toolNames = new Set(recentTools.map(t => t.toLowerCase()))

    return memories.filter(memory => {
      const desc = (memory.description || '').toLowerCase()
      const name = (memory.name || '').toLowerCase()
      
      // Check if this is documentation for a recent tool
      for (const tool of toolNames) {
        if (
          desc.includes(tool) || 
          name.includes(tool) ||
          desc.includes('documentation') ||
          desc.includes('reference')
        ) {
          // But keep if it contains warnings or known issues
          if (
            desc.includes('warning') ||
            desc.includes('issue') ||
            desc.includes('gotcha') ||
            desc.includes('caution')
          ) {
            return true
          }
          return false
        }
      }
      return true
    })
  }

  /**
   * Format memories as a text manifest
   */
  private formatManifest(memories: MemoryHeader[]): string {
    return memories
      .map(m => {
        const tag = m.type ? `[${m.type}] ` : ''
        const desc = m.description ? `: ${m.description}` : ''
        return `- ${tag}${m.filename}${desc}`
      })
      .join('\n')
  }
}

// =============================================================================
// Model Client Interface
// =============================================================================

export interface ModelClient {
  complete(options: {
    model: string
    prompt: string
    maxTokens: number
    schema?: Record<string, unknown>
  }): Promise<string>
}

// =============================================================================
// Factory
// =============================================================================

export function createMemorySelector(
  config?: Partial<AISelectionConfig>,
  modelClient?: ModelClient
): MemorySelector {
  return new MemorySelector(config, modelClient)
}

export default MemorySelector
