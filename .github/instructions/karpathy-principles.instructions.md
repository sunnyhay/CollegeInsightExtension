---
applyTo: '**'
---
# Engineering Principles (Karpathy-inspired)

Behavioral guidelines to reduce common coding mistakes. These bias toward
caution over speed — for trivial tasks, use judgment. They supplement, not
replace, project-specific instructions.

## 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
- State assumptions explicitly in your response before implementing.
- If multiple interpretations exist, name them — don't silently pick one.
- If a simpler approach exists, say so and push back when warranted.
- Ask a clarifying question only when genuinely blocked or when the action
  is destructive/irreversible; otherwise infer the most reasonable intent,
  state the assumption, and proceed.

## 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or configurability that wasn't requested.
- No error handling for impossible scenarios — validate only at boundaries.
- If you write 200 lines and it could be 50, rewrite it.
- Test: "Would a senior engineer call this overcomplicated?" If yes, simplify.

## 3. Surgical Changes
Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Don't add docstrings/comments/types to code you didn't change.
- Remove imports/variables/functions that YOUR changes made unused.
- If you spot unrelated dead code, mention it — don't delete it unless asked.
- Test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution
Define success criteria. Loop until verified.
- Transform vague tasks into verifiable goals:
  - "Add validation" → write tests for invalid inputs, then make them pass.
  - "Fix the bug" → write a test that reproduces it, then make it pass.
  - "Refactor X" → ensure tests pass before and after.
- For multi-step work, state a brief plan with a verification per step:
  `1. [step] → verify: [check]`
- After editing, run the relevant build/lint/tests to confirm before
  reporting done.

Working if: fewer unnecessary diff changes, fewer rewrites from
overcomplication, and assumptions stated up front rather than mistakes after.
