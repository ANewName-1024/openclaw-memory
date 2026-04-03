/**
 * Event System - Observer pattern for memory changes
 */

import type { Memory, MemoryType } from './types/index.js'

export type MemoryEventType = 
  | 'memory:saved'
  | 'memory:updated'
  | 'memory:deleted'
  | 'memory:scanned'
  | 'memory:searched'

export interface MemoryEvent {
  type: MemoryEventType
  timestamp: Date
  memory?: Memory
  memoryName?: string
  memoryType?: MemoryType
  metadata?: Record<string, unknown>
}

export type EventHandler = (event: MemoryEvent) => void | Promise<void>

/**
 * Simple event emitter for memory system events
 */
export class MemoryEventEmitter {
  private handlers: Map<MemoryEventType, Set<EventHandler>> = new Map()
  private allHandlers: Set<EventHandler> = new Set()

  /**
   * Subscribe to a specific event type
   */
  on(event: MemoryEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  /**
   * Subscribe to all events
   */
  onAny(handler: EventHandler): () => void {
    this.allHandlers.add(handler)
    return () => {
      this.allHandlers.delete(handler)
    }
  }

  /**
   * Unsubscribe from a specific event type
   */
  off(event: MemoryEventType, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler)
  }

  /**
   * Unsubscribe from all events
   */
  offAll(): void {
    this.handlers.clear()
    this.allHandlers.clear()
  }

  /**
   * Emit an event to all subscribers
   */
  protected emit(event: MemoryEvent): void {
    // Call specific handlers
    const handlers = this.handlers.get(event.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(event)
          if (result instanceof Promise) {
            result.catch(console.error)
          }
        } catch (error) {
          console.error(`Event handler error for ${event.type}:`, error)
        }
      }
    }

    // Call general handlers
    for (const handler of this.allHandlers) {
      try {
        const result = handler(event)
        if (result instanceof Promise) {
          result.catch(console.error)
        }
      } catch (error) {
        console.error(`Event handler error for any:`, error)
      }
    }
  }

  /**
   * Create an event and emit it
   */
  emitEvent(
    type: MemoryEventType,
    options?: {
      memory?: Memory
      memoryName?: string
      memoryType?: MemoryType
      metadata?: Record<string, unknown>
    }
  ): void {
    this.emit({
      type,
      timestamp: new Date(),
      ...options,
    })
  }
}

/**
 * Singleton global event emitter for system-wide events
 */
export const globalEventEmitter = new MemoryEventEmitter()
