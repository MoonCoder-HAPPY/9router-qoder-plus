// Qoder vision eligibility follows the live model catalog (is_vl). The
// catalog is authoritative: concrete model keys and tier aliases alike are
// accepted when Qoder marks them is_vl, and rejected otherwise (e.g. "lite"
// publishes is_vl:false). Earlier per-key exclusions were based on a
// misdiagnosed failure (a history-ordering bug, since fixed) and silently
// blocked models that do support image input.
export function supportsQoderImageInput(model) {
  const key = String(model?.key || model?.internalId || model?.id || "").trim().toLowerCase();
  if (!key) return false;
  return model?.isVL === true || model?.is_vl === true;
}
