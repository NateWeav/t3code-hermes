const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;

function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

async function assertCommitOnDefaultBranch({ github, context, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${sha}...${defaultBranch}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

async function assertReleaseSource({ github, context, releaseChannel }) {
  if (releaseChannel === "preview") return;
  if (releaseChannel !== "stable" && releaseChannel !== "nightly") {
    throw new Error(`Unsupported release channel: ${releaseChannel}`);
  }

  const defaultBranch = repositoryDefaultBranch(context);
  if (context.eventName === "workflow_dispatch" && context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error(
      `${releaseChannel} releases must be dispatched from ${defaultBranch}; selected ${context.ref}. Use the preview channel for branch builds.`,
    );
  }

  await assertCommitOnDefaultBranch({ github, context, sha: context.sha });
}

const isNightlyTag = (tag) => /^v.*-nightly\./.test(tag) || tag.startsWith("nightly-v");

// Only the three fields the gate reads. The REST list also returns every asset,
// which made a full scan tens of megabytes.
const RELEASES_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      releases(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { tagName isDraft publishedAt }
      }
    }
  }
`;

// Returns the nightly with the newest publishedAt. Release order follows the
// tagged commit date, not publication, so every page is read unless `isSettled`
// says the newest nightly seen so far already decides the caller's answer.
async function findLatestNightly({ github, context, isSettled = () => false }) {
  let latest;
  let cursor = null;
  do {
    const { repository } = await github.graphql(RELEASES_QUERY, { ...context.repo, cursor });
    const { nodes, pageInfo } = repository.releases;
    for (const release of nodes) {
      if (release.isDraft || !release.publishedAt || !isNightlyTag(release.tagName)) continue;
      if (!latest || Date.parse(release.publishedAt) > Date.parse(latest.publishedAt)) {
        latest = release;
      }
    }
    if (latest && isSettled(latest)) return latest;
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return latest;
}

async function shouldReleaseNightly({ github, context, core, now = Date.now() }) {
  const isInGap = (release) => now - Date.parse(release.publishedAt) < MINIMUM_RELEASE_GAP_MS;
  // Any nightly inside the gap means the newest one is too, so stop reading.
  const lastNightly = await findLatestNightly({ github, context, isSettled: isInGap });

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  const tag = lastNightly.tagName;
  if (isInGap(lastNightly)) {
    core.info(`Nightly ${tag} was published less than six hours ago. Skipping.`);
    return false;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${tag}...${context.sha}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead") {
    core.info(`Candidate commit is ${comparison.status} relative to ${tag}. Skipping.`);
    return false;
  }

  core.info(`New commits since ${tag}, and the six-hour gap has passed.`);
  return true;
}

const UPSTREAM_REPO = { owner: "pingdotgg", repo: "t3code" };

// Status of `base...head` in this repository, or undefined when GitHub cannot
// resolve `base` here (an upstream commit the fork has not merged yet).
async function compareStatus({ github, context, base, head }) {
  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo,
      basehead: `${base}...${head}`,
      per_page: 1,
    });
    return data.status;
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
}

const contains = (status) => status === "ahead" || status === "identical";

// Check the sync's upstream snapshot under the nightly concurrency lock.
// Comparing with the published nightly also catches merges via resolution PRs
// and retries failed releases, without releasing twice for the same upstream head.
async function shouldFollowUpstreamNightly({ github, context, core, upstreamSha }) {
  if (!/^[0-9a-f]{40}$/.test(upstreamSha ?? "")) {
    throw new Error("follow_upstream requires a full lowercase upstream_sha commit hash.");
  }
  // Verify that the supplied snapshot is an actual upstream commit.
  await github.rest.repos.getCommit({ ...UPSTREAM_REPO, ref: upstreamSha });

  if (!contains(await compareStatus({ github, context, base: upstreamSha, head: context.sha }))) {
    core.info(`Upstream commit ${upstreamSha} is not merged yet. Skipping.`);
    return false;
  }

  const lastNightly = await findLatestNightly({ github, context });
  if (
    lastNightly &&
    contains(await compareStatus({ github, context, base: upstreamSha, head: lastNightly.tagName }))
  ) {
    core.info(
      `Upstream commit ${upstreamSha} already shipped in ${lastNightly.tagName}. Skipping.`,
    );
    return false;
  }

  core.info(`Following upstream commit ${upstreamSha}.`);
  return true;
}

async function resolveLatestNightlyCommit({ github, context, core }) {
  const lastNightly = await findLatestNightly({ github, context });
  if (!lastNightly) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  const tag = lastNightly.tagName;
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  const version = /^(?:nightly-)?v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
  if (!version) {
    throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
  }

  core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
  return { tag, sha: commit.sha, version };
}

module.exports = {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
  shouldFollowUpstreamNightly,
  resolveLatestNightlyCommit,
};
