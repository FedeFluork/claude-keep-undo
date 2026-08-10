## Keep or Undo, change by change

Coloured bars appear in the gutter next to every line Claude touched. Click one
and VS Code's Quick Diff widget opens over the line, showing the original text
with **Keep** and **Undo** in its toolbar.

```
 12 │   const timeout = 30;
 13 │                                     ┌──────────────────────────┐
▌14 │   const retries = 5;                │  ✓ Keep      ↺ Undo      │
▌15 │   const backoff = "exponential";    └──────────────────────────┘
 16 │
```

- **Keep** folds the change into the baseline: it stops being pending, and the
  file on disk is left exactly as it is.
- **Undo** puts the original lines back. A copy of the current content is saved
  first, and the write goes through the editor, so `Ctrl+Z` / `Cmd+Z` also
  reverses it.

## The same two actions, everywhere

| Where | How |
|---|---|
| Gutter | Click a bar → Quick Diff widget |
| Keyboard | `Ctrl+Alt+K` keep · `Ctrl+Alt+U` undo · `Ctrl+Alt+N` / `Ctrl+Alt+P` to move |
| Lightbulb | `Ctrl+.` inside a change |
| Line numbers | Right-click a line number |
| Changes view | Inline buttons on each row |
| Diff editor | A `Keep · Undo` row above each change |
