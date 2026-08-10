## Where pending changes show up

```
EXPLORER
  ▾ CLAUDE: CHANGES TO REVIEW              (3)   ← count badge
      auth.ts          src/api  •  4 changes
      client.ts        src/api
      README.md
  ▾ src
      ✳ auth.ts                                   ← badge on the file
```

```
                                    ⟺ 3 Claude changes     ← status bar
```

Three signals, all optional:

- the **changes view** in the Explorer, with a count on its header;
- a **badge** next to the file itself (`✳` by default, and themeable);
- a **status bar** entry that opens everything pending in one diff.

Expanding a file lists its individual changes, each with its own Keep and Undo
buttons. Clicking a change jumps straight to it in the diff.
