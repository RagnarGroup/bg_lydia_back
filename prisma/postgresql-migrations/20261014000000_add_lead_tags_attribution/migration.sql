-- LYD-87: etiquetas de campana y atribucion (UTMs) en Lead.
-- Generada con prisma migrate diff (sin base) y sin el prefijo de schema, como el resto de migraciones.

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "attribution" JSONB,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Lead_tags_idx" ON "Lead" USING GIN ("tags");
