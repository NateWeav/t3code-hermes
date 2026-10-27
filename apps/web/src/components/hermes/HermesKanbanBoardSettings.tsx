/**
 * Board icons and the board settings popover: a board links to a T3 project (and shows its icon)
 * or carries an uploaded icon that wins over it. Both are T3 Code preferences; Hermes is never
 * written.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { hermesKanbanBoardIconSource } from "@t3tools/client-runtime/state/hermesKanban";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  HERMES_KANBAN_BOARD_ICON_MAX_BYTES,
  type EnvironmentId,
  type HermesKanbanBoardIcon,
  type HermesKanbanBoardSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { ImageUpIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { useContext, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useProject, useProjects } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";

type BoardIconFields = Pick<HermesKanbanBoardSummary, "customIcon" | "projectId" | "icon">;

/**
 * A board's icon by precedence: upload, linked T3 project, Hermes emoji, nothing. An uploaded
 * icon (SVG included) renders only through `<img src=data:…>`: an image-context SVG runs no
 * scripts and loads nothing external, so an uploaded file can't reach the page. Never inline it.
 */
export function HermesKanbanBoardIconView(props: {
  readonly environmentId: EnvironmentId;
  readonly board: BoardIconFields;
  readonly className?: string;
}) {
  const project = useProject(
    props.board.customIcon === null && props.board.projectId !== null
      ? scopeProjectRef(props.environmentId, props.board.projectId)
      : null,
  );
  const source = hermesKanbanBoardIconSource(props.board, () => project !== null);
  switch (source.kind) {
    case "upload":
      return (
        <img
          src={source.icon.dataUrl}
          alt=""
          aria-hidden
          className={cn("size-4 shrink-0 rounded-[25%] object-contain", props.className)}
        />
      );
    case "project":
      return project === null ? null : (
        <ProjectFavicon project={project} className={cn("size-4", props.className)} />
      );
    case "emoji":
      return <span aria-hidden>{source.emoji}</span>;
    case "none":
      return null;
  }
}

const ICON_SIZE = 128;

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("That file could not be read as an image.")),
      { once: true },
    );
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/**
 * The `downscaleProjectFavicon` approach (`assets/projectFaviconCache.ts`): draw onto a canvas at
 * most 128px, then 64px, and keep the first that fits. Every upload is rasterized, so even an SVG
 * is stored as a bitmap; GIFs keep only their first frame.
 */
async function downscaleBoardIcon(file: File): Promise<HermesKanbanBoardIcon> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  const image = await loadImage(file);
  const width = image.naturalWidth || ICON_SIZE;
  const height = image.naturalHeight || ICON_SIZE;
  const canvas = document.createElement("canvas");
  for (const size of [ICON_SIZE, ICON_SIZE / 2]) {
    const scale = Math.min(1, size / width, size / height);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Browsers without a WebP encoder fall back to PNG; record what was actually produced.
    const dataUrl = canvas.toDataURL("image/webp", 0.85);
    const mimeType = dataUrl.startsWith("data:image/webp;") ? "image/webp" : "image/png";
    if (dataUrl.length <= (HERMES_KANBAN_BOARD_ICON_MAX_BYTES * 4) / 3)
      return { dataUrl, mimeType };
  }
  throw new Error("That image is too large even after shrinking it.");
}

const NO_PROJECT = "__none__";

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** The board header's settings button; renders nothing without operate permission. */
export function HermesKanbanBoardSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly board: HermesKanbanBoardSummary;
}) {
  const { environmentId, board } = props;
  const canProject = useAtomValue(
    serverEnvironment.hermesKanbanSetBoardProject.permissionAtom(environmentId),
  );
  const canIcon = useAtomValue(
    serverEnvironment.hermesKanbanSetBoardIcon.permissionAtom(environmentId),
  );
  const setProject = useAtomCommand(serverEnvironment.hermesKanbanSetBoardProject, {
    label: "set Hermes board project",
  });
  const setIcon = useAtomCommand(serverEnvironment.hermesKanbanSetBoardIcon, {
    label: "set Hermes board icon",
  });
  const registry = useContext(RegistryContext);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!canProject && !canIcon) return null;

  const refresh = () => {
    registry.refresh(serverEnvironment.hermesKanbanListBoards({ environmentId, input: {} }));
    registry.refresh(
      serverEnvironment.hermesKanbanGetBoard({ environmentId, input: { slug: board.slug } }),
    );
  };

  const saveProject = async (projectId: ProjectId | null) => {
    if (busy || projectId === board.projectId) return;
    setBusy(true);
    const result = await setProject({ environmentId, input: { slug: board.slug, projectId } });
    setBusy(false);
    if (result._tag === "Success") refresh();
    else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not change the board's project", squashAtomCommandFailure(result));
    }
  };

  const saveIcon = async (icon: HermesKanbanBoardIcon | null) => {
    if (busy) return;
    setBusy(true);
    const result = await setIcon({ environmentId, input: { slug: board.slug, icon } });
    setBusy(false);
    if (result._tag === "Success") refresh();
    else if (!isAtomCommandInterrupted(result)) {
      reportFailure("Could not change the board's icon", squashAtomCommandFailure(result));
    }
  };

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    let icon: HermesKanbanBoardIcon;
    try {
      icon = await downscaleBoardIcon(file);
    } catch (error) {
      reportFailure("Could not use that image", error);
      return;
    }
    await saveIcon(icon);
  };

  // A link to a project that was since removed reads as no project here, as it does in the icon.
  const linked = projects.find((project) => project.id === board.projectId) ?? null;

  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label="Board settings" />}
      >
        <Settings2Icon />
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom" className="w-64" padding="compact">
        <div className="flex flex-col gap-3">
          <PopoverTitle>Board settings</PopoverTitle>
          {canProject ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">T3 project</span>
              <Select
                value={linked?.id ?? NO_PROJECT}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  void saveProject(value === NO_PROJECT ? null : (value as ProjectId));
                }}
                disabled={busy}
              >
                <SelectTrigger size="compact" aria-label="T3 project">
                  <SelectValue>
                    {linked === null ? (
                      "None"
                    ) : (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ProjectFavicon project={linked} className="size-3.5" />
                        <span className="truncate">{linked.title}</span>
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={NO_PROJECT}>None</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ProjectFavicon project={project} className="size-3.5" />
                        <span className="truncate">{project.title}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          ) : null}
          {canIcon ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Icon</span>
              <div className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-md border border-border/60">
                  <HermesKanbanBoardIconView environmentId={environmentId} board={board} />
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <ImageUpIcon />
                  Upload icon
                </Button>
                {board.customIcon === null ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void saveIcon(null)}
                  >
                    <Trash2Icon />
                    Remove icon
                  </Button>
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                className="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void onFile(file);
                }}
              />
              <p className="text-2xs text-muted-foreground">
                An uploaded icon wins over the project's. Shrunk to 128px.
              </p>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
