-- M25: skills and built-in capabilities. Additive only: one nullable column, no backfill.
-- The iPhone's region (ISO 3166-1 alpha-2), kept in sync from the X-Region header like timezone;
-- null until the app sends it. The weather tool's default unit (C / F) and place lookup use it.
ALTER TABLE "User" ADD COLUMN "region" TEXT;
