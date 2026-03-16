/**
 * Unit Tests: input-simulator.js
 *
 * Tests the input simulation LOGIC (argument validation, return values).
 * Actual DOM interaction is tested via the E2E Playwright spec
 * (CollegeMatchFrontend/test/e2e/extension-fill.spec.js).
 */

// ── Input Simulation Functions (extracted logic) ───────────────────────────────

function fillTextInput(element, value) {
  if (!element || value == null)
    return { success: false, reason: "invalid_args" };
  return { success: true, value: String(value) };
}

function fillSelect(element, value) {
  if (!element || value == null)
    return { success: false, reason: "invalid_args" };
  if (!element.options || element.options.length === 0)
    return { success: false, reason: "no_options" };
  const match = element.options.find(
    (o) =>
      o.value === String(value) ||
      o.text.toLowerCase() === String(value).toLowerCase(),
  );
  if (!match) return { success: false, reason: "option_not_found", value };
  return { success: true, value: match.value };
}

function fillCheckbox(element, checked) {
  if (!element) return { success: false, reason: "invalid_args" };
  return { success: true, checked: Boolean(checked) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("fillTextInput — validation logic", () => {
  it("returns success for valid element + value", () => {
    const result = fillTextInput({}, "Alice");
    expect(result.success).toBe(true);
    expect(result.value).toBe("Alice");
  });

  it("converts numeric value to string", () => {
    const result = fillTextInput({}, 3.7);
    expect(result.success).toBe(true);
    expect(result.value).toBe("3.7");
  });

  it("converts integer to string", () => {
    const result = fillTextInput({}, 1350);
    expect(result.value).toBe("1350");
  });

  it("returns failure for null element", () => {
    expect(fillTextInput(null, "val").success).toBe(false);
  });

  it("returns failure for undefined element", () => {
    expect(fillTextInput(undefined, "val").success).toBe(false);
  });

  it("returns failure for null value", () => {
    expect(fillTextInput({}, null).success).toBe(false);
  });

  it("returns failure for undefined value", () => {
    expect(fillTextInput({}, undefined).success).toBe(false);
  });

  it("handles empty string value", () => {
    const result = fillTextInput({}, "");
    expect(result.success).toBe(true);
    expect(result.value).toBe("");
  });

  it("handles boolean value", () => {
    const result = fillTextInput({}, true);
    expect(result.value).toBe("true");
  });
});

describe("fillSelect — validation logic", () => {
  const makeOptions = (...items) =>
    items.map(([value, text]) => ({ value, text }));

  it("returns success for matching value", () => {
    const el = {
      options: makeOptions(["CA", "California"], ["NY", "New York"]),
    };
    expect(fillSelect(el, "CA").success).toBe(true);
  });

  it("returns success for matching text (case-insensitive)", () => {
    const el = { options: makeOptions(["CA", "California"]) };
    expect(fillSelect(el, "california").success).toBe(true);
  });

  it("returns failure for no matching option", () => {
    const el = { options: makeOptions(["CA", "California"]) };
    const result = fillSelect(el, "TX");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("option_not_found");
  });

  it("returns failure for null element", () => {
    expect(fillSelect(null, "CA").success).toBe(false);
  });

  it("returns failure for null value", () => {
    const el = { options: makeOptions(["CA", "California"]) };
    expect(fillSelect(el, null).success).toBe(false);
  });

  it("returns failure for empty options", () => {
    const el = { options: [] };
    expect(fillSelect(el, "CA").success).toBe(false);
  });
});

describe("fillCheckbox — validation logic", () => {
  it("returns success with true", () => {
    const result = fillCheckbox({}, true);
    expect(result.success).toBe(true);
    expect(result.checked).toBe(true);
  });

  it("returns success with false", () => {
    const result = fillCheckbox({}, false);
    expect(result.success).toBe(true);
    expect(result.checked).toBe(false);
  });

  it("returns failure for null element", () => {
    expect(fillCheckbox(null, true).success).toBe(false);
  });

  it("coerces truthy value to boolean", () => {
    expect(fillCheckbox({}, 1).checked).toBe(true);
    expect(fillCheckbox({}, "yes").checked).toBe(true);
    expect(fillCheckbox({}, 0).checked).toBe(false);
  });
});
