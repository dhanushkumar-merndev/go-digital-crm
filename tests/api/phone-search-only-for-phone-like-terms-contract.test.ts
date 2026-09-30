import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationName = '20260928190000_phone_search_only_for_phone_like_terms.sql';
const migration = readFileSync(join(migrationsDirectory, migrationName), 'utf8');

describe('phone search only for phone-like terms', () => {
  it('treats a search as a phone number only when it looks like one', () => {
    expect(migration).toContain('create or replace function app_private.phone_search_digits(');
    expect(migration).toContain("when coalesce(search_text, '') ~ '^[0-9+()\\s.-]+$'");
    expect(migration).toContain(
      'revoke all on function app_private.phone_search_digits(text) from public, anon, authenticated;',
    );
  });

  it('patches every search assignment in place and proves none is left', () => {
    expect(migration).toContain("'\\1app_private.phone_search_digits(\\2'");
    expect(migration).toContain("raise exception 'PHONE_SEARCH_PATCH_FOUND_TOO_FEW: %'");
    expect(migration).toContain("raise exception 'PHONE_SEARCH_FREE_TEXT_DIGITS_STILL_USED'");
  });

  it('is not undone by a later migration deriving phone digits from free text', () => {
    const later = readdirSync(migrationsDirectory).filter((name) => name > migrationName);
    for (const name of later) {
      const text = readFileSync(join(migrationsDirectory, name), 'utf8');
      expect(
        text,
        `${name} derives a phone search from free text; use app_private.phone_search_digits`,
      ).not.toMatch(
        /:=\s*app_private\.normalize_phone_digits\(\s*(normalized_search|search_term|target_search)/,
      );
    }
  });
});
