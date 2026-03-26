# Architecture

## Design overview

I implemented the validator as a deterministic orchestrator that runs one logical worker per endpoint. Each worker follows the same flow:

1. Resolve the correct Composio connected account for the endpoint's toolkit at runtime.
2. Build a minimal executable request from the endpoint definition.
3. Resolve any path parameter dependencies by discovering or creating a usable resource first.
4. Execute the request through `composio.tools.proxyExecute()`.
5. Classify the response as `valid`, `invalid_endpoint`, `insufficient_scopes`, or `error`.
6. Cache successful resources so later endpoint workers can reuse discovered IDs.

The implementation is intentionally more planner/executor than "free-form LLM agent". For this problem, reliability matters more than open-ended reasoning. The agent behavior comes from runtime heuristics and dependency discovery, but execution stays constrained and auditable.

## Dependency resolution

Path parameter resolution is generic and data-driven:

- The agent infers the toolkit from `tool_slug`.
- For endpoints with path params like `{messageId}` or `{eventId}`, it first checks a shared resource cache.
- If nothing is cached, it searches same-toolkit endpoints for likely producers, preferring:
  - `GET` endpoints on the collection path
  - then `POST` endpoints on the same collection path if a resource must be created
- Any successful response is scanned recursively for `id` fields and stored under a resource key derived from the path.

This supports the common pattern:

- list resources
- pick one ID
- call detail or mutation endpoint

It also handled delete-event validation by reusing an event created earlier in the run.

## Avoiding false negatives

The main design goal was to avoid misclassifying real endpoints as broken because of my own request construction. I used four safeguards:

1. Minimal safe request construction
   - Query params use conservative defaults.
   - Required bodies are built from schema and field descriptions.
   - Gmail payloads use a valid RFC 2822 message encoded as base64url.
   - Calendar create payloads use RFC3339 timestamps.

2. Dynamic dependency resolution
   - The agent does not invent IDs.
   - It fetches or creates prerequisite resources before calling detail or mutation endpoints.

3. Retry with request normalization
   - If a `404` HTML response reveals a duplicated proxy prefix, the agent strips the duplicated prefix and retries.
   - This was necessary for Google Calendar in this environment, where the proxy effectively added `/calendar/v3` twice.

4. Separate internal state from report sanitization
   - The agent keeps raw execution data for follow-up requests.
   - Sensitive or verbose fields are sanitized only when writing the final report.

## Classification logic

Classification is deterministic:

- `valid`: any `2xx`
- `invalid_endpoint`: `404`, `405`, or explicit "not found"/"method not allowed" signals
- `insufficient_scopes`: `403` or explicit permission-related errors
- `error`: everything else

This keeps the decision boundary simple and predictable. The report includes the HTTP code, a short summary, the sanitized response body, required scopes, and observed available scopes from the connected account.

## Architecture pattern

I chose a shared-orchestrator plus per-endpoint worker pattern.

Why this pattern:

- It still gives each endpoint an isolated validation flow.
- It allows dependency sharing through a resource cache.
- It avoids hardcoded execution order while still letting one endpoint benefit from data discovered by another.
- It is much easier to reason about and debug than a single monolithic agent loop.

Pros:

- Generic across apps that follow common REST resource patterns
- Easy to inspect and extend
- Low risk of hidden agent mistakes

Cons:

- Resource inference is heuristic rather than schema-perfect
- The current runner executes sequentially for safety and simplicity, though the workers are architected so bounded parallelism could be added

## Tradeoffs and improvements

Tradeoffs made for the time box:

- I prioritized deterministic execution over LLM-heavy reasoning.
- I used heuristics for toolkit inference and resource discovery instead of introducing a more elaborate planning layer.
- Cleanup is best-effort for created calendar events, not a full resource lifecycle manager for every app.

With more time I would improve:

- bounded parallel execution with lock-aware resource sharing
- richer dependency graph scoring instead of path-shape heuristics alone
- better scope inference by comparing required scopes against auth metadata more explicitly
- generic cleanup contracts for created resources across apps
- a second-pass repair strategy for `400` errors that tries alternate minimal payloads before classifying as `error`

## Notes from this run

In this sample run, the agent classified:

- 13 endpoints as `valid`
- 3 endpoints as `invalid_endpoint`
- 0 endpoints as `insufficient_scopes`
- 0 endpoints as `error`

The invalid endpoints were the intentionally fake ones in the sample set:

- `GMAIL_LIST_FOLDERS`
- `GMAIL_ARCHIVE_MESSAGE`
- `GOOGLECALENDAR_LIST_REMINDERS`
