# Agent Instructions

## Development Workflow

- Run `npm run typecheck` after TypeScript changes.
- Rebuild the local development Docker image after completing runtime code or dependency changes:

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
- Do not skip the Docker rebuild when changing runtime code; manual testing runs against the local dev container.
- Keep unrelated user changes intact. Do not revert files unless explicitly asked.
- `master` is the default and release branch.

## Local Overrides

- Before investigating a live deployment or running host-specific operations, read `.agent-local/AGENTS.md` if it exists. That directory is excluded from Git and holds local-only environment notes.
- Never print saved credentials, include them in tool output, or commit files from `.agent-local/`.
