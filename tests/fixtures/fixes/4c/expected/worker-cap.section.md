
<!-- session-rx:worker-cap:v1 -->
## SessionRx: worker cap
Keep concurrent sub-agents at or below half of the dispatched worker count unless a deliberate exception is documented.

Trigger: you are about to dispatch a sub-agent, or a second one.

How many at once
- At most 3 sub-agents run at the same time, and never more than half of what the task dispatches in total. Dispatch in batches, and wait for a batch to return before starting the next — twelve workers is four batches, not twelve at once.
- Two workers never own the same file. Each brief states the paths that worker owns and the paths it must not touch.

What each worker receives
- A brief, not a transcript: the task, the paths it owns, the paths it must not touch, and the exact command that proves it is done. Keep it under 6,000 characters.
- A sub-agent inherits no context. A decision, a path or a constraint it needs is restated in its brief, or it does not exist for that worker.
- Bound the worker: it returns after roughly 60 tool calls with what it has. Work that needs more is split into a second worker with a disjoint scope, not given a larger budget.

What comes back
- One written report, read once. No mid-task conversation. A worker that needs a decision writes the question in its report and stops.
- Every worker is stopped before the parent reports the task finished. An idle worker still holds its context.
<!-- /session-rx:worker-cap:v1 -->
