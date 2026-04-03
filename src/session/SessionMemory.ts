/**
 * SessionMemory - Automatic conversation summarization
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  Message,
  SessionMemoryConfig,
  SessionMemoryState,
  SessionTemplate,
} from '../types/index.js'
import { DEFAULT_MEMORY_CONFIG, DEFAULT_SESSION_MEMORY_TEMPLATE } from '../types/index.js'

// =============================================================================
// Session Memory Manager
// =============================================================================

export class SessionMemoryManager {
  private config: Required<SessionMemoryConfig>
  private state: SessionMemoryState
  private sessionDir: string
  private sessionFile: string
  private extractionAgent?: ExtractionAgent

  constructor(
    config: Partial<SessionMemoryConfig> = {},
    sessionDir: string = './.session-memory',
    extractionAgent?: ExtractionAgent
  ) {
    this.config = { ...DEFAULT_MEMORY_CONFIG.sessionMemory, ...config } as Required<SessionMemoryConfig>
    this.sessionDir = sessionDir
    this.sessionFile = path.join(sessionDir, 'current.md')
    this.extractionAgent = extractionAgent
    this.state = {
      initialized: false,
      lastExtractionTokens: 0,
      lastExtractionMessageId: null,
      extractionCount: 0,
    }
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  getConfig(): Readonly<Required<SessionMemoryConfig>> {
    return this.config
  }

  getState(): Readonly<SessionMemoryState> {
    return { ...this.state }
  }

  reset(): void {
    this.state = {
      initialized: false,
      lastExtractionTokens: 0,
      lastExtractionMessageId: null,
      extractionCount: 0,
    }
  }

  // ===========================================================================
  // Extraction Decision
  // ===========================================================================

  /**
   * Check if memory extraction should be triggered
   */
  shouldExtract(messages: Message[]): boolean {
    if (!this.config.enabled) {
      return false
    }

    const tokenCount = this.estimateTokens(messages)

    // Check initialization threshold
    if (!this.state.initialized) {
      if (tokenCount < this.config.minimumMessageTokensToInit) {
        return false
      }
      this.state.initialized = true
    }

    // Check token growth threshold (required)
    const tokenGrowth = tokenCount - this.state.lastExtractionTokens
    const hasMetTokenThreshold = tokenGrowth >= this.config.minimumTokensBetweenUpdate

    if (!hasMetTokenThreshold) {
      return false
    }

    // Check tool call threshold
    const toolCallsSinceLast = this.countToolCallsSince(
      messages,
      this.state.lastExtractionMessageId
    )
    const hasMetToolCallThreshold = toolCallsSinceLast >= this.config.toolCallsBetweenUpdates

    // Check if last turn has tool calls (avoid truncating)
    const lastTurnClean = !this.lastTurnHasToolCalls(messages)

    // Trigger conditions:
    // 1. Token threshold + tool call threshold both met
    // 2. Token threshold met + natural conversation break (no tool calls in last turn)
    return (
      (hasMetTokenThreshold && hasMetToolCallThreshold) ||
      (hasMetTokenThreshold && lastTurnClean)
    )
  }

  // ===========================================================================
  // Extraction
  // ===========================================================================

  /**
   * Extract and save session memory
   */
  async extract(messages: Message[]): Promise<string> {
    if (!this.shouldExtract(messages)) {
      throw new Error('Extraction threshold not met')
    }

    // Mark extraction started
    this.markExtractionStarted()

    // Ensure session file exists
    await this.ensureSessionFile()

    // Read current memory
    const currentMemory = await this.readCurrentMemory()

    // Build extraction prompt
    const prompt = this.buildExtractionPrompt(currentMemory, messages)

    // Run extraction
    let summary: string
    if (this.extractionAgent) {
      summary = await this.extractionAgent.extract(prompt, this.sessionFile)
    } else {
      // Fallback: just return the prompt
      summary = prompt
    }

    // Save summary
    await this.saveSummary(summary)

    // Update state
    this.state.lastExtractionTokens = this.estimateTokens(messages)
    const lastMessage = messages.at(-1)
    if (lastMessage?.id) {
      this.state.lastExtractionMessageId = lastMessage.id
    }

    return summary
  }

  /**
   * Manually trigger extraction (for /summary command)
   */
  async extractManual(messages: Message[]): Promise<{ success: boolean; path?: string; error?: string }> {
    if (messages.length === 0) {
      return { success: false, error: 'No messages to summarize' }
    }

    try {
      await this.ensureSessionFile()
      const currentMemory = await this.readCurrentMemory()
      const prompt = this.buildExtractionPrompt(currentMemory, messages)
      
      let summary: string
      if (this.extractionAgent) {
        summary = await this.extractionAgent.extract(prompt, this.sessionFile)
      } else {
        summary = prompt
      }

      await this.saveSummary(summary)
      return { success: true, path: this.sessionFile }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async ensureSessionFile(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true })

    try {
      await fs.writeFile(this.sessionFile, '', { flag: 'wx' })
      // Write template
      const template = this.loadTemplate()
      await fs.writeFile(this.sessionFile, template)
    } catch (e: any) {
      if (e.code !== 'EEXIST') {
        throw e
      }
    }
  }

  private loadTemplate(): string {
    return this.config.template
      ? this.serializeTemplate(this.config.template)
      : DEFAULT_SESSION_MEMORY_TEMPLATE
  }

  private serializeTemplate(template: SessionTemplate): string {
    return `---
name: current-session
description: Current conversation summary
type: session
---

# ${template.title}
_${'A short and distinctive 5-10 word descriptive title for the session.'}_

# ${template.currentState}
_${'What is actively being worked on right now?'}_

# ${template.taskSpecification}
_${'What did the user ask to build?'}_

# ${template.filesAndFunctions}
_${'What are the important files?'}_

# ${template.workflow}
_${'What bash commands are usually run?'}_

# ${template.errorsAndCorrections}
_${'Errors encountered and how they were fixed?'}_

# ${template.learnings}
_${'What has worked well? What has not?'}_

# ${template.keyResults}
_${'If the user asked a specific output, repeat it here.'}_

# ${template.worklog}
_${'Step by step, what was attempted and done?'}_
`
  }

  private async readCurrentMemory(): Promise<string> {
    try {
      return await fs.readFile(this.sessionFile, 'utf-8')
    } catch {
      return ''
    }
  }

  private async saveSummary(summary: string): Promise<void> {
    await fs.writeFile(this.sessionFile, summary, 'utf-8')
  }

  private buildExtractionPrompt(currentMemory: string, messages: Message[]): string {
    const recentMessages = messages.slice(-20) // Last 20 messages
    const formattedMessages = recentMessages
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[content]'}`)
      .join('\n\n')

    return `
Based on the user conversation below, update the session notes file at ${this.sessionFile}.

Current notes:
${currentMemory || '(empty)'}

Recent conversation:
${formattedMessages}

Please update the session notes with:
1. Key topics discussed
2. Important decisions made
3. Action items or follow-ups
4. Any relevant context that should be remembered

Keep the notes concise and actionable. Update every section as needed.
`
  }

  private markExtractionStarted(): void {
    this.state.extractionCount++
  }

  private estimateTokens(messages: Message[]): number {
    // Rough estimation: 4 characters per token
    const totalChars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return sum + content.length
    }, 0)
    return Math.ceil(totalChars / 4)
  }

  private countToolCallsSince(messages: Message[], sinceId: string | null): number {
    if (!sinceId) {
      // Count all tool calls
      return messages.reduce((count, m) => {
        if (m.role === 'assistant' && m.tool_calls) {
          return count + m.tool_calls.length
        }
        return count
      }, 0)
    }

    let foundStart = false
    let toolCallCount = 0

    for (const message of messages) {
      if (!foundStart) {
        if (message.id === sinceId) {
          foundStart = true
        }
        continue
      }

      if (message.role === 'assistant' && message.tool_calls) {
        toolCallCount += message.tool_calls.length
      }
    }

    return toolCallCount
  }

  private lastTurnHasToolCalls(messages: Message[]): boolean {
    const lastMessage = messages.at(-1)
    return lastMessage?.role === 'assistant' && 
           Array.isArray(lastMessage.tool_calls) && 
           lastMessage.tool_calls.length > 0
  }
}

// =============================================================================
// Extraction Agent Interface
// =============================================================================

export interface ExtractionAgent {
  extract(prompt: string, targetFile: string): Promise<string>
}

// =============================================================================
// Factory
// =============================================================================

export function createSessionMemoryManager(
  config?: Partial<SessionMemoryConfig>,
  sessionDir?: string,
  extractionAgent?: ExtractionAgent
): SessionMemoryManager {
  return new SessionMemoryManager(config, sessionDir, extractionAgent)
}

export default SessionMemoryManager
