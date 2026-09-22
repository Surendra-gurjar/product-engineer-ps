export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

const BLOCKED_SUBSTRINGS = [
  "drop table",
  "ignore previous instructions",
  "reveal your system prompt",
];

export class PolicyGate {
  check(userInput: string): PolicyDecision {
    if (userInput == null || userInput.trim().length === 0) {
      return { allowed: false, reason: "empty_input" };
    }

    const lowered = userInput.toLowerCase();
    for (const blocked of BLOCKED_SUBSTRINGS) {
      if (lowered.includes(blocked)) {
        return { allowed: false, reason: `blocked_pattern:${blocked}` };
      }
    }

    if (userInput.length > 8000) {
      return { allowed: false, reason: "input_too_long" };
    }

    return { allowed: true, reason: "ok" };
  }
}
