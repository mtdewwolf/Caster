# SQLite backup and restore

Caster stores its catalog, settings, and watch progress in `media.db`. The
database runs in SQLite WAL mode, so copying `media.db` while Caster is running
is not a safe backup: committed changes may still be in `media.db-wal`.

The backup command uses a passive WAL checkpoint followed by SQLite
`VACUUM INTO`. This produces a consistent, standalone snapshot while Caster's
database remains open. Every snapshot is then opened read-only and checked with
`PRAGMA integrity_check` before it is retained.

## Create a live backup

Run this from the repository root. The destination can be any dedicated,
writable directory mounted into the host or container:

```sh
bun run apps/server/src/db/backup.ts backup \
  --database ./data/media.db \
  --destination ./backups \
  --retention 7
```

`--retention` is the number of newest Caster-created backups to keep and must
be a positive integer. It defaults to `7`. Retention only removes files that
match Caster's generated `caster-media-<timestamp>-<uuid>.sqlite` names;
unrelated and manually named files in the destination are left alone.

The command prints JSON containing the backup path, size, integrity result,
checkpoint counts, and any older files it pruned. A nonzero exit status means
the job failed and should alert the operator.

Schedule the same command with the host scheduler, a NAS scheduled task, or a
container job. Keep the backup destination on persistent storage and monitor
both exit status and free space. A separate storage device or replicated target
protects against loss of the volume containing `media.db`.

## What is included

Each generated file contains only the SQLite database. It includes catalog
records, library paths, settings, and watch progress. It does **not** copy:

- Source movie, episode, or music files
- Thumbnail/poster files (database path references are retained)
- Transcode or HLS cache files
- Any other file beside `media.db`

Back up irreplaceable media separately. Thumbnail and transcode caches can be
regenerated and normally should not be part of the database backup job.

## Validate a backup

Validation is automatic at creation and restore time. It can also be run by
itself, including after copying a snapshot to off-site storage:

```sh
bun run apps/server/src/db/backup.ts validate \
  --backup ./backups/caster-media-2026-08-23T12-34-56.789Z-UUID.sqlite
```

Do periodic restore drills in addition to automated validation. Integrity
validation confirms SQLite structure; a restore drill also confirms that the
correct backup files, permissions, mounts, and operating procedure are usable.

## Restore safely

Restore is a staged operation. The command refuses to overwrite an existing
file or the active `media.db`, preventing an open SQLite database and its WAL
sidecars from being replaced underneath Caster.

1. Validate and stage the selected backup at a new path:

   ```sh
   bun run apps/server/src/db/backup.ts restore \
     --backup ./backups/caster-media-2026-08-23T12-34-56.789Z-UUID.sqlite \
     --destination ./data/media.restored.db \
     --active-database ./data/media.db
   ```

2. Stop Caster completely. For containers, stop the container rather than only
   stopping a proxy in front of it. Confirm no Caster process has `media.db`
   open.
3. Move the current `media.db`, `media.db-wal`, and `media.db-shm` (when present)
   together into a dated rollback directory. Do not leave old WAL/SHM sidecars
   beside a replacement database.
4. Rename `media.restored.db` to `media.db` on the same filesystem and ensure its
   owner and permissions match the service account.
5. Start Caster and verify login, libraries, settings, and watch progress. Keep
   the rollback copy until the restore has been accepted.

To roll back, stop Caster again, preserve the failed restored database and its
sidecars, then move the original database and its paired sidecars back together.

## Operational notes and limitations

- The passive checkpoint is best effort and does not block active writers.
  `VACUUM INTO` still reads a consistent SQLite snapshot containing committed
  WAL changes even if every WAL frame could not be checkpointed first.
- Backup creation needs enough free destination space for another database
  copy. It does not currently compress or encrypt snapshots.
- Retention is count-based and has no cross-process scheduler lock. Configure
  only one backup job per database at a time.
- The module stages restores but deliberately does not perform the final active
  database swap. That promotion must happen while Caster is stopped.
- SQLite depends on reliable filesystem locking. Keep the active database on a
  filesystem supported by the host/NAS platform; test the exact mount and
  recovery procedure used in production.

References: [SQLite safe backup techniques](https://sqlite.org/howtocorrupt.html#bakfile),
[VACUUM INTO](https://sqlite.org/lang_vacuum.html#vacuuminto), and
[Bun SQLite WAL behavior](https://bun.sh/docs/runtime/sqlite#wal-mode).
