# Agent Instructions

## Development Workflow

- Run `npm run typecheck` after TypeScript changes.
- Rebuild the local development Docker image after completing code or dependency changes:

```bash
docker compose build plex-repairman
```

- Restart the dev container after the rebuild so the running bot uses the latest image:

```bash
docker compose up -d plex-repairman
```

- Check the service starts cleanly:

```bash
docker compose ps
docker compose logs --tail=80 plex-repairman
```

## Notes

- The development compose service is `plex-repairman` and the local image is `plex-repairman:dev`.
- Do not skip the Docker rebuild when changing runtime code; the user tests against the running dev container.
- Keep unrelated user changes intact. Do not revert files unless explicitly asked.

## Live Portal Access

- Before investigating the live deployment, read `.agent-local/AGENTS.md` if it exists. It documents locally saved portal access and is excluded from Git.
- Never print saved credentials, include them in tool output, or commit files from `.agent-local/`.

## TrueNAS Operations

- TrueNAS access is configured centrally under the root T3 project `Codin` (`C:\Codin`, project ID `feaf04b2-a72f-4f46-8497-04c4ab73fab1`).
- When an authorized task needs a TrueNAS operation, you may launch a new top-level thread there with `t3_thread_launch`, `projectId` set to the ID above, and `workspaceStrategy: { type: "root" }`.
- Tell the root thread to read `C:\Codin\AGENTS.md` and `C:\Codin\.agent-local\AGENTS.md`, then pass the specific operation and relevant non-secret context. Do not copy TrueNAS credentials into this repository or the thread prompt.
- Preserve deployment constraints in the handoff, including any instruction to leave a PR unmerged or not deploy yet. Link the created thread in the response using its returned link.

## Production Deployment

- The user confirms that the Plex Repairman TrueNAS app pulls the latest image when restarted. A production restart therefore deploys the latest published image.
- When deployment is authorized:
  1. Push or merge the changes to `master` (this repository's release branch, not `main`).
  2. Wait for the GitHub Actions `Container` workflow for the intended commit to succeed and publish `ghcr.io/chrisstoll1/plex-repair-discord-bot:latest`.
  3. Hand off the TrueNAS app restart to a thread in the root Codin project, including the commit, successful build URL, and expected image version/digest.
  4. Verify the app starts cleanly, `/health` succeeds, and the running version/image matches the intended release.
- Do not restart before successful image publication. Preserve any request to keep a PR unmerged; documenting this procedure does not authorize a deployment.
