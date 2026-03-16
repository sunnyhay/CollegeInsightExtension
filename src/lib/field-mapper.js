/**
 * field-mapper.js — Maps Twin API data to portal form fields using portal-map definitions.
 *
 * Given a portal map section and Twin data, resolves each field's twinPath to a value
 * and applies any twinTransform to format it for the portal.
 */

/**
 * Resolve a dot-path like "demographics.displayName" or "activities[0].name"
 * against a data object.
 * @param {object} data - Twin API response data
 * @param {string} path - Dot notation path, may include array brackets
 * @returns {*} Resolved value or undefined
 */
function resolvePath(data, path) {
  if (!data || !path) return undefined;

  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = data;

  for (const segment of segments) {
    if (current == null) return undefined;
    current = current[segment];
  }

  return current;
}

/**
 * Apply a transform to a Twin value before filling into a portal field.
 * @param {*} value - Raw value from Twin data
 * @param {string|null} transform - Transform name (e.g., "firstName", "truncate:150")
 * @returns {*} Transformed value
 */
function applyTransform(value, transform) {
  if (!transform || value == null) return value;

  if (transform === "firstName") {
    return String(value).split(/\s+/)[0] || value;
  }

  if (transform === "lastName") {
    const parts = String(value).split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : value;
  }

  if (transform.startsWith("truncate:")) {
    const max = parseInt(transform.split(":")[1], 10);
    const str = String(value);
    return str.length > max ? str.substring(0, max) : str;
  }

  if (transform.startsWith("truncateWords:")) {
    const maxWords = parseInt(transform.split(":")[1], 10);
    const words = String(value).split(/\s+/);
    return words.length > maxWords ? words.slice(0, maxWords).join(" ") : value;
  }

  if (transform === "yearToGradDate") {
    return `June ${value}`;
  }

  if (transform === "rankNumber") {
    // classRank might be "12/450" — extract the rank
    const match = String(value).match(/^(\d+)/);
    return match ? match[1] : value;
  }

  if (transform === "rankTotal") {
    const match = String(value).match(/\/(\d+)/);
    return match ? match[1] : value;
  }

  if (transform === "arrayLength") {
    return Array.isArray(value) ? String(value.length) : "0";
  }

  return value;
}

/**
 * Map Twin data to portal fields for a given section.
 *
 * @param {object} sectionMap - The portal map section definition
 * @param {object} twinData - Twin API response for the relevant endpoint
 * @param {number} [entryIndex] - For repeating sections, the activity/essay index
 * @returns {{ selector: string, value: *, label: string, filled: boolean, flagged: boolean, reason?: string }[]}
 */
function mapFieldsToValues(sectionMap, twinData, entryIndex = 0) {
  const fields = sectionMap.repeating
    ? sectionMap.entryFields
    : sectionMap.fields;

  if (!fields) return [];

  // For repeating sections with resolvedEntries, use the pre-computed IDs
  const resolved = sectionMap.resolvedEntries?.[entryIndex] ?? null;

  return fields
    .map((field) => {
      // Skip checkbox groups — handled separately
      if (field.type === "checkboxGroup") {
        return mapCheckboxGroup(field, twinData, entryIndex, resolved);
      }

      // Resolve the twinPath (replace {i} with entryIndex)
      const path = field.twinPath?.replace(/\{i\}/g, String(entryIndex));
      const rawValue = resolvePath(twinData, path);
      const value = applyTransform(rawValue, field.twinTransform);

      // Resolve the selector (use template if available, else static)
      let selector = field.portalSelector;
      if (field.portalSelectorTemplate && resolved) {
        selector = field.portalSelectorTemplate.replace(
          /\{(\w+)\}/g,
          (_, key) => resolved[key] ?? key,
        );
      } else if (field.portalSelectorTemplate) {
        selector = field.portalSelectorTemplate.replace(
          /\{i\}/g,
          String(entryIndex),
        );
      }

      const filled = value != null && value !== "";
      const flagged =
        !!field.maxLength && String(value || "").length > field.maxLength;

      return {
        selector,
        value: filled ? value : null,
        label: field.portalLabel,
        inputType: field.inputType,
        filled,
        flagged,
        reason: flagged
          ? `Value exceeds max length (${String(value).length}/${field.maxLength})`
          : undefined,
      };
    })
    .flat();
}

/**
 * Map a checkbox group (e.g., participation grades) to individual checkbox fills.
 */
function mapCheckboxGroup(field, twinData, entryIndex, resolved) {
  const path = field.options?.[0]?.twinPath?.replace(
    /\{i\}/g,
    String(entryIndex),
  );
  const twinArray = resolvePath(twinData, path);

  return field.options.map((opt) => {
    // Determine if this checkbox should be checked
    const shouldCheck = Array.isArray(twinArray)
      ? twinArray.includes(opt.twinValue)
      : false;

    // Resolve selector — replace optionId first, then resolved keys
    let selector = field.portalSelectorTemplate;
    selector = selector.replace(/\{optionId\}/g, opt.optionId);
    if (resolved) {
      selector = selector.replace(
        /\{(\w+)\}/g,
        (_, key) => resolved[key] ?? key,
      );
    }

    return {
      selector,
      value: shouldCheck,
      label: `${field.portalLabel}: ${opt.label}`,
      inputType: "checkbox",
      filled: true,
      flagged: false,
    };
  });
}

// Expose to other content scripts
if (typeof window !== "undefined") {
  window.__ciFieldMapper = {
    resolvePath,
    applyTransform,
    mapFieldsToValues,
  };
}

// CommonJS export for testing
if (typeof module !== "undefined") {
  module.exports = { resolvePath, applyTransform, mapFieldsToValues };
}
