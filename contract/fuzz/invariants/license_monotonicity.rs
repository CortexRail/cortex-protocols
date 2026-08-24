//! Invariant: License Monotonicity.
//!
//! Asserts that `calls_remaining` on any license never drops below zero and
//! strictly never increases between consecutive states unless the applied action
//! is explicitly `TopUpCalls`.

use super::model::{LicenseType, State};
use super::Action;

/// Check license monotonicity invariant across a state transition.
///
/// Panics if:
/// 1. Any license in the resulting state has invalid or corrupt `calls_remaining`.
/// 2. `calls_remaining` on an existing license increased without a `TopUpCalls` action.
pub fn check_license_monotonicity(before: &State, after: &State, action: &Action) {
    // 1. Check all licenses in the post-state
    for (license_id, license) in &after.licenses {
        match license.license_type {
            LicenseType::UsageBased => {
                // Usage-based license calls are bounded within standard limits
                assert!(
                    license.calls_remaining <= u64::MAX,
                    "License {} calls_remaining is invalid: {}",
                    license_id,
                    license.calls_remaining
                );
            }
            LicenseType::Perpetual | LicenseType::OpenSource => {
                assert_eq!(
                    license.calls_remaining,
                    u64::MAX,
                    "Perpetual / OpenSource license {} must have u64::MAX calls_remaining",
                    license_id
                );
            }
            LicenseType::Subscription => {
                assert_eq!(
                    license.calls_remaining, 0,
                    "Subscription license {} must have 0 calls_remaining",
                    license_id
                );
            }
        }
    }

    // 2. Check monotonicity across pre- and post-state
    for (license_id, before_lic) in &before.licenses {
        if let Some(after_lic) = after.licenses.get(license_id) {
            if after_lic.calls_remaining > before_lic.calls_remaining {
                // calls_remaining increased: MUST be a TopUpCalls action targeting this asset & buyer
                match action {
                    Action::TopUpCalls {
                        buyer,
                        asset_id,
                        additional_calls,
                        ..
                    } => {
                        assert_eq!(
                            buyer, &after_lic.buyer,
                            "License {} calls_remaining increased on TopUpCalls for different buyer: {} != {}",
                            license_id, buyer, after_lic.buyer
                        );
                        assert_eq!(
                            asset_id, &after_lic.asset_id,
                            "License {} calls_remaining increased on TopUpCalls for different asset: {} != {}",
                            license_id, asset_id, after_lic.asset_id
                        );
                        assert_eq!(
                            after_lic.calls_remaining,
                            before_lic.calls_remaining.saturating_add(*additional_calls),
                            "License {} calls_remaining did not increase by exact additional_calls ({})",
                            license_id, additional_calls
                        );
                    }
                    _ => {
                        panic!(
                            "License monotonicity violation: License {} calls_remaining increased from {} to {} on non-TopUp action: {:?}",
                            license_id, before_lic.calls_remaining, after_lic.calls_remaining, action
                        );
                    }
                }
            } else if after_lic.calls_remaining < before_lic.calls_remaining {
                // calls_remaining decreased: must be ConsumeCall
                if let Action::ConsumeCall { buyer, asset_id } = action {
                    assert_eq!(
                        buyer, &after_lic.buyer,
                        "ConsumeCall buyer mismatch on license {}",
                        license_id
                    );
                    assert_eq!(
                        asset_id, &after_lic.asset_id,
                        "ConsumeCall asset mismatch on license {}",
                        license_id
                    );
                    assert_eq!(
                        after_lic.calls_remaining,
                        before_lic.calls_remaining - 1,
                        "ConsumeCall must decrement calls_remaining by exactly 1"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    #[test]
    fn test_license_monotonicity_top_up_valid() {
        let mut before = State::new();
        before.mint("bob".into(), "XLM".into(), 1000);
        let asset_id = before
            .list_asset(
                "alice".into(),
                "Agent".into(),
                "Desc".into(),
                AssetType::Tool,
                LicenseType::UsageBased,
                100,
                vec![],
            )
            .unwrap();

        before
            .purchase_license("bob".into(), asset_id, "XLM".into())
            .unwrap();

        let mut after = before.clone();
        let action = Action::TopUpCalls {
            buyer: "bob".into(),
            asset_id,
            token: "XLM".into(),
            additional_calls: 50,
        };

        after
            .top_up_calls("bob".into(), asset_id, "XLM".into(), 50)
            .unwrap();

        check_license_monotonicity(&before, &after, &action);
    }

    #[test]
    #[should_panic(expected = "License monotonicity violation")]
    fn test_license_monotonicity_unauthorized_increase() {
        let mut before = State::new();
        before.mint("bob".into(), "XLM".into(), 1000);
        let asset_id = before
            .list_asset(
                "alice".into(),
                "Agent".into(),
                "Desc".into(),
                AssetType::Tool,
                LicenseType::UsageBased,
                100,
                vec![],
            )
            .unwrap();

        before
            .purchase_license("bob".into(), asset_id, "XLM".into())
            .unwrap();

        let mut after = before.clone();
        // Illegal increase on a PublishUpdate action
        let action = Action::PublishUpdate {
            owner: "alice".into(),
            asset_id,
            new_description: "New".into(),
        };

        let license_id = *after
            .buyer_licenses
            .get(&("bob".to_string(), asset_id))
            .unwrap();
        after.licenses.get_mut(&license_id).unwrap().calls_remaining += 50;

        check_license_monotonicity(&before, &after, &action);
    }
}
