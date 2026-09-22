export class ProviderError extends Error {}

export interface Chunk {
  text: string;
  reasoning?: string;
}

export interface Provider {
  stream(runId: string, userInput: string): AsyncGenerator<Chunk, void, void>;
}

export type FakeProviderMode = "success" | "fail_after_partial" | "hang";

export interface FakeProviderOptions {
  chunks: string[];
  mode?: FakeProviderMode;
  failAfter?: number;

  chunkDelayMs?: number;

  secretMarker?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeProvider implements Provider {
  readonly chunks: string[];
  readonly mode: FakeProviderMode;
  readonly failAfter: number;
  readonly chunkDelayMs: number;
  readonly secretMarker: string;

  constructor(opts: FakeProviderOptions) {
    this.chunks = opts.chunks;
    this.mode = opts.mode ?? "success";
    this.failAfter = opts.failAfter ?? 1;
    this.chunkDelayMs = opts.chunkDelayMs ?? 20;
    this.secretMarker = opts.secretMarker ?? "sk-fake-not-a-real-secret";
  }

  async *stream(
    _runId: string,
    _userInput: string
  ): AsyncGenerator<Chunk, void, void> {
    if (this.mode === "hang") {
      while (true) {
        await sleep(this.chunkDelayMs);
        yield { text: " ", reasoning: "internal-thinking-not-for-trace" };
      }
    }

    for (let i = 0; i < this.chunks.length; i++) {
      await sleep(this.chunkDelayMs);
      if (this.mode === "fail_after_partial" && i >= this.failAfter) {
        throw new ProviderError(
          `simulated provider failure using key=${this.secretMarker}`
        );
      }
      yield {
        text: this.chunks[i]!,
        reasoning: `internal-thinking-for-chunk-${i}`,
      };
    }
  }
}
