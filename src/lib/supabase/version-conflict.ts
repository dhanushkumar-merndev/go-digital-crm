/**
 * Optimistic-lock conflicts are raised with SQLSTATE `PT409`, which PostgREST
 * returns as HTTP 409. They used to be raised as `40001` (serialization
 * failure), which the request path retries: a stale save spun on the database
 * until the gateway timed out after about two minutes instead of failing at
 * once. `40001` is still accepted so a response from a not-yet-migrated
 * function is recognised the same way.
 */
export function isVersionConflictCode(code: unknown) {
  return code === 'PT409' || code === '40001';
}
