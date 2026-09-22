import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

import { CancelToken } from "./src/cancelToken.js";
import { ConversationRuntime, type TurnResult } from "./src/orchestrator.js";
import { FakeProvider, type FakeProviderMode } from "./src/provider.js";
import { InMemoryConversationStore } from "./src/store.js";

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_CHUNKS = [
  "Hello",
  ", ",
  "this ",
  "is ",
  "a ",
  "streamed ",
  "reply ",
  "from ",
  "the ",
  "model.",
];

interface TurnRequestBody {
  input?: string;
  timeoutMs?: number;
  mode?: FakeProviderMode;
}

interface AsyncEntry {
  cancelToken: CancelToken;
  promise: Promise<TurnResult>;
  result: TurnResult | null;
}

function buildRuntime(mode: FakeProviderMode): ConversationRuntime {
  const provider = new FakeProvider({
    chunks: [...DEFAULT_CHUNKS],
    mode,
    failAfter: 3,
    chunkDelayMs: 40,
  });
  return new ConversationRuntime(
    provider,
    undefined,
    new InMemoryConversationStore()
  );
}

const asyncRuns = new Map<string, AsyncEntry>();

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post(
  "/api/turns",
  async (req: Request<unknown, unknown, TurnRequestBody>, res: Response) => {
    const { input, timeoutMs, mode } = req.body ?? {};
    if (typeof input !== "string" || input.length === 0) {
      res
        .status(400)
        .json({ error: "body.input (non-empty string) is required" });
      return;
    }

    const runtime = buildRuntime(mode ?? "success");
    const result = await runtime.executeTurn(input, {
      timeoutMs: timeoutMs ?? 2000,
    });
    res.status(200).json(result);
  }
);

app.post(
  "/api/turns/async",
  (req: Request<unknown, unknown, TurnRequestBody>, res: Response) => {
    const { input, timeoutMs, mode } = req.body ?? {};
    if (typeof input !== "string" || input.length === 0) {
      res
        .status(400)
        .json({ error: "body.input (non-empty string) is required" });
      return;
    }

    const runtime = buildRuntime(mode ?? "success");
    const cancelToken = new CancelToken();
    const handle = randomUUID();

    const entry: AsyncEntry = {
      cancelToken,
      result: null,
      promise: runtime.executeTurn(input, {
        timeoutMs: timeoutMs ?? 5000,
        cancelToken,
      }),
    };
    asyncRuns.set(handle, entry);
    entry.promise.then((result) => {
      entry.result = result;
    });

    res.status(202).json({ runId: handle, status: "accepted" });
  }
);

app.get(
  "/api/turns/:runId",
  (req: Request<{ runId: string }>, res: Response) => {
    const entry = asyncRuns.get(req.params.runId);
    if (!entry) {
      res.status(404).json({ error: `no such run: ${req.params.runId}` });
      return;
    }
    if (!entry.result) {
      res.status(200).json({ status: "in_progress" });
      return;
    }
    res.status(200).json(entry.result);
  }
);

app.post(
  "/api/turns/:runId/cancel",
  (req: Request<{ runId: string }>, res: Response) => {
    const entry = asyncRuns.get(req.params.runId);
    if (!entry) {
      res.status(404).json({ error: `no such run: ${req.params.runId}` });
      return;
    }
    if (entry.result) {
      res
        .status(409)
        .json({
          error: "run already reached a terminal state",
          state: entry.result.state,
        });
      return;
    }
    entry.cancelToken.cancel();
    res.status(202).json({ status: "cancel_requested" });
  }
);

app.listen(PORT, () => {
  console.log(`Conversation runtime API listening on http://localhost:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /api/turns              { input, timeoutMs?, mode? }`);
  console.log(`  POST /api/turns/async        { input, timeoutMs?, mode? }`);
  console.log(`  GET  /api/turns/:runId`);
  console.log(`  POST /api/turns/:runId/cancel`);
});
