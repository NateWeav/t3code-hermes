import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { useAssetUrlState } from "../assets/assetUrls";

import {
  MarkdownWorkspaceImage,
  orderedListGutterStyle,
  resolveMarkdownWorkspaceImagePath,
  transformChatMarkdownUrl,
} from "./ChatMarkdown";

vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: vi.fn(),
}));

const mockUseAssetUrlState = vi.mocked(useAssetUrlState);
const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(5, "999995")).toEqual({ "--list-gutter": "7ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("uses the widest marker and includes a negative start's minus sign", () => {
    expect(orderedListGutterStyle(1001, -1000)).toEqual({ "--list-gutter": "6ch" });
    expect(orderedListGutterStyle(3, -15)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(3, -5)).toBeUndefined();
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
    expect(orderedListGutterStyle(0, 100)).toEqual({ "--list-gutter": "4ch" });
  });
});

describe("Hermes markdown images", () => {
  it("resolves local image destinations against the thread workspace", () => {
    expect(resolveMarkdownWorkspaceImagePath("artifacts/qr.png", "/workspace/project")).toBe(
      "/workspace/project/artifacts/qr.png",
    );
    expect(resolveMarkdownWorkspaceImagePath("file:///tmp/pairing%20qr.png", undefined)).toBe(
      "/tmp/pairing qr.png",
    );
    expect(
      resolveMarkdownWorkspaceImagePath("https://example.com/qr.png", "/workspace"),
    ).toBeNull();
  });

  it("allows inline raster images only for image sources", () => {
    const png = "data:image/png;base64,AQID";
    expect(transformChatMarkdownUrl(png, "src")).toBe(png);
    expect(transformChatMarkdownUrl(png, "href")).toBe("");
    expect(
      transformChatMarkdownUrl(
        "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+",
        "src",
      ),
    ).toBe("");
  });

  it("rewrites file URLs before the browser tries to load them", () => {
    expect(transformChatMarkdownUrl("file:///tmp/pairing%20qr.png", "src")).toBe(
      "/tmp/pairing%20qr.png",
    );
  });

  it("renders a signed workspace image URL scoped to the current thread", () => {
    mockUseAssetUrlState.mockReturnValue({
      _tag: "Success",
      url: "https://environment.example/api/assets/signed/qr.png",
    });

    const markup = renderToStaticMarkup(
      <MarkdownWorkspaceImage
        originalSrc="artifacts/qr.png"
        workspacePath="/workspace/artifacts/qr.png"
        threadRef={threadRef}
        alt="Pairing QR"
      />,
    );

    expect(mockUseAssetUrlState).toHaveBeenCalledWith(threadRef.environmentId, {
      _tag: "workspace-file",
      threadId: threadRef.threadId,
      path: "/workspace/artifacts/qr.png",
    });
    expect(markup).toContain('src="https://environment.example/api/assets/signed/qr.png"');
    expect(markup).toContain('alt="Pairing QR"');
  });

  it("falls back to the original source when the asset lookup fails", () => {
    mockUseAssetUrlState.mockReturnValue({ _tag: "Failure" });

    const markup = renderToStaticMarkup(
      <MarkdownWorkspaceImage
        originalSrc="artifacts/qr.png"
        workspacePath="/workspace/artifacts/qr.png"
        threadRef={threadRef}
        alt="Pairing QR"
      />,
    );

    expect(markup).toContain('src="artifacts/qr.png"');
  });

  it("shows accessible image text while the signed URL loads", () => {
    mockUseAssetUrlState.mockReturnValue({ _tag: "Loading" });

    const markup = renderToStaticMarkup(
      <MarkdownWorkspaceImage
        originalSrc="artifacts/qr.png"
        workspacePath="/workspace/artifacts/qr.png"
        threadRef={threadRef}
        alt="Pairing QR"
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Pairing QR"');
    expect(markup).toContain("Pairing QR");
  });
});
