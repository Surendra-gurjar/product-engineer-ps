import { CancelToken } from "./cancelToken.js";
import { TurnRecord, type Event, type TurnState } from "./models.js";
import { PolicyGate } from "./policy.js";
import { ProviderError, type Chunk, type Provider } from "./provider.js";
import { InMemoryConversationStore, type ConversationRecord } from "./store.js";
import { Trace } from "./trace.js";

export interface TurnResult {
  runId: string;
  state: TurnState;
  isSuccessful: boolean;
  output: string | null;
  error: string | null;
  trace: Event[];
}

export interface ExecuteTurnOptions {
  timeoutMs?: number;
  cancelToken?: CancelToken;
}

type StreamOutcome = "completed" | "cancelled" | "timeout" | "failed";

const TIMEOUT_SENTINEL = Symbol("timeout");

function randomRunId(): string {
  return crypto.randomUUID();
}

export class ConversationRuntime {
  readonly provider: Provider;
  readonly policy: PolicyGate;
  readonly store: InMemoryConversationStore;

  constructor(
    provider: Provider,
    policy?: PolicyGate,
    store?: InMemoryConversationStore
  ) {
    this.provider = provider;
    this.policy = policy ?? new PolicyGate();
    this.store = store ?? new InMemoryConversationStore();
  }

  async executeTurn(
    userInput: string,
    options: ExecuteTurnOptions = {}
  ): Promise<TurnResult> {
    const timeoutMs = options.timeoutMs ?? 2000;
    const cancelToken = options.cancelToken ?? new CancelToken();

    const runId = randomRunId();
    const turn = new TurnRecord(runId, userInput);
    const trace = new Trace(runId);

    trace.log("run_started", { inputLen: (userInput ?? "").length });

    turn.state = "policy_check";
    trace.log("policy_check_started");
    const decision = this.policy.check(userInput);
    trace.log("policy_decision", {
      allowed: decision.allowed,
      reason: decision.reason,
    });

    if (!decision.allowed) {
      turn.trySetTerminal("rejected");
      trace.logTerminal("rejected", { reason: decision.reason });
      const record = this.store.commit(turn);
      return this.buildResult(turn, trace, record);
    }

    turn.state = "streaming";
    trace.log("provider_invoked");

    const deadline = Date.now() + timeoutMs;
    const stream = this.provider.stream(runId, userInput);

    const { outcome, error } = await this.consumeStream(
      stream,
      turn,
      trace,
      cancelToken,
      deadline
    );

    this.finalize(outcome, error, turn, trace);

    const record = this.store.commit(turn);
    return this.buildResult(turn, trace, record);
  }

  private async consumeStream(
    stream: AsyncGenerator<Chunk, void, void>,
    turn: TurnRecord,
    trace: Trace,
    cancelToken: CancelToken,
    deadline: number
  ): Promise<{ outcome: StreamOutcome; error: Error | null }> {
    const chunks: string[] = [];

    while (true) {
      if (cancelToken.requested) {
        turn.partialOutput = chunks.join("");
        return { outcome: "cancelled", error: null };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        turn.partialOutput = chunks.join("");
        return { outcome: "timeout", error: null };
      }

      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), remaining);
      });

      let raceResult: IteratorResult<Chunk, void> | typeof TIMEOUT_SENTINEL;
      try {
        raceResult = await Promise.race([stream.next(), timeoutPromise]);
      } catch (err) {
        clearTimeout(timer!);
        turn.partialOutput = chunks.join("");
        if (err instanceof ProviderError) {
          return { outcome: "failed", error: err };
        }
        throw err;
      }
      clearTimeout(timer!);

      if (raceResult === TIMEOUT_SENTINEL) {
        turn.partialOutput = chunks.join("");
        return { outcome: "timeout", error: null };
      }

      if (raceResult.done) {
        turn.partialOutput = chunks.join("");
        return { outcome: "completed", error: null };
      }

      chunks.push(raceResult.value.text);
      turn.partialOutput = chunks.join("");
      trace.log("chunk_received", {
        index: chunks.length - 1,
        chunkLen: raceResult.value.text.length,
      });

      if (cancelToken.requested) {
        return { outcome: "cancelled", error: null };
      }
    }
  }

  private finalize(
    outcome: StreamOutcome,
    error: Error | null,
    turn: TurnRecord,
    trace: Trace
  ): void {
    if (outcome === "completed") {
      const won = turn.trySetTerminal("completed");
      if (won) {
        turn.finalOutput = turn.partialOutput;
        trace.logTerminal("completed", { outputLen: turn.finalOutput.length });
      } else {
        trace.log("terminal_transition_rejected", { attempted: "completed" });
        trace.logTerminal(turn.state, { reason: "lost_terminal_race" });
      }
      return;
    }

    if (outcome === "cancelled") {
      const won = turn.trySetTerminal("cancelled");
      if (won) {
        trace.logTerminal("cancelled", {
          partialLen: turn.partialOutput.length,
        });
      } else {
        trace.log("terminal_transition_rejected", { attempted: "cancelled" });
        trace.logTerminal(turn.state, { reason: "lost_terminal_race" });
      }
      return;
    }

    if (outcome === "timeout") {
      const won = turn.trySetTerminal("timed_out");
      if (won) {
        trace.log("timeout_reached", { partialLen: turn.partialOutput.length });
        trace.logTerminal("timed_out", {
          partialLen: turn.partialOutput.length,
        });
      } else {
        trace.log("terminal_transition_rejected", { attempted: "timed_out" });
        trace.logTerminal(turn.state, { reason: "lost_terminal_race" });
      }
      return;
    }

    const won = turn.trySetTerminal("failed");

    turn.error = error ? error.constructor.name : "ProviderError";
    if (won) {
      trace.log("provider_error", { errorType: turn.error });
      trace.logTerminal("failed", { partialLen: turn.partialOutput.length });
    } else {
      trace.log("terminal_transition_rejected", { attempted: "failed" });
      trace.logTerminal(turn.state, { reason: "lost_terminal_race" });
    }
  }

  private buildResult(
    turn: TurnRecord,
    trace: Trace,
    record: ConversationRecord
  ): TurnResult {
    return {
      runId: turn.runId,
      state: turn.state,
      isSuccessful: turn.isSuccessful,
      output: turn.isSuccessful
        ? record.assistantResponse
        : record.partialOutput,
      error: turn.error,
      trace: trace.events,
    };
  }
}
