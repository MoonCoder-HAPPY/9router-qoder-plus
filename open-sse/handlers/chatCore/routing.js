export function resolveRequestModalityCapabilities(provider, capabilities) {
  if (!capabilities) return capabilities;
  return provider === "qoder"
    ? { ...capabilities, vision: true }
    : capabilities;
}
