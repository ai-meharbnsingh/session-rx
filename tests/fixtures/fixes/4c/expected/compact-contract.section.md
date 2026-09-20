
<!-- session-rx:compact-contract:v1 -->
## SessionRx: compact contract
When context pressure rises, compact deliberately: preserve active requirements, decisions, unresolved risks, and exact file paths before continuing.

Trigger: context is being compacted or summarized, or the session is being handed to another session.

PRESERVE, verbatim. A summary missing any of these has failed, however short it is:
- the exact command that runs the tests or the build, and its last exit code
- every file path created or modified in this session
- the task being worked on, and which declared steps are already finished
- every question waiting on the user, in the words it was asked
- identifiers that cannot be re-derived by reading the repo: branch name, commit SHAs, ticket or issue ids, URLs, ports, environment and service names

DROP, keeping one line each:
- tool output bodies — logs, diffs, file contents, test transcripts, directory listings. Keep the one-line conclusion and the path to the full output.
- superseded plans and abandoned approaches. Keep the decision that was reached, not the deliberation that reached it.

- A dropped fact is recovered by reading the file again, never by recalling it from memory.
- If a PRESERVE item is missing after a compaction, say which one is missing and re-read it. Do not continue on a guess, and do not re-derive a decision the user already made.
<!-- /session-rx:compact-contract:v1 -->
