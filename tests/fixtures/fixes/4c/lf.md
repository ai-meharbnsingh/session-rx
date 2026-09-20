# Team rules

> Hand-maintained. Every space, tab and table pipe below is deliberate.

| ID  | Rule                                 | Violation |
|-----|--------------------------------------|-----------|
| T-1 | run the suite before every push      | BLOCK     |
| T-2 | never widen a public API in a hotfix | BLOCK     |

```bash
npm test   # the only gate
```

<!-- a comment that is NOT a session-rx marker -->
	tab-indented line, kept verbatim
