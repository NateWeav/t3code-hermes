import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeHermesTextGeneration } from "./HermesTextGeneration.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const PromptRequest = Schema.Struct({
  method: Schema.Literal("session/prompt"),
  params: Schema.Struct({
    prompt: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
});
const decodePromptRequest = Schema.decodeUnknownOption(Schema.fromJsonString(PromptRequest));
const modelSelection = createModelSelection(ProviderInstanceId.make("hermes"), "hermes-4");

const withMockHermes = <A, E, R>(
  reply: string,
  run: (
    textGeneration: Effect.Success<ReturnType<typeof makeHermesTextGeneration>>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-text-" });
    const binaryPath = path.join(dir, "hermes");
    yield* fileSystem.writeFileString(
      binaryPath,
      `#!/bin/sh\nexec '${process.execPath}' '${mockAgentPath}' "$@"\n`,
    );
    yield* fileSystem.chmod(binaryPath, 0o755);
    const requestLogPath = path.join(dir, "requests.ndjson");
    const textGeneration = yield* makeHermesTextGeneration(decodeHermesSettings({ binaryPath }), {
      ...process.env,
      HERMES_HOME: dir,
      T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      T3_ACP_PROMPT_RESPONSE_TEXT: reply,
    });
    const result = yield* run(textGeneration);
    const prompts = (yield* fileSystem.readFileString(requestLogPath))
      .trim()
      .split("\n")
      .flatMap((line) => Option.toArray(decodePromptRequest(line)))
      .flatMap((request) => request.params.prompt.flatMap((block) => block.text ?? []));
    return { result, prompt: prompts.join("\n") };
  }).pipe(Effect.scoped);

// The mock agent is launched through a POSIX shell script.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "HermesTextGeneration against the mock agent",
  () => {
    it.layer(NodeServices.layer)((it) => {
      it.effect("applies the configured branch prefix and naming instructions", () =>
        Effect.gen(function* () {
          const { result, prompt } = yield* withMockHermes(
            JSON.stringify({ branch: "Fix Login Redirect" }),
            (textGeneration) =>
              textGeneration.generateBranchName({
                cwd: process.cwd(),
                message: "the login page loops back to itself",
                naming: { mode: "static", prefix: "nate", instructions: "" },
                modelSelection,
              }),
          );
          assert.strictEqual(result.branch, "nate/fix-login-redirect");
          assert.include(prompt, "The application adds the configured prefix.");
        }),
      );

      it.effect("keeps a custom branch name exactly as generated", () =>
        Effect.gen(function* () {
          const { result, prompt } = yield* withMockHermes(
            JSON.stringify({ branch: "ENG-42_Login" }),
            (textGeneration) =>
              textGeneration.generateBranchName({
                cwd: process.cwd(),
                message: "the login page loops back to itself",
                naming: { mode: "custom", prefix: "", instructions: "Start with the ticket id." },
                modelSelection,
              }),
          );
          assert.strictEqual(result.branch, "ENG-42_Login");
          assert.include(prompt, "Start with the ticket id.");
        }),
      );

      it.effect("titles a thread from its linked context and the thread it forked from", () =>
        Effect.gen(function* () {
          const { result, prompt } = yield* withMockHermes(
            JSON.stringify({ title: "Login redirect loop", needsRefinement: true }),
            (textGeneration) =>
              textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "look at this",
                linkedContext: "PR #42: Login redirects back to itself",
                forkSource: { title: "Auth cleanup", history: "We moved sessions to cookies." },
                modelSelection,
              }),
          );
          assert.deepStrictEqual(result, { title: "Login redirect loop", needsRefinement: true });
          assert.include(prompt, "PR #42: Login redirects back to itself");
          assert.include(prompt, "We moved sessions to cookies.");
        }),
      );

      it.effect("writes pull request text from the thread that made the change", () =>
        Effect.gen(function* () {
          const { prompt } = yield* withMockHermes(
            JSON.stringify({ title: "Fix login redirect", body: "Stops the loop." }),
            (textGeneration) =>
              textGeneration.generatePrContent({
                cwd: process.cwd(),
                baseBranch: "main",
                headBranch: "fix/login",
                commitSummary: "fix: stop the redirect loop",
                diffSummary: "1 file changed",
                diffPatch: "diff --git a/login.ts b/login.ts",
                threadContext: "User: the login page loops back to itself",
                modelSelection,
              }),
          );
          assert.include(prompt, "User: the login page loops back to itself");
        }),
      );
    });
  },
);
