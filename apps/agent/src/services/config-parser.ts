import * as fs from 'fs/promises';
import * as path from 'path';
import * as TOML from 'toml';
import JSON5 from 'json5';
import * as yaml from 'js-yaml';
import PropertiesReader from 'properties-reader';

export type ConfigFormat = 'toml' | 'json' | 'json5' | 'yaml' | 'properties';

export interface ConfigField {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'array' | 'object';
  value: any;
  description?: string;
  constraints?: {
    min?: number;
    max?: number;
    options?: any[];
    pattern?: string;
  };
}

export interface ConfigSection {
  name: string;
  description?: string;
  fields: ConfigField[];
  subsections?: ConfigSection[];
}

export interface ParsedConfig {
  format: ConfigFormat;
  raw: string;
  sections: ConfigSection[];
}

/**
 * Detect config file format from extension
 */
export function detectFormat(filePath: string): ConfigFormat {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.toml':
      return 'toml';
    case '.json5':
      return 'json5';
    case '.json':
      return 'json';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.properties':
    case '.cfg':
      return 'properties';
    default:
      return 'toml'; // Default assumption for Minecraft mods
  }
}

/**
 * Parse config file and extract structure
 */
export async function parseConfigFile(filePath: string): Promise<ParsedConfig> {
  const raw = await fs.readFile(filePath, 'utf8');
  const format = detectFormat(filePath);

  let parsed: any;

  switch (format) {
    case 'toml':
      parsed = TOML.parse(raw);
      break;
    case 'json5':
      parsed = JSON5.parse(raw);
      break;
    case 'json':
      parsed = JSON.parse(raw);
      break;
    case 'yaml':
      parsed = yaml.load(raw) as any;
      break;
    case 'properties':
      const props = PropertiesReader(filePath);
      parsed = props.getAllProperties();
      break;
  }

  // Extract comments for TOML
  const comments = format === 'toml' ? extractTomlComments(raw) : {};

  // Convert parsed object to sections
  const sections = objectToSections(parsed, comments);

  return {
    format,
    raw,
    sections,
  };
}

/**
 * Extract comments from TOML file
 * Format: # Comment text
 */
function extractTomlComments(content: string): Record<string, string> {
  const comments: Record<string, string> = {};
  const lines = content.split('\n');
  let currentComment = '';
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Section header [section]
    if (line.match(/^\[[\w.]+\]$/)) {
      currentSection = line.replace(/[\[\]]/g, '');
      if (currentComment) {
        comments[currentSection] = currentComment;
        currentComment = '';
      }
    }
    // Comment line
    else if (line.startsWith('#')) {
      currentComment += line.substring(1).trim() + ' ';
    }
    // Key-value pair
    else if (line.includes('=')) {
      const key = line.split('=')[0].trim();
      const fullKey = currentSection ? `${currentSection}.${key}` : key;
      if (currentComment) {
        comments[fullKey] = currentComment.trim();
        currentComment = '';
      }
    }
    // Empty line resets comment
    else if (line === '') {
      currentComment = '';
    }
  }

  return comments;
}

/**
 * Convert parsed object to structured sections
 */
function objectToSections(obj: any, comments: Record<string, string>, prefix = ''): ConfigSection[] {
  const sections: ConfigSection[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (isPlainObject(value)) {
      // Nested section
      sections.push({
        name: key,
        description: comments[fullKey],
        fields: [],
        subsections: objectToSections(value, comments, fullKey),
      });
    } else {
      // Create or find section for this field
      let section = sections.find(s => s.name === 'General');
      if (!section) {
        section = { name: 'General', fields: [] };
        sections.push(section);
      }

      section.fields.push({
        key: fullKey,
        type: detectFieldType(value),
        value,
        description: comments[fullKey],
        constraints: extractConstraints(comments[fullKey]),
      });
    }
  }

  return sections;
}

/**
 * Detect field type from value
 */
export function detectFieldType(value: any): ConfigField['type'] {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

/**
 * Extract constraints from comment text
 * Example: "Range: 1 ~ 1000" or "Range: 0.5 ~ 5.0"
 */
export function extractConstraints(comment?: string): ConfigField['constraints'] | undefined {
  if (!comment) return undefined;

  const constraints: ConfigField['constraints'] = {};

  // Range: min ~ max
  const rangeMatch = comment.match(/Range:\s*([\d.]+)\s*~\s*([\d.]+)/i);
  if (rangeMatch) {
    constraints.min = parseFloat(rangeMatch[1]);
    constraints.max = parseFloat(rangeMatch[2]);
  }

  // Options: [a, b, c]
  const optionsMatch = comment.match(/Options:\s*\[(.*?)\]/i);
  if (optionsMatch) {
    constraints.options = optionsMatch[1].split(',').map(s => s.trim());
  }

  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

/**
 * Check if value is a plain object (not array, not null)
 */
export function isPlainObject(value: any): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Update config file with new values
 */
export async function updateConfigFile(
  filePath: string,
  updates: Record<string, any>
): Promise<void> {
  const format = detectFormat(filePath);
  const content = await fs.readFile(filePath, 'utf8');

  let parsed: any;

  switch (format) {
    case 'toml':
      parsed = TOML.parse(content);
      break;
    case 'json5':
    case 'json':
      parsed = JSON.parse(content);
      break;
    case 'yaml':
      parsed = yaml.load(content) as any;
      break;
    case 'properties':
      const props = PropertiesReader(filePath);
      parsed = props.getAllProperties();
      break;
  }

  // Apply updates
  for (const [key, value] of Object.entries(updates)) {
    setNestedValue(parsed, key, value);
  }

  // Serialize back
  let newContent: string;

  switch (format) {
    case 'toml':
      // TOML stringify not available in this library
      // We'll need to do line-by-line replacement to preserve comments
      newContent = updateTomlValues(content, updates);
      break;
    case 'json':
      newContent = JSON.stringify(parsed, null, 2);
      break;
    case 'json5':
      newContent = JSON5.stringify(parsed, null, 2);
      break;
    case 'yaml':
      newContent = yaml.dump(parsed);
      break;
    case 'properties':
      newContent = Object.entries(parsed)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      break;
  }

  await fs.writeFile(filePath, newContent, 'utf8');
}

/**
 * Update TOML values while preserving comments and formatting
 * Handles nested keys, sections, and different value types correctly
 */
function updateTomlValues(content: string, updates: Record<string, any>): string {
  const lines = content.split('\n');
  let currentSection = '';
  const updatedKeys = new Set<string>();

  // First pass: update existing keys
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Track section headers [section] or [section.subsection]
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Match key = value lines
    const keyMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
    if (keyMatch) {
      const fieldName = keyMatch[1];
      const fullKey = currentSection ? `${currentSection}.${fieldName}` : fieldName;

      // Check if this key needs updating
      if (fullKey in updates) {
        const indent = line.match(/^\s*/)?.[0] || '';
        const newValue = formatTomlValue(updates[fullKey]);
        lines[i] = `${indent}${fieldName} = ${newValue}`;
        updatedKeys.add(fullKey);
      }
    }
  }

  // Second pass: append keys that weren't found
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      const parts = key.split('.');
      if (parts.length > 1) {
        // Nested key - find or create the section
        const section = parts.slice(0, -1).join('.');
        const fieldName = parts[parts.length - 1];
        const sectionIndex = findOrAddSection(lines, section);
        const newValue = formatTomlValue(value);

        // Find the end of the section to append the new key
        let insertIndex = sectionIndex + 1;
        while (insertIndex < lines.length &&
               lines[insertIndex].trim() &&
               !lines[insertIndex].trim().startsWith('[')) {
          insertIndex++;
        }
        lines.splice(insertIndex, 0, `${fieldName} = ${newValue}`);
      } else {
        // Top-level key - add at the beginning (before first section)
        const newValue = formatTomlValue(value);
        let insertIndex = 0;
        while (insertIndex < lines.length && !lines[insertIndex].trim().startsWith('[')) {
          insertIndex++;
        }
        if (insertIndex > 0 && lines[insertIndex - 1].trim() !== '') {
          lines.splice(insertIndex, 0, '');
        }
        lines.splice(insertIndex, 0, `${key} = ${newValue}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a value for TOML syntax
 * Handles strings, numbers, booleans, arrays, and inline tables
 */
function formatTomlValue(value: any): string {
  if (value === null || value === undefined) {
    return '""';
  }

  if (typeof value === 'boolean') {
    return value.toString();
  }

  if (typeof value === 'number') {
    return value.toString();
  }

  if (typeof value === 'string') {
    // Escape special characters for TOML strings
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }

  if (Array.isArray(value)) {
    const items = value.map(v => formatTomlValue(v)).join(', ');
    return `[${items}]`;
  }

  if (typeof value === 'object') {
    // Inline table format
    const entries = Object.entries(value)
      .map(([k, v]) => `${k} = ${formatTomlValue(v)}`)
      .join(', ');
    return `{ ${entries} }`;
  }

  return String(value);
}

/**
 * Find a section in the lines array, or add it if missing
 * Returns the line index of the section header
 */
function findOrAddSection(lines: string[], section: string): number {
  const sectionHeader = `[${section}]`;

  // Look for existing section
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === sectionHeader) {
      return i;
    }
  }

  // Section not found - add it at the end
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
    lines.push('');
  }
  lines.push(sectionHeader);
  return lines.length - 1;
}

/**
 * Set nested value in object using dot notation
 */
function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current)) {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * List all config files in a directory
 */
export async function listConfigFiles(configDir: string): Promise<string[]> {
  const files: string[] = [];

  async function scan(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.toml', '.json', '.json5', '.yml', '.yaml', '.properties', '.cfg'].includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  await scan(configDir);
  return files;
}
