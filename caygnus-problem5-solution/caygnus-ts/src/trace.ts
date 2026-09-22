import {
  createEvent,
  type Event,
  type EventType,
  type Payload,
  type TurnState,
} from "./models.js";

export class Trace {
  readonly runId: string;
  private _events: Event[] = [];
  private _closed = false;

  constructor(runId: string) {
    this.runId = runId;
  }

  log(type: EventType, payload: Payload = {}): Event {
    if (this._closed) {
      throw new Error(
        `attempted to append event ${type} after run ${this.runId} already recorded a terminal event`
      );
    }
    const event = createEvent(this.runId, type, payload);
    this._events.push(event);
    if (type === "terminal_state") {
      this._closed = true;
    }
    return event;
  }

  logTerminal(state: TurnState, payload: Payload = {}): Event {
    return this.log("terminal_state", { state, ...payload });
  }

  get events(): Event[] {
    return [...this._events];
  }

  find(type: EventType): Event | undefined {
    return this._events.find((e) => e.type === type);
  }
}
