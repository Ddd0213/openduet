-- M27: voice settings apart from models, StepFun's region, optional cloud dictation. Additive only:
-- columns via ADD COLUMN (no table is rebuilt), then a one-time backfill of StepFun providers.

-- The provider's site, for kinds that have regions (stepfun: cn | intl); null = no regions.
ALTER TABLE "ModelProvider" ADD COLUMN "region" TEXT;

-- The composer microphone's recognizer: device (Apple's, the default) | cloud; Apple's only on the
-- iPhone; the cloud recognizer's provider (a ModelProvider id, plain column) and model id.
ALTER TABLE "User" ADD COLUMN "dictationEngine" TEXT NOT NULL DEFAULT 'device';
ALTER TABLE "User" ADD COLUMN "dictationOnDevice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "dictationProviderId" TEXT;
ALTER TABLE "User" ADD COLUMN "dictationModelId" TEXT;

-- Existing StepFun providers keep the site they use today: mainland China (api.stepfun.com, and
-- wss://api.stepfun.com/v1/realtime for calls). Their baseUrl is not touched.
UPDATE "ModelProvider" SET "region" = 'cn' WHERE "kind" = 'stepfun' AND "region" IS NULL;
