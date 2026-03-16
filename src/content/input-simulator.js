/**
 * input-simulator.js — Programmatic input for React/Angular/plain HTML forms.
 *
 * Validated by POC 3 (16 Playwright tests):
 * - Sequence B (nativeSetter + input + change) = minimum viable for React
 * - Sequence C (+ focus/blur) = recommended for portal compatibility
 * - Checkbox: must use .click() — setting .checked doesn't trigger React/Angular onChange
 * - Angular (Common App): accepts standard DOM events; nativeSetter also works
 * - Server-rendered (UC App): direct value + change works
 */

/**
 * Fill a text input, number input, or textarea with React/Angular compatibility.
 * Uses the native value setter to bypass framework property interception.
 */
function fillInput(element, value) {
  if (!element || value == null) return false;

  element.dispatchEvent(new Event("focus", { bubbles: true }));

  const proto =
    element.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;

  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (nativeSetter) {
    nativeSetter.call(element, String(value));
  } else {
    element.value = String(value);
  }

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("blur", { bubbles: true }));

  return true;
}

/**
 * Fill a <select> dropdown.
 */
function fillSelect(element, value) {
  if (!element || value == null) return false;

  element.dispatchEvent(new Event("focus", { bubbles: true }));

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(element, String(value));
  } else {
    element.value = String(value);
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("blur", { bubbles: true }));

  return true;
}

/**
 * Set a checkbox to checked or unchecked.
 * Must use .click() — setting .checked bypasses React/Angular change detection.
 */
function fillCheckbox(element, checked) {
  if (!element) return false;
  if (element.checked !== checked) {
    element.click();
  }
  return true;
}

/**
 * Select a radio button by clicking it.
 */
function fillRadio(element) {
  if (!element) return false;
  if (!element.checked) {
    element.click();
  }
  return true;
}

/**
 * Fill any form element based on its type.
 * @param {HTMLElement} element - The DOM element to fill
 * @param {*} value - The value to set
 * @returns {boolean} Whether the fill succeeded
 */
function fillElement(element, value) {
  if (!element) return false;

  const tag = element.tagName;
  const type = element.type?.toLowerCase();

  if (tag === "SELECT") {
    return fillSelect(element, value);
  }

  if (tag === "TEXTAREA") {
    return fillInput(element, value);
  }

  if (tag === "INPUT") {
    if (type === "checkbox") {
      return fillCheckbox(element, !!value);
    }
    if (type === "radio") {
      return fillRadio(element);
    }
    return fillInput(element, value);
  }

  // Fallback for contenteditable or unknown elements
  if (element.isContentEditable) {
    element.textContent = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  return false;
}

// Expose to other content scripts
window.__ciInputSimulator = {
  fillInput,
  fillSelect,
  fillCheckbox,
  fillRadio,
  fillElement,
};
