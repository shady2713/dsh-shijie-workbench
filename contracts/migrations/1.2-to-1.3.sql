-- v1.2 -> v1.3 migration. Existing rows are preserved.
-- Job claims get a monotonic generation so a stale worker can never submit after a reclaim.
ALTER TABLE jobs ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation>=0);
