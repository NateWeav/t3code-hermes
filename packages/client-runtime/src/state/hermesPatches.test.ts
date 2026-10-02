import { describe, expect, it } from "@effect/vitest";

import { describeHermesGateway } from "./hermesPatches.ts";

describe("describeHermesGateway", () => {
  it("stays quiet when no gateway runs or it already has the changes", () => {
    expect(describeHermesGateway(null, null)).toBeNull();
    expect(describeHermesGateway({ state: "upToDate", canRestart: true }, null)).toBeNull();
  });

  it("offers a restart only for an outdated gateway that runs as a service", () => {
    expect(describeHermesGateway({ state: "outdated", canRestart: true }, null)?.restart).toBe(
      true,
    );
    expect(describeHermesGateway({ state: "outdated", canRestart: false }, null)?.restart).toBe(
      false,
    );
  });

  it("shows a running restart without a button, and a failed one with a retry", () => {
    expect(describeHermesGateway({ state: "restarting", canRestart: true }, null)).toMatchObject({
      tone: "info",
      restart: false,
    });
    // The old gateway still answers after a failed restart, however its age compares.
    expect(
      describeHermesGateway({ state: "upToDate", canRestart: true }, "exited with code 1."),
    ).toMatchObject({
      tone: "warning",
      text: "The gateway restart failed: exited with code 1.",
      restart: true,
    });
  });
});
