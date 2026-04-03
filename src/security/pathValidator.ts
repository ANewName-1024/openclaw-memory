/**
 * Security Module - Path traversal and symlink attack protection
 */

import * as fs from 'fs/promises'
import * as path from 'path'

// =============================================================================
// Errors
// =============================================================================

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

export class SymlinkEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SymlinkEscapeError'
  }
}

// =============================================================================
// Path Validation
// =============================================================================

/**
 * Validate that a path is within the allowed base directory
 * Prevents path traversal attacks (../)
 */
export function validatePath(baseDir: string, filePath: string): string {
  // Resolve both paths to absolute paths
  const resolvedBase = path.resolve(baseDir)
  const resolvedPath = path.resolve(baseDir, filePath)

  // Check prefix
  if (!resolvedPath.startsWith(resolvedBase + path.sep) &&
      resolvedPath !== resolvedBase) {
    throw new PathTraversalError(
      `Path "${filePath}" escapes base directory "${baseDir}"`
    )
  }

  return resolvedPath
}

/**
 * Validate path with symlink checking
 * Prevents symlink-based directory escape attacks
 */
export async function validatePathWithSymlinks(
  baseDir: string,
  filePath: string
): Promise<string> {
  // First pass: basic path validation
  const resolvedPath = validatePath(baseDir, filePath)

  // Second pass: symlink resolution
  try {
    const realPath = await resolveSymlinks(resolvedPath)
    const realBase = await resolveSymlinks(path.resolve(baseDir))

    if (!realPath.startsWith(realBase + path.sep) && realPath !== realBase) {
      throw new SymlinkEscapeError(
        `Path "${filePath}" escapes via symlink: resolved to "${realPath}"`
      )
    }

    return realPath
  } catch (e) {
    if (e instanceof SymlinkEscapeError) {
      throw e
    }
    // If realpath fails (file doesn't exist), use resolved path
    // and let the caller handle the non-existence
    return resolvedPath
  }
}

/**
 * Resolve symlinks in a path, handling non-existent paths
 */
async function resolveSymlinks(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      // Path doesn't exist, walk up to find realpath of existing ancestor
      return resolveSymlinksUp(p)
    }
    if (code === 'ENOTDIR') {
      // A component in the path is not a directory
      return resolveSymlinksUp(p)
    }
    throw e
  }
}

/**
 * Walk up the directory tree to find the first existing ancestor
 */
async function resolveSymlinksUp(p: string): Promise<string> {
  let current = p
  let parent = path.dirname(current)

  // Walk up until we find an existing directory
  while (current !== parent) {
    try {
      const realCurrent = await fs.realpath(current)
      // Found the real path, rejoin the rest
      if (realCurrent === current) {
        return current
      }
      const suffix = p.slice(current.length)
      return suffix ? path.join(realCurrent, suffix) : realCurrent
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        current = parent
        parent = path.dirname(current)
        continue
      }
      throw e
    }
  }

  // Reached root
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

// =============================================================================
// Input Sanitization
// =============================================================================

/**
 * Sanitize a path key from user/server input
 */
export function sanitizePathKey(key: string): string {
  // Check null byte
  if (key.includes('\0')) {
    throw new PathTraversalError('Null byte in path key')
  }

  // Check URL-encoded traversal (%2e%2e%2f = ../)
  try {
    const decoded = decodeURIComponent(key)
    if (decoded !== key) {
      if (decoded.includes('..') || decoded.includes('/')) {
        throw new PathTraversalError('URL-encoded path traversal detected')
      }
    }
  } catch {
    // Invalid URL encoding, ignore
  }

  // Check Unicode normalization attacks (． = .)
  const normalized = key.normalize('NFKC')
  if (normalized !== key) {
    if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) {
      throw new PathTraversalError('Unicode normalization path traversal detected')
    }
  }

  // Reject backslashes (Windows path separator as traversal)
  if (key.includes('\\')) {
    throw new PathTraversalError('Backslash in path key not allowed')
  }

  // Reject absolute paths
  if (key.startsWith('/')) {
    throw new PathTraversalError('Absolute path in key not allowed')
  }

  // Reject parent directory traversal
  if (key.includes('..')) {
    throw new PathTraversalError('Parent directory traversal not allowed')
  }

  return key
}

// =============================================================================
// File Safety Checks
// =============================================================================

/**
 * Check if a path is a symlink
 */
export async function isSymlink(p: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(p)
    return stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Check if a path is within a directory (string comparison, no filesystem access)
 */
export function isPathInDirectory(filePath: string, dirPath: string): boolean {
  const normalizedFile = path.normalize(filePath)
  const normalizedDir = path.normalize(dirPath)
  return normalizedFile.startsWith(normalizedDir + path.sep) ||
         normalizedFile === normalizedDir
}

/**
 * Validate file size is within limit
 */
export async function validateFileSize(
  filePath: string,
  maxSize: number
): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.size <= maxSize
  } catch {
    return true // File doesn't exist, skip check
  }
}

/**
 * Validate total count of memory files
 */
export async function validateFileCount(
  dirPath: string,
  maxFiles: number
): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath)
    const mdFiles = entries.filter(e => e.endsWith('.md'))
    return mdFiles.length < maxFiles
  } catch {
    return true // Directory doesn't exist
  }
}

// =============================================================================
// Security Config
// =============================================================================

export interface SecurityOptions {
  validatePaths: boolean
  checkSymlinks: boolean
  maxPathDepth: number
  allowedExtensions: string[]
}

export const DEFAULT_SECURITY_OPTIONS: SecurityOptions = {
  validatePaths: true,
  checkSymlinks: true,
  maxPathDepth: 10,
  allowedExtensions: ['.md'],
}

/**
 * Apply security options to path validation
 */
export function createSecurePathValidator(options: Partial<SecurityOptions> = {}) {
  const opts = { ...DEFAULT_SECURITY_OPTIONS, ...options }

  return async function validateSecurePath(
    baseDir: string,
    filePath: string
  ): Promise<string> {
    // Sanitize input
    const sanitized = sanitizePathKey(filePath)

    // Check depth
    const depth = sanitized.split('/').filter(Boolean).length
    if (depth > opts.maxPathDepth) {
      throw new PathTraversalError(
        `Path depth ${depth} exceeds maximum ${opts.maxPathDepth}`
      )
    }

    // Check extension
    const ext = path.extname(sanitized)
    if (!opts.allowedExtensions.includes(ext)) {
      throw new PathTraversalError(
        `Extension "${ext}" not allowed. Allowed: ${opts.allowedExtensions.join(', ')}`
      )
    }

    // Validate with symlinks if enabled
    if (opts.checkSymlinks) {
      return validatePathWithSymlinks(baseDir, sanitized)
    }

    return validatePath(baseDir, sanitized)
  }
}
