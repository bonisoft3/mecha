const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Validates that a string is a safe SQL identifier (column or table name).
 * Only allows letters, digits, and underscores, starting with a letter or underscore.
 * Throws if the identifier is invalid.
 */
export function validateIdentifier(name: string): string {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(`Invalid identifier: ${name}`)
  }
  return name
}
