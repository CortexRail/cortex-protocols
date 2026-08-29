//! Invariant: Asset Ownership.
//!
//! Asserts that an asset's owner field can only change between consecutive
//! states if and only if the applied action is explicitly `TransferAsset`.

use super::model::State;
use super::Action;

/// Check that asset ownership transitions are strictly authorized.
///
/// Panics if an asset's owner changes on any non-`TransferAsset` action,
/// or if `TransferAsset` assigned an unexpected owner.
pub fn check_asset_ownership(before: &State, after: &State, action: &Action) {
    for (asset_id, before_asset) in &before.assets {
        if let Some(after_asset) = after.assets.get(asset_id) {
            if before_asset.owner != after_asset.owner {
                match action {
                    Action::TransferAsset {
                        asset_id: target_id,
                        new_owner,
                        ..
                    } => {
                        assert_eq!(
                            target_id, asset_id,
                            "Asset ownership changed on asset {} but TransferAsset targeted asset {}",
                            asset_id, target_id
                        );
                        assert_eq!(
                            &after_asset.owner, new_owner,
                            "Asset {} owner was changed to {} instead of requested new_owner {}",
                            asset_id, after_asset.owner, new_owner
                        );
                    }
                    _ => {
                        panic!(
                            "Asset ownership violation: Asset {} owner changed from '{}' to '{}' on non-TransferAsset action: {:?}",
                            asset_id, before_asset.owner, after_asset.owner, action
                        );
                    }
                }
            } else {
                // If action was TransferAsset targeting this asset and succeeded, owner should have changed
                // (unless transfer was a no-op or rejected, which is checked by the harness)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    #[test]
    fn test_asset_ownership_transfer_valid() {
        let mut before = State::new();
        let asset_id = before
            .list_asset(
                "alice".into(),
                "Asset".into(),
                "Desc".into(),
                AssetType::Workflow,
                LicenseType::Perpetual,
                100,
                vec![],
            )
            .unwrap();

        let mut after = before.clone();
        let action = Action::TransferAsset {
            current_owner: "alice".into(),
            new_owner: "bob".into(),
            asset_id,
        };

        after
            .transfer_asset("alice".into(), "bob".into(), asset_id)
            .unwrap();

        check_asset_ownership(&before, &after, &action);
    }

    #[test]
    #[should_panic(expected = "Asset ownership violation")]
    fn test_asset_ownership_unauthorized_change() {
        let mut before = State::new();
        let asset_id = before
            .list_asset(
                "alice".into(),
                "Asset".into(),
                "Desc".into(),
                AssetType::Workflow,
                LicenseType::Perpetual,
                100,
                vec![],
            )
            .unwrap();

        let mut after = before.clone();
        // Illegal owner modification on a PublishUpdate action
        let action = Action::PublishUpdate {
            owner: "alice".into(),
            asset_id,
            new_description: "New Desc".into(),
        };

        after.assets.get_mut(&asset_id).unwrap().owner = "mallory".into();

        check_asset_ownership(&before, &after, &action);
    }
}
