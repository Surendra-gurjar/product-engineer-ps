# Reliable AI Conversation Runtime (TypeScript / Node.js)

A bounded runtime for one streamed conversational turn: policy gate →
provider streaming → exactly one terminal state (`completed`,
`rejected`, `cancelled`, `timed_out`, `failed`), with a redacted
operational trace and persistence rules that match what actually
happened. Built for the Caygnus Product Engineering Challenge,
**Problem 5**.

No live model, network access, or API key is required anywhere in this
repository — a deterministic `FakeProvider` stands in for a real model
provider, and the same `Provider` interface is what a live integration
would implement.

## Stack

Node.js 20+, TypeScript (strict mode), `tsx` for running `.ts` files
directly (no build step needed to demo or test), Vitest for tests. No
framework, no database, no external services.

## Setup (≈2 minutes)

```bash
npm install
```

No environment variables, no API keys, no external services.

## Run the demo (CLI)

```bash
# Successful streamed turn
npm run cli -- "Hello, how are you?"

# Pre-response policy rejection (provider is never called)
npm run cli -- "please DROP TABLE users"

# Provider fails after partial output
npm run cli -- "tell me something" --mode fail_after_partial

# Timeout: provider never finishes, runtime deadline cuts it off (0.5s)
npm run cli -- "tell me something" --mode hang --timeout 0.5

# Cancellation mid-stream, with the full operational trace printed
npm run cli -- "tell me something" --cancel-after 0.05 --show-trace
```

(`--` is required so npm passes the flags through to the script instead
of interpreting them itself. You can also run `npx tsx cli.ts "..."`
directly.)

## Run the HTTP API

A thin Express wrapper (`server.ts`) exposes the exact same
`ConversationRuntime` over HTTP, for testing with curl, Postman, or a
browser instead of the CLI. It has no state-machine logic of its own —
see `runtime` architecture below for where the real logic lives.

```bash
npm run server
# Conversation runtime API listening on http://localhost:3000
```

Leave that running in one terminal, then in another terminal (or in
Postman / Insomnia):

### 1. Health check (browser or curl, GET)

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### 2. Run one turn synchronously — `POST /api/turns`

The request blocks until the turn reaches a terminal state, then
returns the full result (state, output, trace) in one response. This
is the easiest endpoint to test every scenario with:

```bash
# success
curl -s -X POST http://localhost:3000/api/turns \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello there","mode":"success"}'

# policy rejection (mode is irrelevant, provider is never called)
curl -s -X POST http://localhost:3000/api/turns \
  -H "Content-Type: application/json" \
  -d '{"input":"please DROP TABLE users"}'

# provider failure after partial output
curl -s -X POST http://localhost:3000/api/turns \
  -H "Content-Type: application/json" \
  -d '{"input":"hi","mode":"fail_after_partial"}'

# timeout (provider hangs, timeoutMs cuts it off)
curl -s -X POST http://localhost:3000/api/turns \
  -H "Content-Type: application/json" \
  -d '{"input":"hi","mode":"hang","timeoutMs":300}'
```

Body fields: `input` (required, string), `timeoutMs` (optional, default
2000), `mode` (optional: `"success" | "fail_after_partial" | "hang"`,
default `"success"`).

### 3. Start a turn in the background — `POST /api/turns/async`

Returns immediately (`202`) with a `runId`, while the turn keeps
streaming in the background. Use this when you want to cancel a turn
from a separate request while it's still in flight:

```bash
curl -s -X POST http://localhost:3000/api/turns/async \
  -H "Content-Type: application/json" \
  -d '{"input":"hi there","mode":"success","timeoutMs":10000}'
# {"runId":"<uuid>","status":"accepted"}
```

### 4. Poll a run — `GET /api/turns/:runId`

```bash
curl http://localhost:3000/api/turns/<uuid>
# {"status":"in_progress"}                 -- while still running
# { ...full TurnResult... }                 -- once it reaches a terminal state
```

### 5. Cancel an in-flight run — `POST /api/turns/:runId/cancel`

```bash
curl -s -X POST http://localhost:3000/api/turns/<uuid>/cancel
# {"status":"cancel_requested"}   -- 202
# poll again afterwards; state should be "cancelled"

# cancelling an already-finished run returns 409:
curl -s -X POST http://localhost:3000/api/turns/<uuid>/cancel
# {"error":"run already reached a terminal state","state":"cancelled"}

# an unknown runId returns 404:
curl -s http://localhost:3000/api/turns/does-not-exist
# {"error":"no such run: does-not-exist"}
```

**Note:** the `runId` returned by `/api/turns/async` (the polling
handle) is a separate id from the `runId` field *inside* the
`TurnResult` once it's returned by `GET /api/turns/:runId` — the
outer one is assigned by the HTTP layer's in-memory registry, the
inner one by the orchestrator itself. Poll using the outer id.

## Run the tests

```bash
npm test
```

15 deterministic tests, no live model, no arbitrary sleeps (chunk
delays are small fixed values, tens of milliseconds). Covers: a
successful streamed + persisted turn, policy rejection proving the
provider was never invoked, cancellation mid-stream, timeout via a
provider that never finishes, provider failure after partial output, a
direct terminal-state race (two competing transitions, exactly one
wins), and secret/reasoning redaction in the trace and in the
surfaced error.

## Run the verification benchmark

```bash
npm run benchmark -- --iterations 10
```

Runs 10 (configurable) deterministic iterations each of: successful
completion, policy rejection, cancellation, timeout, and provider
failure. Reports terminal-state counts per scenario and flags any
violation of: exactly-one-terminal-state, rejected-never-invokes-
provider, non-completed-never-has-a-successful-response, and
no-events-after-terminal.

## Type-check

```bash
npm run typecheck
```

## Project layout

```
src/
  models.ts         state type, terminal-state sets, Event, TurnRecord (+ redact())
  policy.ts          deterministic pre-response policy gate
  provider.ts         Provider interface + FakeProvider (success/fail/hang modes)
  cancelToken.ts       minimal cancellation primitive
  trace.ts             append-only, redacting event log
  store.ts             persistence with documented commit rules
  orchestrator.ts      the state machine -- the only writer of turn state
cli.ts                small interactive demo
server.ts             thin Express HTTP API over the same runtime (see above)
benchmark.ts          repeatable N-iteration correctness benchmark
tests/runtime.test.ts
```

See `SUBMISSION.md` for architecture, decisions, trade-offs,
assumptions, and limitations.
