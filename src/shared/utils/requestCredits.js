// Qoder credits column helpers (usage details tab).
//
// 9router already persists the credits Qoder actually deducted for a request in
// `requestDetails.tokens.credits` (the charged amount, after any promo
// discount). `original_credits` is the pre-discount list price; it is kept for
// accounting but is NOT a charge, so this module never displays it - showing it
// would overstate what the account paid.
//
// The column is Qoder-specific by design: every other provider must render a
// null cell. Detection is done on the normalized provider id so callers can pass
// either the raw row provider ("qoder") or a display label ("Qoder").

const QODER_PROVIDER_IDS = new Set(["qoder"]);

/**
 * Normalize a provider identifier for credit-column comparisons.
 * @param {*} provider - Raw provider id or display label
 * @returns {string} lowercased, trimmed provider id
 */
export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return "";
  return provider.trim().toLowerCase();
}

/**
 * Whether this row belongs to Qoder (the only provider that charges credits).
 * @param {*} provider - Raw provider id or display label
 * @returns {boolean} true when the credits column should apply
 */
export function isQoderProvider(provider) {
  return QODER_PROVIDER_IDS.has(normalizeProviderId(provider));
}

/**
 * Largest number of decimal places ever shown. Qoder reports values like
 * 0.09924420005714286; four decimals keeps the column narrow while staying
 * sensitive enough to distinguish single requests.
 */
const MAX_DECIMALS = 4;

/** Smallest amount visible at MAX_DECIMALS, i.e. 0.0001. */
const SMALLEST_VISIBLE = 1 / 10 ** MAX_DECIMALS;

/**
 * Strictly coerce a stored value into a usable credit amount.
 *
 * `Number(null)`, `Number("")` and `Number([])` are all 0, so a plain Number()
 * cast would turn "no credits recorded" into a real zero charge and make the
 * column claim Qoder billed nothing. Only numbers and non-empty numeric strings
 * are accepted, which is what a serialized row can actually contain.
 * @param {*} value - Raw stored value
 * @returns {number|null} finite non-negative amount, or null when unusable
 */
function toCreditAmount(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }
  return null;
}

/**
 * Resolve the credit amount actually charged for a row.
 * @param {object|null|undefined} tokens - Stored usage payload
 * @returns {number|null} finite non-negative charge, or null when unavailable
 */
export function getRequestCredits(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  return toCreditAmount(tokens.credits);
}

/**
 * Format a credit amount with the minimum precision needed.
 * Trailing zeros are dropped (0.5 -> "0.5", 0.0992 -> "0.0992") so the cell
 * stays compact. A real charge smaller than the display precision is rendered as
 * "<0.0001" rather than "0", so a billed request never looks free.
 * @param {number|null|undefined} credits - Credit amount
 * @returns {string|null} display string, or null when there is nothing to show
 */
export function formatCredits(credits) {
  const amount = toCreditAmount(credits);
  if (amount === null) return null;
  if (amount > 0 && amount < SMALLEST_VISIBLE) {
    return "<" + SMALLEST_VISIBLE.toFixed(MAX_DECIMALS);
  }
  const rounded = amount.toFixed(MAX_DECIMALS);
  // Trim trailing zeros so ordinary charges stay narrow, but keep a genuine
  // zero visible as "0" instead of an empty string.
  const trimmed = rounded.includes(".")
    ? rounded.replace(/0+$/, "").replace(/\.$/, "")
    : rounded;
  return trimmed === "" ? "0" : trimmed;
}

/**
 * Full cell value for a request/details row: null unless the provider is Qoder
 * and the row actually carries a credit amount.
 * @param {object|null|undefined} detail - Request detail row
 * @returns {string|null} display string, or null to render an empty cell
 */
export function getCreditsCellValue(detail) {
  if (!detail || !isQoderProvider(detail.provider)) return null;
  return formatCredits(getRequestCredits(detail.tokens));
}