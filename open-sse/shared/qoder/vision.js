const NON_NATIVE_IMAGE_KEYS = new Set([
  "auto",
  "ultimate",
  "performance",
  "efficient",
  "dmodel",
  "dfmodel",
]);

export function supportsQoderImageInput(model) {
  const key = String(model?.key || model?.internalId || model?.id || "").trim().toLowerCase();
  if (!key || NON_NATIVE_IMAGE_KEYS.has(key)) return false;
  return model?.isVL === true || model?.is_vl === true;
}
