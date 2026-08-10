## Why the hooks matter

To show you *what changed*, the extension needs the file exactly as it was
**before** Claude wrote to it. Claude Code can hand that over through two hooks:

```
PreToolUse   →  copy the file aside, untouched
PostToolUse  →  Claude has written; compare the two
```

They are registered in `.claude/settings.local.json` — Claude Code's
machine-local settings file, which is not the one you commit. Anything already
in that file is preserved, and a `.bak` copy is written before the first change.

## Without them

The extension falls back to reading the session transcript in
`~/.claude/projects`. That needs no setup and covers most edits, but an edit
whose original state cannot be reconstructed *exactly* is listed as
**not reviewable** rather than shown against a guessed baseline — because a
wrong baseline turns Undo into a way to lose work.

> Both detectors can be turned off independently under **Detection** in
> *Claude Keep/Undo: Settings and Setup*.
