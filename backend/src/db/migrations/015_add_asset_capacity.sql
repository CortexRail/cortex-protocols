-- Capacity-constrained asset support.
--
-- Assets with capacity > 0 are scarce, high-demand streams sold through the
-- sealed-bid auction flow instead of first-come direct quotes. The value is
-- the number of concurrent capacity slots an auction admits (matches the
-- `capacity` parameter of the marketplace contract's open_auction).

ALTER TABLE assets ADD COLUMN capacity INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_assets_capacity ON assets (capacity) WHERE capacity > 0;