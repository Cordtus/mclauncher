# Plan: Fix TOML Config Parser Serialization

## Problem Statement
In `/apps/agent/src/services/config-parser.ts`, the `updateTomlValues` function (lines 291-311) has several issues:

1. **Incorrect field matching**: Only matches the last part of nested keys (e.g., "client.general.foo" only matches "foo")
2. **No context awareness**: Doesn't track which TOML table/section it's in
3. **Poor value formatting**: Doesn't handle arrays, booleans, or complex types correctly
4. **String escaping**: No proper escaping for strings with special characters
5. **Missing fields**: Doesn't handle adding new fields

## Current Implementation
```typescript
function updateTomlValues(content: string, updates: Record<string, any>): string {
  let lines = content.split('\n');

  for (const [key, value] of Object.entries(updates)) {
    const parts = key.split('.');
    const fieldName = parts[parts.length - 1];  // Only uses last part!

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith(fieldName + ' =') || line.startsWith(fieldName + '=')) {
        const indent = lines[i].match(/^\s*/)?.[0] || '';
        const valueStr = typeof value === 'string' ? `"${value}"` : String(value);
        lines[i] = `${indent}${fieldName} = ${valueStr}`;
        break;  // Stops at first match, even if wrong section!
      }
    }
  }

  return lines.join('\n');
}
```

## Why Not Use a TOML Serializer?
The current library `toml` is parse-only. Alternative libraries:
- `@iarna/toml` - has stringify but loses comments
- `@ltd/j-toml` - has stringify but loses comments
- **Comments are important** in mod config files for users

The line-by-line approach is correct conceptually, but needs better implementation.

## Solution: Improved Line-by-Line Replacement

### Algorithm
1. Parse TOML to get structure (for validation)
2. Track current table/section while iterating lines
3. Match keys within the correct section
4. Properly format different value types
5. Handle missing keys by appending to the right section

### Improved Implementation

```typescript
/**
 * Update TOML values while preserving comments and formatting
 * Handles nested keys, sections, and different value types
 */
function updateTomlValues(content: string, updates: Record<string, any>): string {
  const lines = content.split('\n');
  let currentSection = '';  // Track current [section]
  const updatedKeys = new Set<string>();

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
    const keyMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=(.*)$/);
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

  // Append keys that weren't found
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      // Find or create the appropriate section
      const parts = key.split('.');
      if (parts.length > 1) {
        const section = parts.slice(0, -1).join('.');
        const fieldName = parts[parts.length - 1];

        // Find the section or add it
        const sectionIndex = findOrAddSection(lines, section);
        const newValue = formatTomlValue(value);
        lines.splice(sectionIndex + 1, 0, `${fieldName} = ${newValue}`);
      } else {
        // Top-level key, add at the beginning
        const newValue = formatTomlValue(value);
        lines.unshift(`${key} = ${newValue}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a value for TOML format
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
    // Escape special characters
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }

  if (Array.isArray(value)) {
    const items = value.map(v => formatTomlValue(v)).join(', ');
    return `[${items}]`;
  }

  // Object/inline table
  const entries = Object.entries(value)
    .map(([k, v]) => `${k} = ${formatTomlValue(v)}`)
    .join(', ');
  return `{ ${entries} }`;
}

/**
 * Find a section in the lines, or add it if missing
 * Returns the line index of the section header
 */
function findOrAddSection(lines: string[], section: string): number {
  const sectionHeader = `[${section}]`;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === sectionHeader) {
      return i;
    }
  }

  // Section not found, add it at the end
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
    lines.push('');  // Add blank line before section
  }
  lines.push(sectionHeader);
  return lines.length - 1;
}
```

## Test Cases

### Test 1: Simple top-level key
```toml
# Input
foo = "bar"

# Update: { "foo": "baz" }
# Output
foo = "baz"
```

### Test 2: Nested key in section
```toml
[client]
# Enable feature
enabled = false

# Update: { "client.enabled": true }
# Output
[client]
# Enable feature
enabled = true
```

### Test 3: Deeply nested
```toml
[client.general]
foo = 1

# Update: { "client.general.foo": 42 }
# Output
[client.general]
foo = 42
```

### Test 4: Adding new field
```toml
[server]
port = 8080

# Update: { "server.host": "localhost" }
# Output
[server]
port = 8080
host = "localhost"
```

### Test 5: Different types
```toml
[config]
text = "hello"
number = 42
flag = true
list = [1, 2, 3]

# Update all with different values
# Should preserve types
```

## Implementation Steps

1. **Write helper functions**
   - `formatTomlValue()` - proper type formatting
   - `findOrAddSection()` - section management

2. **Rewrite `updateTomlValues()`**
   - Add section tracking
   - Match full keys, not just field names
   - Handle missing keys

3. **Add unit tests**
   - Test each scenario above
   - Test edge cases (empty file, missing sections, etc.)

4. **Integration testing**
   - Test with real mod config files
   - Verify comments are preserved
   - Verify formatting is maintained

## Risks and Mitigation

**Risk**: Breaking existing mod configs
**Mitigation**:
- Extensive testing with real config files
- Backup configs before modification (already done in the mod config editor)
- Gradual rollout

**Risk**: Edge cases in TOML syntax
**Mitigation**:
- Focus on common cases (simple values, arrays, sections)
- Add fallback to current method if parsing fails
- Log warnings for unsupported syntax

## Success Criteria
- ✅ Correctly updates nested keys
- ✅ Preserves comments
- ✅ Preserves formatting (indentation)
- ✅ Handles all basic types (string, number, boolean, array)
- ✅ Handles missing keys
- ✅ Handles missing sections
- ✅ All existing tests pass
- ✅ No regressions in mod config editing

## Alternative Considered: Full TOML Library

Could use `@iarna/toml` with stringify:
```bash
npm install @iarna/toml
```

Pros:
- Proper TOML serialization
- Handles all edge cases
- Less code to maintain

Cons:
- **Loses all comments** (deal-breaker for user configs)
- Changes formatting
- Adds dependency
- Not worth it for this use case

## Conclusion
Stick with improved line-by-line replacement. It's the right approach for preserving comments and formatting, just needs better implementation.
