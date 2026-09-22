import { describe, expect, it } from "vitest";
import { CancelToken } from "../src/cancelToken.js";
import { redact, TurnRecord } from "../src/models.js";
import { ConversationRuntime } from "../src/orchestrator.js";
import { FakeProvider, type FakeProviderMode } from "../src/provider.js";
import { InMemoryConversationStore } from "../src/store.js";

const CHUNKS = ["Hel", "lo", ", ", "world", "!"];

function makeRuntime(
  opts: {
    mode?: FakeProviderMode;
    failAfter?: number;
    secretMarker?: string;
  } = {}
) {
  const provider = new FakeProvider({
    chunks: [...CHUNKS],
    chunkDelayMs: 10,
    ...opts,
  });
  return new ConversationRuntime(
    provider,
    undefined,
    new InMemoryConversationStore()
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AC1: successful streamed turn", () => {
  it("streams in order and persists the completed response", async () => {
    const runtime = makeRuntime({ mode: "success" });
    const result = await runtime.executeTurn("hello there", {
      timeoutMs: 5000,
    });

    expect(result.state).toBe("completed");
    expect(result.isSuccessful).toBe(true);
    expect(result.output).toBe(CHUNKS.join(""));

    const record = runtime.store.get(result.runId)!;
    expect(record.assistantResponse).toBe(CHUNKS.join(""));
    expect(record.partialOutput).toBeNull();

    const chunkEvents = result.trace.filter((e) => e.type === "chunk_received");
    expect(chunkEvents.map((e) => e.payload.index)).toEqual(
      CHUNKS.map((_, i) => i)
    );
    expect(result.trace.at(-1)!.type).toBe("terminal_state");
    expect(result.trace.at(-1)!.payload.state).toBe("completed");
  });

  it("completes exactly once", async () => {
    const runtime = makeRuntime({ mode: "success" });
    const result = await runtime.executeTurn("hello", { timeoutMs: 5000 });
    expect(
      result.trace.filter((e) => e.type === "terminal_state")
    ).toHaveLength(1);
  });
});

describe("AC2: pre-response rejection", () => {
  it("never invokes the provider for a rejected turn", async () => {
    let calls = 0;
    class CountingProvider extends FakeProvider {
      override async *stream(runId: string, userInput: string) {
        calls++;
        yield* super.stream(runId, userInput);
      }
    }
    const provider = new CountingProvider({
      chunks: [...CHUNKS],
      chunkDelayMs: 10,
    });
    const runtime = new ConversationRuntime(
      provider,
      undefined,
      new InMemoryConversationStore()
    );

    const result = await runtime.executeTurn("please DROP TABLE users", {
      timeoutMs: 5000,
    });

    expect(result.state).toBe("rejected");
    expect(result.isSuccessful).toBe(false);
    expect(calls).toBe(0);

    const record = runtime.store.get(result.runId)!;
    expect(record.assistantResponse).toBeNull();
    expect(record.partialOutput).toBeNull();

    const decisionEvent = result.trace.find(
      (e) => e.type === "policy_decision"
    )!;
    expect(decisionEvent.payload.allowed).toBe(false);
    expect(
      result.trace.filter((e) => e.type === "provider_invoked")
    ).toHaveLength(0);
  });

  it("rejects empty input", async () => {
    const runtime = makeRuntime({ mode: "success" });
    const result = await runtime.executeTurn("   ", { timeoutMs: 5000 });
    expect(result.state).toBe("rejected");
  });
});

describe("AC3: cancellation", () => {
  it("stops consumption and cannot later become completed", async () => {
    const runtime = makeRuntime({ mode: "success" });
    const cancelToken = new CancelToken();
    void sleep(15).then(() => cancelToken.cancel());

    const result = await runtime.executeTurn("hello", {
      timeoutMs: 5000,
      cancelToken,
    });

    expect(result.state).toBe("cancelled");
    expect(result.isSuccessful).toBe(false);

    const chunkEvents = result.trace.filter((e) => e.type === "chunk_received");
    expect(chunkEvents.length).toBeLessThan(CHUNKS.length);

    const record = runtime.store.get(result.runId)!;
    expect(record.assistantResponse).toBeNull();
    expect(record.state).toBe("cancelled");
  });
});

describe("AC4: timeout", () => {
  it("stops execution and marks the run as a non-successful timeout", async () => {
    const runtime = makeRuntime({ mode: "hang" });
    const result = await runtime.executeTurn("hello", { timeoutMs: 50 });

    expect(result.state).toBe("timed_out");
    expect(result.isSuccessful).toBe(false);

    const record = runtime.store.get(result.runId)!;
    expect(record.assistantResponse).toBeNull();
    expect(record.state).toBe("timed_out");

    expect(
      result.trace.filter((e) => e.type === "timeout_reached")
    ).toHaveLength(1);
  });
});

describe("AC5: provider failure after partial output", () => {
  it("is traceable and never recorded as successful", async () => {
    const runtime = makeRuntime({ mode: "fail_after_partial", failAfter: 2 });
    const result = await runtime.executeTurn("hello", { timeoutMs: 5000 });

    expect(result.state).toBe("failed");
    expect(result.isSuccessful).toBe(false);

    const chunkEvents = result.trace.filter((e) => e.type === "chunk_received");
    expect(chunkEvents).toHaveLength(2);

    expect(
      result.trace.filter((e) => e.type === "provider_error")
    ).toHaveLength(1);

    const record = runtime.store.get(result.runId)!;
    expect(record.assistantResponse).toBeNull();
  });
});

describe("AC6: terminal-state race", () => {
  it("lets only one transition win", () => {
    const turn = new TurnRecord("race-1", "x");

    const first = turn.trySetTerminal("completed");
    const second = turn.trySetTerminal("timed_out");
    const third = turn.trySetTerminal("cancelled");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
    expect(turn.state).toBe("completed");
  });

  it("does not let a late cancel flip an already-completed run", async () => {
    const runtime = makeRuntime({ mode: "success" });
    const cancelToken = new CancelToken();
    const lateTimer = setTimeout(() => cancelToken.cancel(), 5000).unref(); // long after the stream finishes

    try {
      const result = await runtime.executeTurn("hello", {
        timeoutMs: 5000,
        cancelToken,
      });
      expect(result.state).toBe("completed");
      expect(result.isSuccessful).toBe(true);
    } finally {
      clearTimeout(lateTimer);
    }
  });
});

describe("AC7: safe operational trace", () => {
  it("never contains the raw secret or provider reasoning", async () => {
    const secret = "sk-super-secret-value-12345";
    const runtime = makeRuntime({
      mode: "fail_after_partial",
      failAfter: 1,
      secretMarker: secret,
    });
    const result = await runtime.executeTurn("hello", { timeoutMs: 5000 });

    const serialized = JSON.stringify(result.trace);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("internal-thinking");
    expect(result.error ?? "").not.toContain(secret);
  });

  it("redacts a representative secret field and drops reasoning in place", () => {
    const payload = {
      api_key: "sk-should-not-leak",
      reasoning: "private chain of thought",
      index: 3,
    };
    const clean = redact(payload);

    expect(clean.api_key).toBe("[REDACTED]");
    expect(clean).not.toHaveProperty("reasoning");
    expect(clean.index).toBe(3);
  });
});

describe("no events after the terminal event", () => {
  const cases: Array<{
    mode: FakeProviderMode;
    timeoutMs: number;
    expected: string;
  }> = [
    { mode: "success", timeoutMs: 5000, expected: "completed" },
    { mode: "fail_after_partial", timeoutMs: 5000, expected: "failed" },
    { mode: "hang", timeoutMs: 50, expected: "timed_out" },
  ];

  for (const { mode, timeoutMs, expected } of cases) {
    it(`holds for terminal state '${expected}'`, async () => {
      const runtime = makeRuntime({ mode, failAfter: 1 });
      const result = await runtime.executeTurn("hello", { timeoutMs });
      expect(result.state).toBe(expected);

      const terminalIndices = result.trace
        .map((e, i) => (e.type === "terminal_state" ? i : -1))
        .filter((i) => i !== -1);
      expect(terminalIndices).toHaveLength(1);
      expect(terminalIndices[0]).toBe(result.trace.length - 1);
    });
  }

  it("holds for a rejected run too", async () => {
    const runtime = makeRuntime({ mode: "success" });
    const result = await runtime.executeTurn("DROP TABLE users", {
      timeoutMs: 5000,
    });
    expect(result.state).toBe("rejected");
    expect(result.trace.at(-1)!.type).toBe("terminal_state");
  });
});
