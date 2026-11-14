import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock(import("./SecretSourceInput"), async (original) => ({
  ...(await original()),
  useSecretSources: () => [],
}));

import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";

describe("AddUsageLimitSourceDialog", () => {
  it("adds the hub when Enter is pressed in a field", async () => {
    const onAdd = vi.fn();
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <AddUsageLimitSourceDialog
        open
        onOpenChange={onOpenChange}
        environmentId={EnvironmentId.make("local")}
        onAdd={onAdd}
      />,
    );

    await userEvent.type(page.getByLabelText("Hub URL"), "https://hub.example.ts.net:8318");
    await userEvent.type(page.getByLabelText("Management key"), "secret-key{Enter}");

    expect(onAdd).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledWith({
      url: "https://hub.example.ts.net:8318",
      managementKey: "secret-key",
      label: "",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
