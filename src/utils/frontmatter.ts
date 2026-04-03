/**
 * Frontmatter Parser - YAML frontmatter parsing and serialization
 */

import type { MemoryFrontmatter, ParsedMemory, MemoryType, MemoryScope } from '../types/index.js'
import { MEMORY_TYPES } from '../types/index.js'

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse frontmatter from markdown content
 */
export function parseFrontmatter(content: string): ParsedMemory {
  // Check if content has frontmatter
  if (!content.startsWith('---')) {
    return {
      frontmatter: createEmptyFrontmatter(),
      body: content,
    }
  }

  // Find end marker
  const endIndex = content.indexOf('\n---', 3)
  if (endIndex === -1) {
    return {
      frontmatter: createEmptyFrontmatter(),
      body: content,
    }
  }

  // Extract frontmatter and body
  const frontmatterStr = content.slice(4, endIndex)
  const body = content.slice(endIndex + 4).replace(/^\n+/, '')

  // Parse YAML
  const frontmatter = parseYaml(frontmatterStr)

  return {
    frontmatter: {
      name: (frontmatter.name as string) || '',
      description: (frontmatter.description as string) || '',
      type: parseMemoryType(frontmatter.type as string | undefined),
      scope: parseScope(frontmatter.scope as string | undefined),
      tags: parseTags(frontmatter.tags as string[] | undefined),
      createdAt: frontmatter.createdAt as string | undefined,
      updatedAt: frontmatter.updatedAt as string | undefined,
    },
    body,
  }
}

function createEmptyFrontmatter(): MemoryFrontmatter {
  return {
    name: '',
    description: '',
    type: 'reference',
    scope: 'private',
    tags: [],
  }
}

/**
 * Serialize frontmatter and body to markdown
 */
export function serializeFrontmatter(
  frontmatter: MemoryFrontmatter,
  body: string
): string {
  const yaml = serializeYaml({
    name: frontmatter.name,
    description: frontmatter.description,
    type: frontmatter.type,
    scope: frontmatter.scope,
    tags: frontmatter.tags,
    createdAt: frontmatter.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  return `---\n${yaml}\n---\n\n${body}\n`
}

// =============================================================================
// YAML Parser (Simple Implementation)
// =============================================================================

function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue
    }

    // Parse key: value
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      continue
    }

    const key = line.slice(0, colonIndex).trim()
    let value = line.slice(colonIndex + 1).trim()

    // Parse value based on format
    result[key] = parseYamlValue(value)
  }

  return result
}

function parseYamlValue(value: string): unknown {
  // Empty value
  if (!value) {
    return null
  }

  // Quoted strings
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  // Arrays
  if (value.startsWith('[') && value.endsWith(']')) {
    const arrContent = value.slice(1, -1).trim()
    if (!arrContent) {
      return []
    }
    return arrContent.split(',').map(v => parseYamlValue(v.trim()))
  }

  // Objects (not fully supported, store as string)
  if (value.startsWith('{') && value.endsWith('}')) {
    return value
  }

  // Boolean
  if (value === 'true') return true
  if (value === 'false') return false

  // Null
  if (value === 'null' || value === 'undefined') return null

  // Number
  if (!isNaN(Number(value)) && value !== '') {
    return Number(value)
  }

  // String
  return value
}

/**
 * Serialize object to YAML string
 */
function serializeYaml(obj: Record<string, unknown>): string {
  const lines: string[] = []

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      continue
    }

    const yamlValue = serializeYamlValue(value)
    lines.push(`${key}: ${yamlValue}`)
  }

  return lines.join('\n')
}

function serializeYamlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    return String(value)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]'
    }
    const items = value.map(v => serializeYamlValue(v))
    return `[${items.join(', ')}]`
  }

  if (typeof value === 'string') {
    // Quote if contains special characters
    if (value.includes(':') || value.includes('#') || value.includes('\n') || value.includes('"')) {
      return `"${value.replace(/"/g, '\\"')}"`
    }
    return value
  }

  return String(value)
}

// =============================================================================
// Helper Functions
// =============================================================================

function parseMemoryType(value: unknown): MemoryType {
  if (typeof value !== 'string') {
    return 'reference'
  }
  if (MEMORY_TYPES.includes(value as MemoryType)) {
    return value as MemoryType
  }
  return 'reference'
}

function parseScope(value: unknown): MemoryScope {
  if (value === 'team') return 'team'
  return 'private'
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(v => String(v)).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(',').map(t => t.trim()).filter(Boolean)
  }
  return []
}

// =============================================================================
// Validation
// =============================================================================

export function validateFrontmatter(frontmatter: MemoryFrontmatter): string[] {
  const errors: string[] = []

  if (!frontmatter.name) {
    errors.push('name is required')
  }

  if (!MEMORY_TYPES.includes(frontmatter.type)) {
    errors.push(`type must be one of: ${MEMORY_TYPES.join(', ')}`)
  }

  if (frontmatter.scope && !['private', 'team'].includes(frontmatter.scope)) {
    errors.push('scope must be "private" or "team"')
  }

  return errors
}

// =============================================================================
// Memory File Helpers
// =============================================================================

/**
 * Generate a safe filename from memory name
 */
export function generateFilename(name: string, type: MemoryType): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50)

  return `${type}-${safe}.md`
}

/**
 * Parse filename to extract type and name
 */
export function parseFilename(filename: string): { type: MemoryType; name: string } | null {
  // Expected format: type-name.md
  const match = filename.match(/^([a-z]+)-(.+)\.md$/)
  if (!match) {
    return null
  }

  const [, type, name] = match
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    return null
  }

  return {
    type: type as MemoryType,
    name: name.replace(/-/g, ' '),
  }
}
