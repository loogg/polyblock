/**
 * Pure capability matching helper with zero registry dependencies so core compilers
 * and extension modules never create circular imports with `capabilities/registry.ts`.
 *
 * - For a section ID `"packId.sectionId"`: enabled if `"packId.sectionId"` OR whole-pack `"packId"` is present.
 * - For a pack ID `"packId"`: enabled if `"packId"` OR any `"packId.*"` section is present.
 */
export function hasCapability(
  enabledCapabilities: string[],
  capabilityId: string,
): boolean {
  if (enabledCapabilities.includes(capabilityId)) return true;
  const dotIdx = capabilityId.indexOf('.');
  if (dotIdx > 0) {
    const parentPackId = capabilityId.slice(0, dotIdx);
    return enabledCapabilities.includes(parentPackId);
  }
  const prefix = `${capabilityId}.`;
  return enabledCapabilities.some((c) => c.startsWith(prefix));
}
