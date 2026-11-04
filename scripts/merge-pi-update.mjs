import { isDeepStrictEqual } from "node:util";

const dependency = "@earendil-works/pi-coding-agent";

function isStableUpgrade(before, after) {
  if (!/^\d+\.\d+\.\d+$/.test(before) || !/^\d+\.\d+\.\d+$/.test(after)) return false;
  const previous = before.split(".").map(Number);
  const next = after.split(".").map(Number);
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== next[index]) return next[index] > previous[index];
  }
  return false;
}

// Runs from the trusted default branch after Container validation. Never import
// code or artifacts from an update PR in this privileged workflow.
export async function mergePiUpdate({ github, context, core }) {
  const run = context.payload.workflow_run;
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  if (run?.conclusion !== "success" || run.event !== "pull_request" || run.head_repository?.full_name !== repository) return;

  const associated = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: run.head_sha });
  for (const candidate of associated.data) {
    const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: candidate.number });
    if (pr.state !== "open" || pr.draft || pr.user.login !== "dependabot[bot]" ||
        pr.base.ref !== "master" || pr.head.repo?.full_name !== repository || pr.head.sha !== run.head_sha) continue;

    const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 });
    if (!files.length || files.some((file) => !["package.json", "package-lock.json"].includes(file.filename))) continue;
    const readPackage = async (ref) => {
      const { data } = await github.rest.repos.getContent({ ...repo, path: "package.json", ref });
      return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    };
    const before = await readPackage(pr.base.sha);
    const after = await readPackage(pr.head.sha);
    const previous = before.dependencies?.[dependency];
    const next = after.dependencies?.[dependency];
    if (!previous || !next || !isStableUpgrade(previous, next)) continue;
    delete before.dependencies[dependency];
    delete after.dependencies[dependency];
    if (!isDeepStrictEqual(before, after)) continue;

    // GitHub also enforces master's required checks. SHA matching rejects a PR
    // changed since validation, even if it changes during the API calls above.
    const { data: result } = await github.rest.pulls.merge({ ...repo, pull_number: pr.number, sha: run.head_sha, merge_method: "squash" });
    if (!result.merged) throw new Error(`Pi update #${pr.number} was not merged: ${result.message}`);
    core.info(`Merged Pi update #${pr.number}: ${previous} -> ${next}`);
    // GITHUB_TOKEN merges do not trigger push workflows. Dispatch explicitly
    // so a successful automatic update still publishes the release image.
    await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: "container.yml", ref: "master" });
  }
}
