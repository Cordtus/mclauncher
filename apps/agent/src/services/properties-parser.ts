/**
 * Server Properties Parser
 *
 * Parses and updates server.properties files while preserving comments and formatting.
 * Unlike the config-parser.ts which handles multiple formats, this is specifically
 * optimized for the Java .properties format used by Minecraft.
 */

import fs from 'fs';

/**
 * Parses a .properties file into a key-value map
 *
 * @param filePath - Path to the .properties file
 * @returns Object mapping property keys to their values
 */
export function parseProperties(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const properties: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      continue;
    }

    // Find the first = or : separator
    const separatorIndex = Math.min(
      trimmed.indexOf('=') !== -1 ? trimmed.indexOf('=') : Infinity,
      trimmed.indexOf(':') !== -1 ? trimmed.indexOf(':') : Infinity
    );

    if (separatorIndex === Infinity) {
      continue; // No separator found
    }

    const key = trimmed.substring(0, separatorIndex).trim();
    const value = trimmed.substring(separatorIndex + 1).trim();

    properties[key] = value;
  }

  return properties;
}

/**
 * Updates specific properties in a .properties file while preserving comments
 * and formatting. If a key doesn't exist, it will be appended at the end.
 *
 * @param filePath - Path to the .properties file
 * @param updates - Object with property keys and new values to update
 * @returns true if file was modified, false otherwise
 */
export function updateProperties(
  filePath: string,
  updates: Record<string, string | number | boolean>
): boolean {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Properties file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const updatedKeys = new Set<string>();
  let modified = false;

  // First pass: update existing keys
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      continue;
    }

    // Find the separator
    const separatorIndex = Math.min(
      trimmed.indexOf('=') !== -1 ? trimmed.indexOf('=') : Infinity,
      trimmed.indexOf(':') !== -1 ? trimmed.indexOf(':') : Infinity
    );

    if (separatorIndex === Infinity) {
      continue;
    }

    const key = trimmed.substring(0, separatorIndex).trim();

    // Check if this key needs updating
    if (key in updates) {
      const newValue = formatValue(updates[key]);
      const currentValue = trimmed.substring(separatorIndex + 1).trim();

      if (currentValue !== newValue) {
        // Preserve indentation if present
        const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
        lines[i] = `${leadingWhitespace}${key}=${newValue}`;
        modified = true;
      }

      updatedKeys.add(key);
    }
  }

  // Second pass: append new keys that weren't in the original file
  const newKeys = Object.keys(updates).filter(key => !updatedKeys.has(key));

  if (newKeys.length > 0) {
    // Ensure file ends with newline before appending
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }

    // Add a comment section for new properties
    if (!content.includes('# MC LXD Manager Settings')) {
      lines.push('# MC LXD Manager Settings');
    }

    // Append new properties
    for (const key of newKeys) {
      lines.push(`${key}=${formatValue(updates[key])}`);
      modified = true;
    }
  }

  // Write back to file if modified
  if (modified) {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  }

  return modified;
}

/**
 * Formats a value for .properties file format
 * Converts booleans and numbers to strings
 *
 * @param value - Value to format
 * @returns Formatted string value
 */
function formatValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value.toString();
  }

  if (typeof value === 'number') {
    return value.toString();
  }

  // String values - escape special characters if needed
  return value.replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Reads a JSON array file (whitelist.json or ops.json)
 * Returns empty array if file doesn't exist
 *
 * @param filePath - Path to JSON file
 * @returns Parsed JSON array
 */
export function readJsonArray<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];

    return JSON.parse(content);
  } catch (err) {
    console.error(`Failed to parse JSON file ${filePath}:`, err);
    return [];
  }
}

/**
 * Writes a JSON array file with pretty formatting
 *
 * @param filePath - Path to JSON file
 * @param data - Array to write
 */
export function writeJsonArray<T>(filePath: string, data: T[]): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Gets a specific property value with type conversion
 *
 * @param filePath - Path to .properties file
 * @param key - Property key to get
 * @param defaultValue - Default value if key not found
 * @returns Property value or default
 */
export function getProperty<T extends string | number | boolean>(
  filePath: string,
  key: string,
  defaultValue: T
): T {
  const properties = parseProperties(filePath);
  const value = properties[key];

  if (value === undefined) {
    return defaultValue;
  }

  // Type conversion based on default value type
  if (typeof defaultValue === 'boolean') {
    return (value.toLowerCase() === 'true') as T;
  }

  if (typeof defaultValue === 'number') {
    const num = Number(value);
    return (isNaN(num) ? defaultValue : num) as T;
  }

  return value as T;
}
