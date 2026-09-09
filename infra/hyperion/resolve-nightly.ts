// @effect-diagnostics globalFetch:off globalConsole:off - Deployment bootstrap runs before dependencies are installed.
import * as NodeURL from "node:url";

/** Select published nightlies, excluding stable releases and draft review artifacts. */
export function selectNightlyTag(releases: unknown): string {
  if (!Array.isArray(releases)) throw new Error("GitHub did not return a release list.");
  let latest: { tag: string; publishedAt: number } | undefined;
  for (const release of releases as unknown[]) {
    if (typeof release !== "object" || release === null) continue;
    const {
      draft,
      prerelease,
      tag_name: tag,
      published_at: publishedAt,
    } = release as Record<string, unknown>;
    if (
      draft !== false ||
      prerelease !== true ||
      typeof tag !== "string" ||
      !/^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$/.test(tag) ||
      typeof publishedAt !== "string"
    )
      continue;
    const timestamp = Date.parse(publishedAt);
    if (Number.isFinite(timestamp) && (!latest || timestamp > latest.publishedAt)) {
      latest = { tag, publishedAt: timestamp };
    }
  }
  if (!latest) throw new Error("No published nightly release found.");
  return latest.tag;
}

export function githubRepository(remote: string): string {
  const repository = remote
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git\/?$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Nightly updates require a GitHub repository URL.");
  }
  return repository;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  try {
    const repository = githubRepository(process.argv[2] ?? "");
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "t3-hermes-nightly-updater",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub release lookup failed (HTTP ${response.status}).`);
    console.log(selectNightlyTag(await response.json()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
