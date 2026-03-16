const {
  resolvePath,
  applyTransform,
  mapFieldsToValues,
} = require("../src/lib/field-mapper");

// ═══════════════════════════════════════
// resolvePath
// ═══════════════════════════════════════
describe("resolvePath", () => {
  const data = {
    demographics: {
      displayName: "Alice Smith",
      email: "alice@example.com",
    },
    academic: {
      gpa: 3.92,
      satTotal: 1480,
      apExams: [
        { courseName: "AP Calculus BC", score: 5 },
        { courseName: "AP Physics C", score: 4 },
      ],
    },
    activities: [
      { name: "Robotics Club", role: "President", hoursPerWeek: 15 },
      { name: "Debate Team", role: "Captain", hoursPerWeek: 10 },
    ],
  };

  test("resolves simple dot path", () => {
    expect(resolvePath(data, "demographics.displayName")).toBe("Alice Smith");
  });

  test("resolves nested numeric value", () => {
    expect(resolvePath(data, "academic.gpa")).toBe(3.92);
  });

  test("resolves array bracket notation", () => {
    expect(resolvePath(data, "activities[0].name")).toBe("Robotics Club");
    expect(resolvePath(data, "activities[1].role")).toBe("Captain");
  });

  test("resolves nested array objects", () => {
    expect(resolvePath(data, "academic.apExams[0].score")).toBe(5);
    expect(resolvePath(data, "academic.apExams[1].courseName")).toBe(
      "AP Physics C",
    );
  });

  test("returns undefined for missing path", () => {
    expect(resolvePath(data, "demographics.phone")).toBeUndefined();
    expect(resolvePath(data, "activities[5].name")).toBeUndefined();
  });

  test("returns undefined for null data", () => {
    expect(resolvePath(null, "demographics.name")).toBeUndefined();
  });

  test("returns undefined for null path", () => {
    expect(resolvePath(data, null)).toBeUndefined();
  });

  test("returns entire array", () => {
    expect(resolvePath(data, "academic.apExams")).toHaveLength(2);
  });
});

// ═══════════════════════════════════════
// applyTransform
// ═══════════════════════════════════════
describe("applyTransform", () => {
  test("firstName extracts first word", () => {
    expect(applyTransform("Alice Smith", "firstName")).toBe("Alice");
  });

  test("firstName handles single name", () => {
    expect(applyTransform("Alice", "firstName")).toBe("Alice");
  });

  test("lastName extracts rest after first word", () => {
    expect(applyTransform("Alice Smith", "lastName")).toBe("Smith");
  });

  test("lastName handles multi-part last name", () => {
    expect(applyTransform("Alice Van Der Berg", "lastName")).toBe(
      "Van Der Berg",
    );
  });

  test("truncate:N shortens long strings", () => {
    expect(applyTransform("Hello World!", "truncate:5")).toBe("Hello");
  });

  test("truncate:N returns short strings unchanged", () => {
    expect(applyTransform("Hi", "truncate:5")).toBe("Hi");
  });

  test("truncateWords:N limits word count", () => {
    expect(applyTransform("one two three four five", "truncateWords:3")).toBe(
      "one two three",
    );
  });

  test("truncateWords:N returns fewer words unchanged", () => {
    expect(applyTransform("one two", "truncateWords:5")).toBe("one two");
  });

  test("yearToGradDate prepends June", () => {
    expect(applyTransform("2027", "yearToGradDate")).toBe("June 2027");
  });

  test("rankNumber extracts from '12/450'", () => {
    expect(applyTransform("12/450", "rankNumber")).toBe("12");
  });

  test("rankTotal extracts from '12/450'", () => {
    expect(applyTransform("12/450", "rankTotal")).toBe("450");
  });

  test("arrayLength returns count", () => {
    expect(applyTransform([1, 2, 3], "arrayLength")).toBe("3");
  });

  test("arrayLength returns '0' for non-array", () => {
    expect(applyTransform("not-array", "arrayLength")).toBe("0");
  });

  test("null transform returns value as-is", () => {
    expect(applyTransform("hello", null)).toBe("hello");
  });

  test("null value returns null regardless of transform", () => {
    expect(applyTransform(null, "firstName")).toBeNull();
  });

  test("unknown transform returns value as-is", () => {
    expect(applyTransform("hello", "unknownTransform")).toBe("hello");
  });
});

// ═══════════════════════════════════════
// mapFieldsToValues
// ═══════════════════════════════════════
describe("mapFieldsToValues", () => {
  const twinData = {
    demographics: {
      displayName: "Alice Smith",
      email: "alice@example.com",
    },
    academic: {
      gpa: 3.92,
      satTotal: 1480,
    },
  };

  test("maps simple non-repeating fields", () => {
    const section = {
      fields: [
        {
          portalSelector: "#gpa",
          portalLabel: "GPA",
          twinPath: "academic.gpa",
          inputType: "text",
        },
        {
          portalSelector: "#email",
          portalLabel: "Email",
          twinPath: "demographics.email",
          inputType: "text",
        },
      ],
    };

    const result = mapFieldsToValues(section, twinData);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      selector: "#gpa",
      value: 3.92,
      label: "GPA",
      filled: true,
      flagged: false,
    });
    expect(result[1]).toMatchObject({
      selector: "#email",
      value: "alice@example.com",
      filled: true,
    });
  });

  test("applies transforms", () => {
    const section = {
      fields: [
        {
          portalSelector: "#firstName",
          portalLabel: "First Name",
          twinPath: "demographics.displayName",
          twinTransform: "firstName",
          inputType: "text",
        },
      ],
    };

    const result = mapFieldsToValues(section, twinData);
    expect(result[0].value).toBe("Alice");
  });

  test("marks missing values as not filled", () => {
    const section = {
      fields: [
        {
          portalSelector: "#phone",
          portalLabel: "Phone",
          twinPath: "demographics.phone",
          inputType: "text",
        },
      ],
    };

    const result = mapFieldsToValues(section, twinData);
    expect(result[0]).toMatchObject({
      filled: false,
      value: null,
    });
  });

  test("flags values exceeding maxLength", () => {
    const section = {
      fields: [
        {
          portalSelector: "#name",
          portalLabel: "Name",
          twinPath: "demographics.displayName",
          inputType: "text",
          maxLength: 5,
        },
      ],
    };

    const result = mapFieldsToValues(section, twinData);
    expect(result[0].flagged).toBe(true);
    expect(result[0].reason).toContain("exceeds max length");
  });

  test("handles repeating sections with resolvedEntries", () => {
    const activitiesData = {
      activities: [
        { name: "Robotics", role: "Lead", hoursPerWeek: 15 },
        { name: "Debate", role: "Captain", hoursPerWeek: 10 },
      ],
    };

    const section = {
      repeating: true,
      entryFields: [
        {
          portalSelectorTemplate: "#text_ques_{nameId}",
          portalLabel: "Activity Name",
          twinPath: "activities[{i}].name",
          inputType: "text",
        },
        {
          portalSelectorTemplate: "#text_ques_{hoursId}",
          portalLabel: "Hours/Week",
          twinPath: "activities[{i}].hoursPerWeek",
          inputType: "text",
        },
      ],
      resolvedEntries: [
        { nameId: 930, hoursId: 936 },
        { nameId: 939, hoursId: 945 },
      ],
    };

    // Activity 0
    const r0 = mapFieldsToValues(section, activitiesData, 0);
    expect(r0[0]).toMatchObject({
      selector: "#text_ques_930",
      value: "Robotics",
      filled: true,
    });
    expect(r0[1]).toMatchObject({
      selector: "#text_ques_936",
      value: 15,
    });

    // Activity 1
    const r1 = mapFieldsToValues(section, activitiesData, 1);
    expect(r1[0]).toMatchObject({
      selector: "#text_ques_939",
      value: "Debate",
    });
    expect(r1[1]).toMatchObject({
      selector: "#text_ques_945",
      value: 10,
    });
  });

  test("handles checkbox groups", () => {
    const data = {
      activities: [{ participationGrades: [9, 11, 12] }],
    };

    const section = {
      repeating: true,
      entryFields: [
        {
          type: "checkboxGroup",
          portalLabel: "Grades",
          portalSelectorTemplate: "#cb-{cbBase}_{optionId}-input",
          options: [
            {
              optionId: "1422",
              label: "9",
              twinPath: "activities[{i}].participationGrades",
              twinValue: 9,
            },
            {
              optionId: "1423",
              label: "10",
              twinPath: "activities[{i}].participationGrades",
              twinValue: 10,
            },
            {
              optionId: "1424",
              label: "11",
              twinPath: "activities[{i}].participationGrades",
              twinValue: 11,
            },
            {
              optionId: "1425",
              label: "12",
              twinPath: "activities[{i}].participationGrades",
              twinValue: 12,
            },
          ],
        },
      ],
      resolvedEntries: [{ cbBase: 1 }],
    };

    const result = mapFieldsToValues(section, data, 0);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({
      selector: "#cb-1_1422-input",
      value: true,
      label: "Grades: 9",
    });
    expect(result[1]).toMatchObject({ value: false, label: "Grades: 10" }); // 10 not in array
    expect(result[2]).toMatchObject({ value: true, label: "Grades: 11" });
    expect(result[3]).toMatchObject({ value: true, label: "Grades: 12" });
  });

  test("returns empty array for null fields", () => {
    expect(mapFieldsToValues({}, {})).toEqual([]);
    expect(mapFieldsToValues({ fields: null }, {})).toEqual([]);
  });
});
