# Merge and release gates

Caster's CI workflow validates the same commit through unit/integration tests,
a production-build browser suite, and a production container build. Configure
GitHub branch protection for `Master` to require these checks:

- **Typecheck, Test & Build**
- **Browser E2E**
- **Container Build & Smoke Test**

Require branches to be up to date before merging and do not allow a release to
bypass a failed or pending check. The container check builds the locked
production image, fails on fixed critical vulnerabilities or an end-of-life
base OS, starts the image, and verifies health, authentication configuration,
and web assets.

## Release checklist

1. Select the exact commit to release and confirm all three required checks
   passed for that commit.
2. Review dependency-audit, browser, image-scan, and container-smoke output.
   Download the Playwright failure artifact before rerunning a failed job.
3. Create and validate a live database backup using
   [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Keep the previous application image
   or source checkout and database backup until the update is accepted.
4. Tag or publish only the verified commit. Use an immutable version or digest;
   do not retag an unrelated local build as the release.
5. After deployment, verify `/health`, admin login, a library scan, direct
   playback, a forced transcode with CPU fallback available, subtitles, and
   progress persistence.
6. If validation fails, stop Caster, restore the prior application version,
   and use the staged database restore procedure when the schema or data was
   changed.

The current workflow validates an ephemeral `caster:ci` image but does not push
images to a registry. Any future publishing workflow must depend on the same
required checks and publish from their exact commit rather than rebuilding from
an unverified working tree.
