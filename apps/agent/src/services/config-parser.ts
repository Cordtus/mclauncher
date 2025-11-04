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
function detectFieldType(value: any): ConfigField['type'] {
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
function extractConstraints(comment?: string): ConfigField['constraints'] | undefined {
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
function isPlainObject(value: any): boolean {
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
 */
function updateTomlValues(content: string, updates: Record<string, any>): string {
  let lines = content.split('\n');

  for (const [key, value] of Object.entries(updates)) {
    const parts = key.split('.');
    const fieldName = parts[parts.length - 1];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith(fieldName + ' =') || line.startsWith(fieldName + '=')) {
        // Preserve indentation
        const indent = lines[i].match(/^\s*/)?.[0] || '';
        const valueStr = typeof value === 'string' ? `"${value}"` : String(value);
        lines[i] = `${indent}${fieldName} = ${valueStr}`;
        break;
      }
    }
  }

  return lines.join('\n');
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
