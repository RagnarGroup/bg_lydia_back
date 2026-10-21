-- LYD-95: credenciales OAuth del canal TikTok (cifradas) y del anunciante.
-- Generada con prisma migrate diff (sin base) y sin el prefijo de schema, como el resto de migraciones.

-- CreateTable
CREATE TABLE "TiktokChannel" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "businessId" VARCHAR(100) NOT NULL,
    "username" VARCHAR(100),
    "displayName" VARCHAR(100),
    "scope" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'connected',
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "TiktokChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiktokAdvertiser" (
    "id" TEXT NOT NULL,
    "advertiserIds" JSONB NOT NULL,
    "scope" JSONB,
    "accessTokenEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "TiktokAdvertiser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TiktokChannel_instanceId_key" ON "TiktokChannel"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "TiktokChannel_businessId_key" ON "TiktokChannel"("businessId");

-- AddForeignKey
ALTER TABLE "TiktokChannel" ADD CONSTRAINT "TiktokChannel_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
