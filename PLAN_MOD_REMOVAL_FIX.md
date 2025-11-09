# Plan: Fix Mod Removal Race Condition

## Problem Statement
In `/apps/agent/src/index.ts`, the DELETE `/mods/:fileName` endpoint (lines 600-635) has a critical bug:

1. Line 612: Deletes the mod file with `fs.unlinkSync(filePath)`
2. Line 616: Attempts to extract metadata from the deleted file with `await extractModMetadata(filePath)`

This fails because the file no longer exists, preventing config files from being removed.

## Root Cause
The order of operations is incorrect. The file is deleted before extracting the metadata needed to identify and remove associated config files.

## Solution
Reorder operations to extract metadata BEFORE deleting the file:

```typescript
// OLD (buggy):
fs.unlinkSync(filePath);  // Delete first
if (removeConfigs === 'true') {
  const metadata = await extractModMetadata(filePath);  // FAILS - file deleted!
  // ... remove configs
}

// NEW (fixed):
let metadata = null;
if (removeConfigs === 'true') {
  metadata = await extractModMetadata(filePath);  // Extract BEFORE delete
}
fs.unlinkSync(filePath);  // Delete after extracting metadata
if (metadata) {
  // ... remove configs
}
```

## Implementation Steps

1. **Read metadata before deletion** (if removeConfigs is true)
   - Extract metadata while file still exists
   - Store in a variable for later use

2. **Delete the mod file**
   - After metadata extraction
   - Use `fs.unlinkSync(filePath)`

3. **Remove config files** (if metadata was extracted)
   - Use the previously extracted metadata
   - Remove mod-specific config directory
   - Remove mod-specific config file

## Testing

### Unit Test Cases
1. Delete mod without removing configs - should succeed
2. Delete mod with config removal - should remove both mod and configs
3. Delete mod with config removal where metadata extraction fails - should still delete mod
4. Delete non-existent mod - should return 404

### Manual Testing
1. Install a mod with configs (e.g., JourneyMap, JEI)
2. Verify config files exist in `/opt/minecraft/config/`
3. Delete mod with `removeConfigs=true`
4. Verify both mod JAR and config files are removed
5. Check no errors in agent logs

## Additional Improvements

1. **Better error handling**
   - If metadata extraction fails, still delete the mod
   - Log warning if config removal fails
   - Don't fail the entire operation

2. **Add logging**
   - Log when configs are removed
   - Log if metadata extraction fails
   - Helps with debugging

3. **Transaction-like behavior**
   - Consider keeping the mod if config removal fails?
   - Or just log the failure and continue?
   - Current behavior: always delete mod, best-effort on configs

## Code Changes

File: `/home/cordt/repos/mclauncher/apps/agent/src/index.ts`

Lines to modify: 600-635

```typescript
// Delete mod
app.delete("/mods/:fileName", async (req, res) => {
  try {
    const { fileName } = req.params;
    const { removeConfigs } = req.query;

    const modsDir = path.join(MC_DIR, "mods");
    const filePath = path.join(modsDir, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Mod not found" });
    }

    // Extract metadata BEFORE deleting if we need to remove configs
    let metadata = null;
    if (removeConfigs === 'true') {
      try {
        metadata = await extractModMetadata(filePath);
      } catch (err) {
        console.warn(`Failed to extract metadata for ${fileName}, configs may not be removed:`, err);
      }
    }

    // Delete the mod file
    fs.unlinkSync(filePath);

    // Remove config files if we have metadata
    if (metadata) {
      const configDir = path.join(MC_DIR, "config");
      const modConfigDir = path.join(configDir, metadata.modId);
      const modConfigFile = path.join(configDir, `${metadata.modId}.toml`);

      try {
        if (fs.existsSync(modConfigDir)) {
          fs.rmSync(modConfigDir, { recursive: true, force: true });
        }
        if (fs.existsSync(modConfigFile)) {
          fs.unlinkSync(modConfigFile);
        }
      } catch (err) {
        console.warn(`Failed to remove config files for ${metadata.modId}:`, err);
      }
    }

    res.json({ ok: true, message: "Mod removed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

## Success Criteria
- ✅ Mod removal works with removeConfigs=false
- ✅ Mod removal works with removeConfigs=true
- ✅ Config files are actually removed when removeConfigs=true
- ✅ No errors when metadata extraction fails
- ✅ Proper error messages in all failure cases
- ✅ Code builds without errors

## Risk Assessment
- **Risk Level**: Low
- **Scope**: Single function, well-isolated
- **Testing**: Can be tested easily with manual verification
- **Rollback**: Simple revert if issues arise
