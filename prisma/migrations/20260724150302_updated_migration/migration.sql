-- AlterTable
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'topics'
      AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "topics" ALTER COLUMN "updatedAt" DROP DEFAULT;
  END IF;
END $$;
