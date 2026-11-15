import { CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const WorkspaceSnapshot = Schema.Struct({
  head: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  checkpoint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  branch: Schema.NullOr(Schema.String),
  /** The project's directory inside the repository, as `git rev-parse --show-prefix` prints it. */
  prefix: Schema.String.check(Schema.isPattern(/^(?:(?!\.\.?\/)[^/\0]+\/)*$/)),
  remotes: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
  upstream: Schema.NullOr(Schema.Struct({ remote: Schema.String, merge: Schema.String })),
});
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;

export class WorkspaceTransferError extends Schema.TaggedError<WorkspaceTransferError>()(
  "WorkspaceTransferError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.operation === "unsupported-workspace"
      ? "Moving requires a complete Git checkout with a commit and no submodules, nested repositories, or sparse checkout."
      : `Workspace transfer failed during ${this.operation}.`;
  }
}

export class WorkspaceTransfer extends Context.Service<
  WorkspaceTransfer,
  {
    readonly capture: (input: {
      readonly cwd: string;
      readonly staging: string;
    }) => Effect.Effect<WorkspaceSnapshot, WorkspaceTransferError>;
    readonly restore: (input: {
      readonly staging: string;
      readonly cwd: string;
      readonly snapshot: WorkspaceSnapshot;
    }) => Effect.Effect<void, WorkspaceTransferError>;
  }
>()("t3-hermes/threadMove/WorkspaceTransfer") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcs = yield* GitVcsDriver.makeVcsDriverShape();
  const random = yield* SecureRandom.SecureRandom;

  const execute = Effect.fn("WorkspaceTransfer.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* git.execute({
      operation: "WorkspaceTransfer.git",
      cwd,
      args: ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", ...args],
      timeoutMs: 120_000,
    });
  });

  const config = (cwd: string, key: string) =>
    execute(cwd, ["config", "--get", key]).pipe(
      Effect.map(({ stdout }) => stdout.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  const capture: WorkspaceTransfer["Service"]["capture"] = Effect.fn("WorkspaceTransfer.capture")(
    function* ({ cwd: projectCwd, staging }) {
      const prefix = (yield* execute(projectCwd, ["rev-parse", "--show-prefix"])).stdout.replace(
        /\n$/,
        "",
      );
      const cwd = (yield* execute(projectCwd, ["rev-parse", "--show-toplevel"])).stdout.replace(
        /\n$/,
        "",
      );
      const head = (yield* execute(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      const shallow = (yield* execute(cwd, ["rev-parse", "--is-shallow-repository"])).stdout.trim();
      const sparse = yield* execute(cwd, ["config", "--get", "core.sparseCheckout"]).pipe(
        Effect.orElseSucceed(() => ({ stdout: "false" })),
      );
      const entries = yield* execute(cwd, ["ls-files", "--stage", "-z"]);
      if (
        shallow === "true" ||
        sparse.stdout.trim() === "true" ||
        /(?:^|\0)160000 /.test(entries.stdout) ||
        entries.stdoutTruncated
      ) {
        return yield* new WorkspaceTransferError({ operation: "unsupported-workspace" });
      }
      // Git can omit unborn embedded repositories when recovering a checkpoint.
      const untracked = yield* execute(cwd, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--directory",
        "-z",
      ]);
      for (const entry of untracked.stdout.split("\0").filter((entry) => entry.endsWith("/"))) {
        if (yield* fs.exists(path.join(cwd, entry, ".git")))
          return yield* new WorkspaceTransferError({ operation: "unsupported-workspace" });
      }
      if (untracked.stdoutTruncated)
        return yield* new WorkspaceTransferError({ operation: "unsupported-workspace" });
      const branch =
        (yield* execute(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
          Effect.orElseSucceed(() => ({ stdout: "" })),
        )).stdout.trim() || null;
      const remoteUrls = yield* execute(cwd, [
        "config",
        "-z",
        "--get-regexp",
        "^remote\\..*\\.url$",
      ]).pipe(Effect.orElseSucceed(() => ({ stdout: "" })));
      const remotes = remoteUrls.stdout.split("\0").flatMap((entry) => {
        const [key = "", url = ""] = entry.split("\n");
        // Embedded HTTP credentials stay on the source machine.
        return key.startsWith("remote.") && key.endsWith(".url") && url !== ""
          ? [{ name: key.slice(7, -4), url: url.replace(/^(https?:\/\/)[^/@]*@/i, "$1") }]
          : [];
      });
      const upstreamRemote = branch === null ? null : yield* config(cwd, `branch.${branch}.remote`);
      const upstreamMerge = branch === null ? null : yield* config(cwd, `branch.${branch}.merge`);
      const upstream =
        upstreamRemote !== null && upstreamMerge !== null
          ? { remote: upstreamRemote, merge: upstreamMerge }
          : null;
      yield* fs.makeDirectory(staging, { recursive: true });
      const checkpointRef = CheckpointRef.make(`refs/t3/moves/${yield* random.uuidV4()}`);
      return yield* Effect.gen(function* () {
        yield* vcs.checkpoints.captureCheckpoint({ cwd, checkpointRef });
        const checkpoint = (yield* execute(cwd, [
          "rev-parse",
          `${checkpointRef}^{commit}`,
        ])).stdout.trim();
        const snapshotEntries = yield* execute(cwd, ["ls-tree", "-r", checkpoint]);
        if (snapshotEntries.stdoutTruncated || /^160000 /m.test(snapshotEntries.stdout))
          return yield* new WorkspaceTransferError({ operation: "unsupported-workspace" });
        yield* execute(cwd, [
          "bundle",
          "create",
          path.join(staging, "workspace.bundle"),
          "HEAD",
          checkpointRef,
        ]);
        yield* execute(cwd, [
          "diff",
          "--cached",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          `--output=${path.join(staging, "staged.patch")}`,
          "HEAD",
        ]);
        return { head, checkpoint, branch, prefix, remotes, upstream };
      }).pipe(
        Effect.ensuring(
          vcs.checkpoints
            .deleteCheckpointRefs({ cwd, checkpointRefs: [checkpointRef] })
            .pipe(Effect.ignore),
        ),
      );
    },
    Effect.mapError((cause) =>
      cause?._tag === "WorkspaceTransferError"
        ? cause
        : new WorkspaceTransferError({ operation: "capture", cause }),
    ),
  );

  const restore: WorkspaceTransfer["Service"]["restore"] = Effect.fn("WorkspaceTransfer.restore")(
    function* ({ staging, cwd, snapshot }) {
      yield* fs.makeDirectory(cwd);
      yield* execute(cwd, ["init", "--template="]);
      yield* execute(cwd, [
        "fetch",
        "--no-tags",
        path.join(staging, "workspace.bundle"),
        "+HEAD:refs/t3/moved/head",
        "+refs/t3/moves/*:refs/t3/moved/checkpoint/*",
      ]);
      if (snapshot.branch === null) yield* execute(cwd, ["checkout", "--detach", snapshot.head]);
      else {
        yield* execute(cwd, ["check-ref-format", "--branch", snapshot.branch]);
        yield* execute(cwd, ["checkout", "-B", snapshot.branch, snapshot.head]);
      }
      yield* execute(cwd, ["read-tree", "--reset", "-u", snapshot.checkpoint]);
      yield* execute(cwd, ["reset", "--mixed", snapshot.head]);
      const patch = path.join(staging, "staged.patch");
      if ((yield* fs.stat(patch)).size > 0)
        yield* execute(cwd, ["apply", "--cached", "--binary", patch]);
      for (const remote of snapshot.remotes)
        yield* execute(cwd, ["remote", "add", "--", remote.name, remote.url]);
      if (snapshot.branch !== null && snapshot.upstream !== null) {
        yield* execute(cwd, [
          "config",
          `branch.${snapshot.branch}.remote`,
          snapshot.upstream.remote,
        ]);
        yield* execute(cwd, ["config", `branch.${snapshot.branch}.merge`, snapshot.upstream.merge]);
      }
      const transient = yield* execute(cwd, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/t3/moved/",
      ]);
      for (const ref of transient.stdout.split("\n").filter((ref) => ref !== ""))
        yield* execute(cwd, ["update-ref", "-d", ref]);
    },
    Effect.mapError((cause) => new WorkspaceTransferError({ operation: "restore", cause })),
  );

  return WorkspaceTransfer.of({ capture, restore });
});

export const layer = Layer.effect(WorkspaceTransfer, make);
