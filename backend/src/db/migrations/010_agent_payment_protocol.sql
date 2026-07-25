-- Add off-chain call metering columns to the streams table for the Agent Payment Protocol.
ALTER TABLE streams ADD COLUMN IF NOT EXISTS calls_remaining BIGINT DEFAULT 0;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS calls_used BIGINT DEFAULT 0;
ALTER TABLE streams ADD COLUMN IF NOT EXISTS price_per_call BIGINT DEFAULT 0;
