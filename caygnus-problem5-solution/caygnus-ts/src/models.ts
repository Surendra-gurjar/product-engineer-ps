export type TurnState =
  | "pending"
  | "policy_check"
  | "streaming"
  | "completed"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "failed";

export const TERMINAL_STATES: ReadonlySet<TurnState> = new Set([
  "completed",
  "rejected",
  "cancelled",
  "timed_out",
  "failed",
]);

export const SUCCESSFUL_TERMINAL_STATES: ReadonlySet<TurnState> = new Set([
  "completed",
]);

export function isTerminal(state: TurnState): boolean {
  return TERMINAL_STATES.has(state);
}

export type EventType =
  | "run_started"
  | "policy_check_started"
  | "policy_decision"
  | "provider_invoked"
  | "chunk_received"
  | "provider_error"
  | "cancel_requested"
  | "timeout_reached"
  | "terminal_state"
  | "terminal_transition_rejected";

const SECRET_KEY_MARKERS = [
  "secret",
  "api_key",
  "apikey",
  "token",
  "password",
  "credential",
];

const DROPPED_KEYS = [
  "reasoning",
  "hidden_reasoning",
  "chain_of_thought",
  "scratchpad",
];

export type Payload = Record<string, unknown>;

export function redact(payload: Payload): Payload {
  const clean: Payload = {};
  for (const [key, value] of Object.entries(payload)) {
    const lowered = key.toLowerCase();
    if (DROPPED_KEYS.some((marker) => lowered.includes(marker))) {
      continue;
    }
    if (SECRET_KEY_MARKERS.some((marker) => lowered.includes(marker))) {
      clean[key] = "[REDACTED]";
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

let seqCounter = 1;

export interface Event {
  seq: number;
  runId: string;
  type: EventType;
  payload: Payload;
  ts: number;
}

export function createEvent(
  runId: string,
  type: EventType,
  payload: Payload = {}
): Event {
  return {
    seq: seqCounter++,
    runId,
    type,
    payload: redact(payload),
    ts: performance.now(),
  };
}

export class TurnRecord {
  readonly runId: string;
  readonly userInput: string;
  state: TurnState = "pending";
  partialOutput = "";
  finalOutput: string | null = null;
  error: string | null = null;
  readonly createdAt: number = Date.now();
  terminalAt: number | null = null;

  constructor(runId: string, userInput: string) {
    this.runId = runId;
    this.userInput = userInput;
  }

  trySetTerminal(newState: TurnState): boolean {
    if (
      !SUCCESSFUL_TERMINAL_STATES.has(newState) &&
      !TERMINAL_STATES.has(newState)
    ) {
      throw new Error(`${newState} is not a terminal state`);
    }
    if (isTerminal(this.state)) {
      return false;
    }
    this.state = newState;
    this.terminalAt = Date.now();
    return true;
  }

  get isTerminalState(): boolean {
    return isTerminal(this.state);
  }

  get isSuccessful(): boolean {
    return SUCCESSFUL_TERMINAL_STATES.has(this.state);
  }
}
