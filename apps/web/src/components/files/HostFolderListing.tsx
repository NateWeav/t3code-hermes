import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

import { fileBreadcrumbChildren, hostFolderChildPath, hostFolderParent } from "./filePath";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * Read-only listing for a folder outside the workspace, reached from a chat link.
 * The workspace tree cannot reveal host paths, so entries open through the same
 * file surface: a file previews, a folder lands back here one level down.
 */
export function HostFolderListing(props: {
  readonly environmentId: EnvironmentId;
  readonly folderPath: string;
  readonly onOpenPath: (absolutePath: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  // An empty directoryPath lists the folder's immediate children, ignored entries included.
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.folderPath, "");
  const children = useMemo(
    () => fileBreadcrumbChildren(entriesQuery.data?.entries ?? [], ""),
    [entriesQuery.data],
  );
  const parentPath = hostFolderParent(props.folderPath);

  if (entriesQuery.data === null) {
    return entriesQuery.error && !entriesQuery.isPending ? (
      <FileSurfaceFailure message={entriesQuery.error} onRetry={entriesQuery.refresh} />
    ) : (
      <FileSurfaceLoading />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2" data-host-folder-listing>
      {parentPath !== null ? (
        <button
          type="button"
          className={cn(ROW_CLASS, "text-muted-foreground")}
          onClick={() => props.onOpenPath(parentPath)}
        >
          <ArrowLeftIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Up to {parentPath}</span>
        </button>
      ) : null}
      {children.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">This folder is empty.</p>
      ) : (
        children.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={cn(ROW_CLASS, entry.ignored && "text-muted-foreground")}
            onClick={() => props.onOpenPath(hostFolderChildPath(props.folderPath, entry.label))}
          >
            <PierreEntryIcon pathValue={entry.path} kind={entry.kind} theme={resolvedTheme} />
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          </button>
        ))
      )}
    </div>
  );
}
