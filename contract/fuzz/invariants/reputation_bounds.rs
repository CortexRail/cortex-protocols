//! Invariant: Reputation Bounds.
//!
//! Asserts that every asset and agent reputation score in the state strictly
//! remains within the protocol's defined bounds `[MIN_REPUTATION, MAX_REPUTATION]`.

use super::model::State;

/// Minimum valid reputation score (0.00% in basis points).
pub const MIN_REPUTATION: u32 = 0;
/// Maximum valid reputation score (100.00% in basis points = 10,000 bps).
pub const MAX_REPUTATION: u32 = 10_000;

/// Check that all reputation scores in `state` lie strictly within `[MIN_REPUTATION, MAX_REPUTATION]`.
///
/// Panics if any asset or agent reputation score violates the protocol bounds.
pub fn check_reputation_bounds(state: &State) {
    for (asset_id, asset) in &state.assets {
        assert!(
            asset.reputation >= MIN_REPUTATION && asset.reputation <= MAX_REPUTATION,
            "Reputation bounds violation: Asset {} reputation score {} is outside [{}, {}]",
            asset_id,
            asset.reputation,
            MIN_REPUTATION,
            MAX_REPUTATION
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    #[test]
    fn test_reputation_bounds_valid() {
        let mut state = State::new();
        state
            .list_asset(
                "alice".into(),
                "Asset".into(),
                "Desc".into(),
                AssetType::Prompt,
                LicenseType::Perpetual,
                100,
                vec![],
            )
            .unwrap();

        check_reputation_bounds(&state);
    }

    #[test]
    #[should_panic(expected = "Reputation bounds violation")]
    fn test_reputation_bounds_out_of_range() {
        let mut state = State::new();
        let asset_id = state
            .list_asset(
                "alice".into(),
                "Asset".into(),
                "Desc".into(),
                AssetType::Prompt,
                LicenseType::Perpetual,
                100,
                vec![],
            )
            .unwrap();

        // Corrupt reputation score above MAX_REPUTATION (10,000)
        state.assets.get_mut(&asset_id).unwrap().reputation = 15_000;
        check_reputation_bounds(&state);
    }
}
