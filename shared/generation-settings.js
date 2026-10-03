// Keep legacy settings serialization unchanged; target identity is server-owned.
const TARGET_VERSION = 'target-v1'
function normalizeGenerationSettings(submitted = {}) {
  const palettes = new Set(['72', '96', '144', '221', '238', '291'])
  const thresholds = new Set(['none', 'light', 'medium', 'strong', 'veryStrong'])
  const bound = value => Math.max(8, Math.min(160, Math.round(Number(value) || 64)))
  const settings = {
    sizeMode: submitted.sizeMode === 'image' ? 'image' : 'board',
    gridWidth: bound(submitted.gridWidth),
    gridHeight: bound(submitted.gridHeight),
    paletteSpec: palettes.has(String(submitted.paletteSpec)) ? String(submitted.paletteSpec) : '221',
    threshold: thresholds.has(String(submitted.threshold)) ? String(submitted.threshold) : 'none'
  }
  if (submitted.generationMode === 'target') {
    settings.generationMode = 'target'
    settings.targetVersion = TARGET_VERSION
  }
  return settings
}
module.exports = { normalizeGenerationSettings, TARGET_VERSION }
