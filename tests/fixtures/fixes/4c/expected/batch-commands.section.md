
<!-- session-rx:batch-commands:v1 -->
## SessionRx: batch commands
Batch independent read-only commands when safe; avoid repeating identical tool calls and reuse verified results.

Trigger: you are about to make a tool call while a question you are already answering is still open.

- One question, one call. Every command needed to answer a single question goes in that one call — reading four files, or `git status` + `git log -5` + `git diff --stat`, is one call, not four. Independent calls are issued together in the same message, not one per message.
- Do not re-run a call whose answer is already in context. Before repeating any call, re-read the result you already have and cite it.
- Re-run an identical call only when you can name what changed since the last run — a file you edited, a build you triggered, a service you restarted — and say what changed in the same message.
- Search once, broadly: one `rg`/`grep` across the tree beats one per directory. Narrow with flags, not with more calls.
- Five identical calls returning the same result in one session means the earlier results were never read. Stop, re-read them, and continue from there instead of calling a sixth time.
<!-- /session-rx:batch-commands:v1 -->
