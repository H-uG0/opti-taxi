-- Plans computed before traffic existed used free-flow times, not the factors:
-- they must not count for the calibration (lib/domain/traffic-observed.ts).
UPDATE "AppSettings" SET "trafficChangedAt" = CURRENT_TIMESTAMP;
