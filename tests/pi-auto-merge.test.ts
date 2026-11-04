import assert from "node:assert/strict";
import test from "node:test";
import { mergePiUpdate } from "../scripts/merge-pi-update.mjs";

function fixture() {
  const repository = "owner/bot";
  const pr = { number: 12, state: "open", draft: false, user: { login: "dependabot[bot]" }, base: { ref: "master", sha: "base" }, head: { sha: "validated", repo: { full_name: repository } } };
  const run = { conclusion: "success", event: "pull_request", head_sha: "validated", head_repository: { full_name: repository } };
  const before = { scripts: { postinstall: "safety-check" }, dependencies: { "@earendil-works/pi-coding-agent": "1.5.0", other: "1.0.0" } };
  const after = structuredClone(before);
  after.dependencies["@earendil-works/pi-coding-agent"] = "1.6.0";
  const files = [{ filename: "package.json" }, { filename: "package-lock.json" }];
  const merges: unknown[] = [];
  const dispatches: unknown[] = [];
  const github = {
    paginate: async () => files,
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async () => ({ data: [pr] }),
        getContent: async ({ ref }: { ref: string }) => ({ data: { content: Buffer.from(JSON.stringify(ref === "base" ? before : after)).toString("base64") } }),
      },
      pulls: {
        get: async () => ({ data: pr }),
        listFiles: () => undefined,
        merge: async (input: unknown) => { merges.push(input); return { data: { merged: true } }; },
      },
      actions: { createWorkflowDispatch: async (input: unknown) => { dispatches.push(input); } },
    },
  };
  const input = { github, context: { repo: { owner: "owner", repo: "bot" }, payload: { workflow_run: run } }, core: { info: () => undefined } };
  return { input, pr, run, before, after, files, merges, dispatches };
}

test("successful Pi-only validation merges exactly the tested SHA and publishes an image", async () => {
  const f = fixture();
  await mergePiUpdate(f.input);
  assert.deepEqual(f.merges, [{ owner: "owner", repo: "bot", pull_number: 12, sha: "validated", merge_method: "squash" }]);
  assert.deepEqual(f.dispatches, [{ owner: "owner", repo: "bot", workflow_id: "container.yml", ref: "master" }]);
});

test("failed, stale, forked, manual and mixed dependency updates never merge or publish", async () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => { f.run.conclusion = "failure"; },
    (f: ReturnType<typeof fixture>) => { f.run.event = "push"; },
    (f: ReturnType<typeof fixture>) => { f.run.head_repository.full_name = "other/fork"; },
    (f: ReturnType<typeof fixture>) => { f.pr.head.repo.full_name = "other/fork"; },
    (f: ReturnType<typeof fixture>) => { f.pr.user.login = "human"; },
    (f: ReturnType<typeof fixture>) => { f.pr.head.sha = "changed-after-validation"; },
    (f: ReturnType<typeof fixture>) => { f.pr.base.ref = "other"; },
    (f: ReturnType<typeof fixture>) => { f.pr.draft = true; },
    (f: ReturnType<typeof fixture>) => { f.pr.state = "closed"; },
    (f: ReturnType<typeof fixture>) => { f.files.push({ filename: "scripts/patch-pi-streaming.mjs" }); },
    (f: ReturnType<typeof fixture>) => { f.after.scripts.postinstall = "changed-command"; },
    (f: ReturnType<typeof fixture>) => { f.after.dependencies.other = "2.0.0"; },
    (f: ReturnType<typeof fixture>) => { f.after.dependencies["@earendil-works/pi-coding-agent"] = "1.5.0"; },
    (f: ReturnType<typeof fixture>) => { f.after.dependencies["@earendil-works/pi-coding-agent"] = "1.4.0"; },
    (f: ReturnType<typeof fixture>) => { f.after.dependencies["@earendil-works/pi-coding-agent"] = "1.6.0-beta.1"; },
  ];
  for (const change of cases) {
    const f = fixture();
    change(f);
    await mergePiUpdate(f.input);
    assert.deepEqual(f.merges, []);
    assert.deepEqual(f.dispatches, []);
  }
});

test("a rejected merge cannot publish a release", async () => {
  const f = fixture();
  f.input.github.rest.pulls.merge = async () => { throw new Error("Required build check has not passed"); };
  await assert.rejects(mergePiUpdate(f.input), /Required build/);
  assert.deepEqual(f.dispatches, []);
});

test("an unsuccessful merge response cannot publish a release", async () => {
  const f = fixture();
  f.input.github.rest.pulls.merge = async () => ({ data: { merged: false } });
  await assert.rejects(mergePiUpdate(f.input), /was not merged/);
  assert.deepEqual(f.dispatches, []);
});
