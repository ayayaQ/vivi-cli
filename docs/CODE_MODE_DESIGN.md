# Code Mode tools and permissions

## Tool catalog

The opt-in QuickJS runner exposes every other tool advertised for the active turn. The host resolves names again at dispatch. Commands, connected tools, and extensions use their direct executors. The worker pauses while awaiting results and resumes the same script. Code Mode itself is omitted to keep one owner and one call budget per query.

Workspace text creates and edits accumulate in order until the script finishes or invokes a tool other than workspace list, glob, search, or text read. Vivi prepares the batch and checks each file revision, workspace policy, and project guidance at commit. Other tool calls retain their individual approval requirements. Completed effects have receipts even when the script later fails.

## Review the whole query

Give the reviewer the user's request, the exact script, and the concrete effects the host can prepare together. For instance, a script that finds a string and replaces it in three files should produce one review showing all three paths and diffs. For a script that reads a file and sends a value to a service, show the source, the outgoing data, and the destination together, subject to existing disclosure rules. The combination can matter even when the individual calls look routine.

Host-permitted local reads can run during preparation. A read-only query needs no extra approval. For effects known in advance, collect the same proposals the direct tools would review and present them together before the first side effect. Apply the existing Manual, Auto, or Skip routing to the combined proposal. An action requiring human review keeps that requirement. A blocked action stays blocked. Auto review is eligible only when the policy covers every effect and the combination.

Bind approval to this run, script, tool identities, exact arguments, resource revisions, order constraints, and allowed number of calls. Before dispatch, the host matches each actual effect against an unused approved entry and rechecks the direct tool's preconditions. A matching call can proceed without another reviewer invocation. On cancellation, expiry, or a change of scope, discard unused approvals.

## Data-dependent effects

JavaScript can choose its next action using a tool result. If a command's output determines which file to edit, Vivi can review the command up front and show that a later edit may follow. Once the path, revision, and diff are known, pause before the edit and review it in the context of the original query and completed command. The same rule applies if the script discovers a new destination or a reviewed file changes. Resume from the pending action so an earlier command or remote request runs only once.

Keep a host receipt for each action under the parent query. If an edit succeeds and a later action fails or is denied, report both outcomes. A retry must account for completed effects. Pausing for human review should suspend the guest execution deadline while keeping turn cancellation active.

## Implementation checks

- A search and three independent, fully prepared edits produce one review and three distinct edit receipts.
- A Plan query cannot reach an Execute-only tool through a computed name.
- A computed destination outside the approved set triggers review before dispatch. A denied follow-up leaves earlier outcomes visible.
- Changing a file after approval invalidates its prepared edit. Repeating a tool call cannot spend the same approval twice, including during concurrent dispatch.
- Cancellation while waiting for review releases the worker and preserves the outcomes of actions already dispatched.
