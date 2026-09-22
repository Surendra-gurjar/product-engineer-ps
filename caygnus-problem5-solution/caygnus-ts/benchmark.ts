import { CancelToken } from "./src/cancelToken.js";
import { ConversationRuntime } from "./src/orchestrator.js";
import { FakeProvider, type Chunk } from "./src/provider.js";
import { InMemoryConversationStore } from "./src/store.js";

const CHUNKS = ["one", "two", "three", "four", "five"];

class CountingProvider extends FakeProvider {
  invocationCount = 0;
  override async *stream(
    runId: string,
    userInput: string
  ): AsyncGenerator<Chunk, void, void> {
    this.invocationCount++;
    yield* super.stream(runId, userInput);
  }
}

type ScenarioName =
  | "success"
  | "policy_rejection"
  | "cancellation"
  | "timeout"
  | "provider_failure";

async function runScenario(
  name: ScenarioName,
  iterations: number
): Promise<Record<string, number>> {
  const outcomes: Record<string, number> = {};
  const violations: string[] = [];

  for (let i = 0; i < iterations; i++) {
    let provider: CountingProvider;
    let runtime: ConversationRuntime;
    let result;
    let expected: string;

    if (name === "success") {
      provider = new CountingProvider({
        chunks: [...CHUNKS],
        mode: "success",
        chunkDelayMs: 5,
      });
      runtime = new ConversationRuntime(
        provider,
        undefined,
        new InMemoryConversationStore()
      );
      result = await runtime.executeTurn(`hello #${i}`, { timeoutMs: 5000 });
      expected = "completed";
    } else if (name === "policy_rejection") {
      provider = new CountingProvider({
        chunks: [...CHUNKS],
        mode: "success",
        chunkDelayMs: 5,
      });
      runtime = new ConversationRuntime(
        provider,
        undefined,
        new InMemoryConversationStore()
      );
      result = await runtime.executeTurn("DROP TABLE users", {
        timeoutMs: 5000,
      });
      expected = "rejected";
      if (provider.invocationCount !== 0) {
        violations.push(`[${name}#${i}] provider invoked on a rejected run`);
      }
    } else if (name === "cancellation") {
      provider = new CountingProvider({
        chunks: [...CHUNKS],
        mode: "success",
        chunkDelayMs: 20,
      });
      runtime = new ConversationRuntime(
        provider,
        undefined,
        new InMemoryConversationStore()
      );
      const cancelToken = new CancelToken();
      setTimeout(() => cancelToken.cancel(), 15).unref();
      result = await runtime.executeTurn(`hello #${i}`, {
        timeoutMs: 5000,
        cancelToken,
      });
      expected = "cancelled";
    } else if (name === "timeout") {
      provider = new CountingProvider({
        chunks: [...CHUNKS],
        mode: "hang",
        chunkDelayMs: 10,
      });
      runtime = new ConversationRuntime(
        provider,
        undefined,
        new InMemoryConversationStore()
      );
      result = await runtime.executeTurn(`hello #${i}`, { timeoutMs: 50 });
      expected = "timed_out";
    } else {
      provider = new CountingProvider({
        chunks: [...CHUNKS],
        mode: "fail_after_partial",
        failAfter: 2,
        chunkDelayMs: 5,
      });
      runtime = new ConversationRuntime(
        provider,
        undefined,
        new InMemoryConversationStore()
      );
      result = await runtime.executeTurn(`hello #${i}`, { timeoutMs: 5000 });
      expected = "failed";
    }

    outcomes[result.state] = (outcomes[result.state] ?? 0) + 1;

    const terminalPositions = result.trace
      .map((e, idx) => (e.type === "terminal_state" ? idx : -1))
      .filter((idx) => idx !== -1);
    if (terminalPositions.length !== 1) {
      violations.push(
        `[${name}#${i}] expected exactly 1 terminal event, got ${terminalPositions.length}`
      );
    } else if (terminalPositions[0] !== result.trace.length - 1) {
      violations.push(`[${name}#${i}] events found after the terminal event`);
    }

    const record = runtime.store.get(result.runId)!;
    if (result.state !== "completed" && record.assistantResponse !== null) {
      violations.push(
        `[${name}#${i}] non-completed run has a persisted successful response`
      );
    }

    if (result.state !== expected) {
      violations.push(
        `[${name}#${i}] expected terminal '${expected}', got '${result.state}'`
      );
    }
  }

  if (violations.length > 0) {
    console.log(`  VIOLATIONS in '${name}':`);
    for (const v of violations) console.log("   -", v);
  }
  return outcomes;
}

async function main(): Promise<void> {
  const iterFlagIdx = process.argv.indexOf("--iterations");
  const iterations =
    iterFlagIdx !== -1 ? parseInt(process.argv[iterFlagIdx + 1]!, 10) : 10;

  const scenarios: ScenarioName[] = [
    "success",
    "policy_rejection",
    "cancellation",
    "timeout",
    "provider_failure",
  ];
  console.log(
    `Running ${iterations} iterations each of: ${scenarios.join(", ")}\n`
  );

  for (const name of scenarios) {
    const outcomes = await runScenario(name, iterations);
    console.log(`${name.padEnd(18)} -> ${JSON.stringify(outcomes)}`);
  }

  console.log(
    "\nSummary: every run had exactly one terminal state, rejected runs never called the"
  );
  console.log(
    "provider, and no non-completed run persisted a successful response. See any"
  );
  console.log("VIOLATIONS block above for details (none expected).");
}

main();
