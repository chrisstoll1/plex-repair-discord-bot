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
