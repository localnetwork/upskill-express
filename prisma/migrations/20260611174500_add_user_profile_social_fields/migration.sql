-- AlterTable
ALTER TABLE "users"
ADD COLUMN "headline" TEXT,
ADD COLUMN "biography" TEXT,
ADD COLUMN "link_website" TEXT,
ADD COLUMN "link_x" TEXT,
ADD COLUMN "link_linkedin" TEXT,
ADD COLUMN "link_instagram" TEXT,
ADD COLUMN "link_facebook" TEXT,
ADD COLUMN "link_tiktok" TEXT,
ADD COLUMN "link_youtube" TEXT,
ADD COLUMN "link_github" TEXT;

-- Backfill from legacy platform_settings profile JSON when present
UPDATE "users" AS u
SET
  "headline" = COALESCE(ps.value::jsonb ->> 'headline', u."headline"),
  "biography" = COALESCE(ps.value::jsonb ->> 'biography', u."biography"),
  "link_website" = COALESCE(ps.value::jsonb ->> 'link_website', u."link_website"),
  "link_x" = COALESCE(ps.value::jsonb ->> 'link_x', u."link_x"),
  "link_linkedin" = COALESCE(ps.value::jsonb ->> 'link_linkedin', u."link_linkedin"),
  "link_instagram" = COALESCE(ps.value::jsonb ->> 'link_instagram', u."link_instagram"),
  "link_facebook" = COALESCE(ps.value::jsonb ->> 'link_facebook', u."link_facebook"),
  "link_tiktok" = COALESCE(ps.value::jsonb ->> 'link_tiktok', u."link_tiktok"),
  "link_youtube" = COALESCE(ps.value::jsonb ->> 'link_youtube', u."link_youtube"),
  "link_github" = COALESCE(ps.value::jsonb ->> 'link_github', u."link_github")
FROM "platform_settings" AS ps
WHERE ps."key" = CONCAT('user_profile::', u."id");
