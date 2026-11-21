# TrueNAS catalog package

This directory contains the source for the **community** app in [truenas/apps](https://github.com/truenas/apps). The catalog entry targets the public, digest-verified **0.2.3** image as catalog version **1.0.1** (initial catalog version **1.0.0** for 0.2.2 was merged in [app-addition PR #6560](https://github.com/truenas/apps/pull/6560)).

The package follows the upstream [contribution guide](https://github.com/truenas/apps/blob/master/CONTRIBUTIONS.md). It includes metadata, generated listing data, install/edit questions, a Compose template and two storage test cases. `toolchain.json` pins the upstream source and validation image used to verify it. Generated rendering libraries and rendered Compose files are deliberately excluded from Git.

## Installation behavior

- Default portal port: **30600**, selected with the upstream port validator. Recheck availability against the current catalog immediately before opening the upstream PR. The earlier provisional ports 30598 and 30599 are now used by other apps.
- Default user/group: **568:568**, configurable. The image itself defaults to **1000:1000** for ordinary Docker installations.
- Persistent mount: **/config**, with an ixVolume by default or an existing host dataset path. The permissions helper initializes empty datasets only; existing datasets need suitable ownership/ACLs before upgrading.
- The main container drops capabilities, prevents privilege escalation and uses a read-only root filesystem with a temporary /tmp filesystem.
- Health checks call **/health**. Discord, media service and AI configuration are completed after installation; missing credentials do not prevent first-time setup.
- Network and resource settings use standard catalog groups. CPU/memory defaults are initial configuration defaults, not a measured minimum for every workload.
- The portal opens directly by default. Optional form sign-in is configured in Settings > Security; it needs no shell token and works alongside reverse-proxy authentication. For an HTTPS-only portal, add PORTAL_SECURE_COOKIE=true under Additional Environment Variables.
- The app uses network APIs to Plex/Sonarr/Radarr/Seerr. It does not request host media directories, Docker socket access, TrueNAS API keys or privileged mode.

## Validation

From the repository root, with Git and Docker available:

```bash
docker compose build plex-repairman
node scripts/smoke-container.mjs plex-repairman:dev
node scripts/check-truenas-catalog.mjs --image plex-repairman:dev
```

The catalog script runs the actual upstream metadata generator, port validator and development catalog/schema validator. It renders both managed-volume and host-path cases, then installs each rendered configuration with the locally built image. Tests use random Compose project names and synthetic data. They clean up their containers and configuration data. On Docker Desktop, a disposable Linux volume avoids NTFS limitations in the upstream tools' atomic file writes.

The submitted app includes the conventional `templates/test_values/basic-values.yaml` only. Supplemental host-path coverage lives in `packaging/truenas/fixtures/host-path-values.yaml`; our checker copies it into its disposable validation workspace. It is excluded from the catalog submission and release exporter.

After intentionally changing metadata or the pinned toolchain, regenerate listing metadata:

```bash
node scripts/check-truenas-catalog.mjs --write --image plex-repairman:dev
```

`item.yaml`, generated fields in `app.yaml` and the README warning block come from the upstream generator. Do not hand-edit those generated fields. Keep the base library version aligned with `toolchain.json`.

## Release and submission

1. Merge the reviewed application changes into **master** and let the Container checks pass. Publishing an image does not itself restart a TrueNAS app; existing production deployments remain a separate operation.
2. Create the Git tag **v0.2.3** on the reviewed master commit. The Container workflow requires the tag to match package.json and its commit to belong to master. It checks dependencies, tests the application and catalog installations, then publishes the stable image and exact source/build tags. Wait for the intended workflow to succeed.
3. Export a submission with the verified public image digest:

   ```bash
   node scripts/prepare-truenas-release.mjs --output .agent-local/truenas-submission-0.2.3
   ```

   The exporter refuses an unpublished release, a mismatched version label, a root-default image, a wrong platform or an existing destination. It records the source revision and pins the manifest digest. It does not publish anything or change production.
4. Open an app-addition issue in truenas/apps to discuss inclusion before its PR; the current upstream template requires this. Fork the current repository and copy the exported **ix-dev/community/plex-repairman** directory into it. Recheck the default port and latest non-v1 library. If the library changes, regenerate metadata and rerun all test values using the upstream guide. Validate the exported digest-pinned definition as well as this source package.
5. Open a community app-addition PR with the upstream template. Include the upstream repository, MIT license, stable image version/digest, successful Container URL, test results and assets. Describe the Discord and AI authentication prerequisites and the optional form sign-in.
6. Attach assets from **assets/** for reviewer upload to the TrueNAS CDN. The metadata contains the planned CDN locations; they are not claimed to be live before review. Update the URLs if the reviewer supplies different locations.
7. Address automated and maintainer review. Acceptance is decided by TrueNAS maintainers. Upstream policy excludes apps that require the TrueNAS management API or pose known data-integrity risks; this package requires no host-management access, and optional destructive media operations remain disabled by default.

Do not submit a catalog entry pointing to an unpublished 0.2.3 image or to the mutable latest tag. Keep production restarts separate from catalog submission and follow the repository's deployment workflow when one is authorized.

The GHCR package must be public. Repository visibility does not automatically make a container package public. Ensure anonymous image downloads work before submission. An owner can change the [container package visibility](https://github.com/users/chrisstoll1/packages/container/plex-repair-discord-bot/settings) before export and submission. See [GitHub's package visibility instructions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
