import { CancelToken } from "./src/cancelToken.js";
import { ConversationRuntime } from "./src/orchestrator.js";
import { FakeProvider, type FakeProviderMode } from "./src/provider.js";
import { InMemoryConversationStore } from "./src/store.js";

interface Args {
  input: string;
  mode: FakeProviderMode;
  timeoutMs: number;
  cancelAfterMs: number | null;
  showTrace: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: "",
    mode: "success",
    timeoutMs: 2000,
    cancelAfterMs: null,
    showTrace: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--mode") args.mode = argv[++i] as FakeProviderMode;
    else if (a === "--timeout")
      args.timeoutMs = Math.round(parseFloat(argv[++i]!) * 1000);
    else if (a === "--cancel-after")
      args.cancelAfterMs = Math.round(parseFloat(argv[++i]!) * 1000);
    else if (a === "--show-trace") args.showTrace = true;
    else rest.push(a);
  }
  args.input = rest.join(" ");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error(
      'usage: tsx cli.ts "<input>" [--mode success|fail_after_partial|hang] ' +
        "[--timeout SECONDS] [--cancel-after SECONDS] [--show-trace]"
    );
    process.exit(1);
  }

  const provider = new FakeProvider({
    chunks: [
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
    ],
    mode: args.mode,
    failAfter: 3,
    chunkDelayMs: 30,
  });
  const runtime = new ConversationRuntime(
    provider,
    undefined,
    new InMemoryConversationStore()
  );

  const cancelToken = new CancelToken();
  if (args.cancelAfterMs !== null) {
    setTimeout(() => cancelToken.cancel(), args.cancelAfterMs).unref();
  }

  const result = await runtime.executeTurn(args.input, {
    timeoutMs: args.timeoutMs,
    cancelToken,
  });

  console.log(`run_id:       ${result.runId}`);
  console.log(`terminal:     ${result.state}`);
  console.log(`successful:   ${result.isSuccessful}`);
  console.log(`output/text:  ${JSON.stringify(result.output)}`);
  if (result.error) {
    console.log(`error:        ${result.error}`);
  }

  if (args.showTrace) {
    console.log("\ntrace:");
    for (const event of result.trace) {
      console.log(" ", JSON.stringify(event));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
