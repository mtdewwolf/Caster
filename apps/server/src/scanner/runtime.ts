import { db } from '../db';
import { AutoScanRuntime } from './auto-scan';
import { scanLibrary } from './indexer';

/**
 * The server's single automatic-scan runtime.
 *
 * Constructed here rather than in the route module so the API can adjust
 * watchers when settings change, without either file importing the other.
 * Nothing starts until `start()` is called from the server entry point.
 */
export const autoScanRuntime = new AutoScanRuntime({
  database: db,
  scanLibrary: (libraryId) => scanLibrary(libraryId)
});
