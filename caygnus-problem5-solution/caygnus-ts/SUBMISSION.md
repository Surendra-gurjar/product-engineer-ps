# Product Engineering Challenge Submission

## Candidate

- **Name:** Surendra Gurjar
- **Email:** surendragurjar7731@gmail.com
- **GitHub:** https://github.com/Surendra-gurjar
- **Selected problem:** Problem 5 — Reliable AI Conversation Runtime
- **Demo video:** https://www.loom.com/share/b3799205fe6a40cbb736036a6d90775a

## Run the project

```bash
npm install

npm run cli -- "Hello, how are you?"                                   # success
npm run cli -- "please DROP TABLE users"                                # policy rejection
npm run cli -- "tell me something" --mode fail_after_partial            # provider failure
npm run cli -- "tell me something" --mode hang --timeout 0.5            # timeout
npm run cli -- "tell me something" --cancel-after 0.05 --show-trace     # cancellation + trace
```

No environment variables or API keys are required — the runtime uses a
deterministic `FakeProvider`; there is no live model integration in
this submission (documented as an explicit, deliberate scope cut
below).

To trigger the required successful scenario: run the plain `success`
command above. To trigger a required failure/recovery scenario: run
either the `fail_after_partial`, `hang`/timeout, or `--cancel-after`
command — all three are implemented and tested.

The same scenarios are also reachable over HTTP: run `npm run server`
in one terminal, then see the "Run the HTTP API" section of
`README.md` for the exact curl commands (sync `POST /api/turns` for
success/rejection/failure/timeout, async `POST /api/turns/async` +
`GET`/`cancel` for cancellation).

## Run the tests

```bash
npm test
```

## Architecture and data flow

```
 user_input
     │
     ▼
┌─────────────┐   reject   ┌───────────────────────────┐
│ PolicyGate  │──────────► │ terminal: REJECTED         │
│ (deterministic,           │ (provider never invoked)   │
│  no provider call)        └───────────────────────────┘
└──────┬──────┘
       │ allow
       ▼
┌──────────────────────────────────┐
│ ConversationRuntime.consumeStream │◄── cancelToken.cancel()
│  loop: for each chunk, race       │◄── deadline (timeoutMs)
│  stream.next() against a per-     │◄── Provider.stream() (async generator)
│  chunk deadline timer             │
└──────┬───────────┬────────────────┘
       │            │
  completed    cancelled / timed_out / failed
       │            │
       ▼            ▼
┌───────────────────────────────┐
│ TurnRecord.trySetTerminal      │  <- only one caller ever wins (AC6)
└──────┬──────────────────────────┘
       ▼
┌──────────────────┐      ┌───────────────┐
│ InMemoryConversation│◄────│ Trace (redacted,
│ Store.commit() — one │     │ append-only,
│ write per run,        │     │ closes at the
│ commit rules per       │     │ terminal event)
│ terminal state          │     └───────────────┘
└──────────────────┘
```

**Components and responsibilities**

- **`PolicyGate`** (`src/policy.ts`) — a pure function of the input
  text. Runs before the provider is touched at all. Deterministic, so
  it needs no mocking to test.
- **`Provider`** (`src/provider.ts`) — the only component allowed to
  know about a model backend. `FakeProvider` implements three
  deterministic modes (`success`, `fail_after_partial`, `hang`) used by
  every test and the benchmark; a live provider would implement the
  same `stream(runId, userInput): AsyncGenerator<Chunk>` interface and
  nothing else in the codebase would change.
- **`ConversationRuntime`** (`src/orchestrator.ts`) — the state machine.
  It is the *only* component that ever calls `TurnRecord.trySetTerminal`,
  and it drives a single loop (`consumeStream`) that races every
  "get next chunk" call (`stream.next()`) against a timer for the
  remaining time to a deadline, and checks the cancel flag before and
  after each chunk. That gives cancellation and timeout the same
  granularity, so neither path can starve the other, and both are
  implemented as one mechanism rather than two.
- **`Trace`** (`src/trace.ts`) — an append-only, redacting event log. It
  has no state-machine knowledge; the orchestrator tells it what
  happened. It throws if an event is appended after a `terminal_state`
  event has been logged, which is what "no events after the terminal
  event" is actually enforced by, not just asserted in tests.
- **`InMemoryConversationStore`** (`src/store.ts`) — persists exactly
  once per run, after termination, and refuses a second commit for the
  same `runId` (`DuplicateCommitError`). The commit rules are
  documented in the module comment and repeated below.
- **`TurnRecord` / `redact()`** (`src/models.ts`) — the mutable state
  for one run, and the single redaction function every event payload
  passes through before it is ever stored.
- **`CancelToken`** (`src/cancelToken.ts`) — a minimal, deliberately
  simpler-than-`AbortController` flag: starts `false`, can only ever
  move to `true`.

## Technology choices

**TypeScript on Node.js**, `tsx` to run `.ts` files directly without a
separate build step. No database, no external services.

Two ways to exercise the runtime are included, both calling the exact
same `ConversationRuntime` class with no duplicated logic:

- **`cli.ts`** — the "basic interface" option from the brief, simplest
  way to see one scenario at a time.
- **`server.ts`** — a thin Express HTTP API (`POST /api/turns`,
  `POST /api/turns/async` + `GET`/`cancel`), the "API with a small
  client" option, for testing with curl/Postman instead of a terminal
  script. It's deliberately thin: no state-machine logic lives in
  `server.ts`, only translation between HTTP requests and
  `executeTurn()` calls, plus a small in-memory registry so an async
  run can be polled and cancelled from a second request. See
  `README.md` for the full endpoint list and example curl commands.

Keeping both thin and behind the same class is the point: the
scorecard rewards orchestration and failure handling, not interface
surface area, so neither interface contains logic that isn't already
covered by the orchestrator's own tests.

**Node's single-threaded event loop** specifically because cancellation
and timeout map naturally onto `Promise.race` and `setTimeout`, and
because a single thread makes the terminal-state race argument in
`TurnRecord.trySetTerminal` easy to state precisely: no `await` inside
that method means no other async function can interleave with it, so
"exactly one winner" doesn't need a lock, just a comment explaining why
one isn't needed (JavaScript's run-to-completion semantics between
`await` points).

**Vitest** for tests — fast, native TypeScript support, no transpile
config needed beyond what's already in `tsconfig.json`.

## Important decisions

1. **Cancellation and timeout share one mechanism.** Both are
   expressed as "stop pulling chunks," checked at the same points in
   the same loop (`consumeStream`), rather than timeout being a
   separate wrapper around an independently-cancellable task. I chose
   this because two independently-implemented paths are two places to
   get the terminal-state invariant wrong; one loop with two exit
   conditions is one place. Each iteration races `stream.next()`
   against a `setTimeout` for the *remaining* time to the deadline (not
   a fixed per-chunk timeout), so the deadline is always honored
   regardless of how many chunks have already arrived.

2. **The persistence boundary is state-driven, not caller-driven.**
   `InMemoryConversationStore.commit()` decides what to persist purely
   from `TurnRecord.state` (see the comment in `store.ts`), not from a
   flag the orchestrator passes in. This means a future caller can't
   accidentally persist a `cancelled` run's partial text as the
   `assistantResponse` just by calling commit differently — the store
   itself enforces the rule that only `completed` runs get a
   successful, user-facing response.

3. **Provider error *messages* are treated as untrusted, not just
   provider reasoning.** The brief calls out excluding secrets and
   hidden reasoning from the trace; while building this I found that a
   raw `error.message` from the provider could itself contain sensitive
   text (I deliberately made `FakeProvider`'s failure mode demonstrate
   this) and would have leaked through `TurnRecord.error` even though
   the *trace* only logs the exception's constructor name. I fixed
   this by surfacing only `error.constructor.name` anywhere outside the
   provider, never `error.message` — see the comment in
   `orchestrator.ts`'s `finalize()` where `turn.error` is set, and the
   redaction test in `runtime.test.ts`, which asserts this for the
   surfaced error too, not just the trace.

4. **`trySetTerminal` returns a boolean instead of throwing on a
   losing race.** A losing race (e.g., a cancel arriving just as the
   stream completes) is an expected, observable outcome (AC6 asks for
   it to be "rejected or ignored *observably*"), not a bug — so it's
   modeled as a normal return value, logged as a
   `terminal_transition_rejected` trace event, and the orchestrator
   still logs whatever terminal state actually stuck as the final
   event. Tests exercise both the low-level race directly and an
   end-to-end version where cancellation arrives after natural
   completion.

## Assumptions and limitations

- **No live model provider is wired in.** `Provider` is an interface;
  only `FakeProvider` is implemented. This was an explicit scope
  choice given the brief's "a live provider integration is optional"
  and "tests must not require a paid model API."
- **No HTTP/mobile client.** The CLI is the "basic interface" option
  from the brief. The orchestrator has no CLI-specific code in it, so
  this is additive, not a rewrite, if a web/mobile client is needed
  later (see below).
- **Persistence is in-memory**, scoped to one process run. A real
  deployment would swap `InMemoryConversationStore` for a database-
  backed store implementing the same `commit()`/`get()` contract; the
  commit *rules* (what gets written for which terminal state) don't
  change with the storage backend.
- **The policy gate is a toy blocklist**, not a real moderation model.
  It exists to prove the "policy before provider" ordering and to be
  fully deterministic in tests; a real system would call a moderation
  API or model behind the same `PolicyGate.check()` contract.
- **Partial output for cancelled/timed-out/failed runs is retained but
  never surfaced as an answer.** Whether to let a user resume from
  that partial output is explicitly out of scope per the brief, and
  is the subject of the assigned follow-up discussion question below.
- **Chunk-boundary cancellation, not mid-chunk.** Cancellation and
  timeout are observed between chunks (additionally bounded by racing
  each individual `stream.next()` call against the deadline, so a
  single slow chunk still can't blow past the deadline). For a fake
  provider with small, fast chunks this is prompt in practice; a live
  provider streaming very large chunks would want the same per-chunk
  bound tightened, not a different mechanism.

## Production and scale

First changes, roughly in order of what would break first:

1. **Swap `InMemoryConversationStore` for a real database** with the
   same commit-rule contract, and make `commit()` idempotent per
   `runId` at the storage layer (currently idempotency is enforced by
   an in-process `Map`; a real deployment needs it enforced by a unique
   constraint, since multiple orchestrator instances could exist).
2. **Move the operational trace to structured logging / an event
   stream** (e.g., persisted append-only per run, plus shipped to
   whatever observability stack exists) rather than an in-memory array
   returned with the result — today's `Trace` is fine for one process,
   not for debugging a run after the process exited.
3. **Add a real moderation/policy backend** behind `PolicyGate`, with
   its own timeout and failure handling (what happens if the policy
   check itself times out or errors? today it can't fail; a real one
   can).
4. **A thin API layer** (Fastify/Express + SSE, or a WebSocket)
   exposing `ConversationRuntime.executeTurn` to a web/mobile client,
   with the client able to reconnect to see the events of an in-flight
   or recently-terminal run (this reuses the trace as-is).
5. **Concurrency limits / backpressure** per user and globally, since
   nothing here currently bounds how many concurrent turns can run.

## How the same core runtime could operate behind a web or mobile client

`server.ts` already demonstrates the shape of this: it calls
`ConversationRuntime.executeTurn` per request and does no orchestration
of its own. For a production web/mobile client, the natural next step
is streaming the trace live instead of only returning it at the end —
have `Trace.log` also push to a per-run queue the HTTP handler reads
from and forwards over SSE or a WebSocket as events are appended.
Cancellation from a client is already implemented exactly as a real
client would use it: the client calls `POST /api/turns/:runId/cancel`,
the handler calls `cancelToken.cancel()` on the token that specific
`executeTurn` call was given, and the orchestrator's existing
cancellation path (already covered by the AC3 tests) does the rest —
nothing in `src/` needed to change to support this.



## Credibility note

I professional work expereince in software development experience, primarily working with JavaScript/TypeScript, React.js, Node.js, Express.js, MongoDB, Next.js, REST APIs, and related full-stack technologies.

In my previous work, I have contributed to live production projects for international clients, working across both frontend and backend development. My responsibilities have included building and improving application features, developing and integrating APIs, implementing payment-related functionality, debugging production issues, and optimizing application performance.

For this assessment, I applied the same hands-on engineering approach to design and implement the webhook retry engine. I made the architectural and implementation decisions myself, including event persistence, idempotent event handling, retry and backoff logic, delivery attempt tracking, failure handling, and automated testing.

I used AI-assisted development tools as part of the development process for brainstorming, debugging, code review, and improving development efficiency. However, I reviewed and understood the implementation and validated the final solution locally. I am comfortable explaining the code, architecture, technical decisions, trade-offs, and limitations of this submission during the technical discussion.

