import { isTerminal, type TurnRecord, type TurnState } from "./models.js";

export class DuplicateCommitError extends Error {}

export interface ConversationRecord {
  runId: string;
  userInput: string;
  state: TurnState;
  isSuccessful: boolean;
  assistantResponse: string | null;
  partialOutput: string | null;
  error: string | null;
  createdAt: number;
  terminalAt: number | null;
}

export class InMemoryConversationStore {
  private records = new Map<string, ConversationRecord>();

  commit(turn: TurnRecord): ConversationRecord {
    if (!isTerminal(turn.state)) {
      throw new Error("refusing to persist a non-terminal turn");
    }
    if (this.records.has(turn.runId)) {
      throw new DuplicateCommitError(`run ${turn.runId} was already committed`);
    }

    let assistantResponse: string | null = null;
    let partialOutput: string | null = null;

    if (turn.state === "completed") {
      assistantResponse = turn.finalOutput;
    } else if (turn.state === "rejected") {
    } else {
      partialOutput = turn.partialOutput || null;
    }

    const record: ConversationRecord = {
      runId: turn.runId,
      userInput: turn.userInput,
      state: turn.state,
      isSuccessful: turn.isSuccessful,
      assistantResponse,
      partialOutput,
      error: turn.error,
      createdAt: turn.createdAt,
      terminalAt: turn.terminalAt,
    };
    this.records.set(turn.runId, record);
    return record;
  }

  get(runId: string): ConversationRecord | undefined {
    return this.records.get(runId);
  }

  getCompletedResponse(runId: string): string | null {
    const record = this.records.get(runId);
    if (record && record.isSuccessful) {
      return record.assistantResponse;
    }
    return null;
  }

  all(): ConversationRecord[] {
    return [...this.records.values()];
  }
}
