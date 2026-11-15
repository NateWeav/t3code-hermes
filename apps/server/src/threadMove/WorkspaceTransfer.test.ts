import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceTransfer from "./WorkspaceTransfer.ts";

const testLayer = WorkspaceTransfer.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layerVcs),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workspace-transfer-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect(
  "carries unpublished commits, uncommitted work, remotes, and the project subdirectory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const transfer = yield* WorkspaceTransfer.WorkspaceTransfer;
      const root = yield* fs.makeTempDirectoryScoped();
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const staging = path.join(root, "staging");
      yield* fs.makeDirectory(source);
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        git.execute({ operation: "test.workspaceTransfer", cwd, args });
      yield* run(source, ["init", "-b", "feature/local"]);
      yield* run(source, ["config", "user.name", "Test"]);
      yield* run(source, ["config", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(source, "text.txt"), "original\n");
      yield* fs.writeFileString(path.join(source, "deleted.txt"), "delete me\n");
      yield* fs.writeFileString(path.join(source, ".gitignore"), "ignored.txt\n");
      yield* fs.makeDirectory(path.join(source, "pkg"));
      yield* fs.writeFileString(path.join(source, "pkg", "index.ts"), "export {};\n");
      yield* run(source, ["remote", "add", "origin", "https://user:secret@example.com/repo.git"]);
      yield* run(source, ["config", "branch.feature/local.remote", "origin"]);
      yield* run(source, ["config", "branch.feature/local.merge", "refs/heads/feature/local"]);
      yield* run(source, ["add", "."]);
      yield* run(source, ["commit", "-m", "unpublished commit"]);
      yield* fs.writeFileString(path.join(source, "text.txt"), "staged\n");
      yield* fs.writeFile(path.join(source, "binary.dat"), new Uint8Array([0, 1, 2, 255]));
      yield* run(source, ["add", "."]);
      yield* fs.writeFileString(path.join(source, "text.txt"), "unstaged\n");
      yield* fs.writeFile(path.join(source, "binary.dat"), new Uint8Array([0, 3, 4, 255]));
      yield* fs.remove(path.join(source, "deleted.txt"));
      yield* fs.writeFileString(path.join(source, "untracked.txt"), "new\n");
      yield* fs.writeFileString(path.join(source, "ignored.txt"), "generated\n");
      const before = (yield* run(source, ["status", "--porcelain=v1"])).stdout;
      const captured = yield* transfer.capture({ cwd: path.join(source, "pkg"), staging });
      assert.equal(captured.prefix, "pkg/");
      assert.deepEqual(captured.remotes, [{ name: "origin", url: "https://example.com/repo.git" }]);
      assert.equal((yield* run(source, ["status", "--porcelain=v1"])).stdout, before);
      yield* transfer.restore({ staging, cwd: destination, snapshot: captured });
      assert.equal((yield* run(destination, ["status", "--porcelain=v1"])).stdout, before);
      assert.equal((yield* run(destination, ["rev-parse", "HEAD"])).stdout.trim(), captured.head);
      assert.equal(yield* fs.readFileString(path.join(destination, "text.txt")), "unstaged\n");
      assert.deepEqual(
        yield* fs.readFile(path.join(destination, "binary.dat")),
        new Uint8Array([0, 3, 4, 255]),
      );
      assert.equal(yield* fs.readFileString(path.join(destination, "untracked.txt")), "new\n");
      assert.isFalse(yield* fs.exists(path.join(destination, "deleted.txt")));
      assert.isFalse(yield* fs.exists(path.join(destination, "ignored.txt")));
      assert.equal(
        (yield* run(destination, ["diff", "--cached", "--binary"])).stdout,
        (yield* run(source, ["diff", "--cached", "--binary"])).stdout,
      );
      assert.equal((yield* run(source, ["for-each-ref", "refs/t3/"])).stdout, "");
      assert.equal((yield* run(destination, ["for-each-ref", "refs/t3/"])).stdout, "");
      assert.equal(
        (yield* run(destination, ["branch", "--format=%(refname:short) %(upstream:remotename)"]))
          .stdout,
        "feature/local origin\n",
      );
      assert.equal(
        (yield* run(destination, ["remote", "get-url", "origin"])).stdout.trim(),
        "https://example.com/repo.git",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
