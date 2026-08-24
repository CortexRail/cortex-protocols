#![no_main]

use contract_fuzz::{
    check_asset_ownership, check_escrow_conservation, check_license_monotonicity,
    check_reputation_bounds, Action, State,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|actions: Vec<Action>| {
    let mut state = State::new();

    for action in actions {
        let before = state.clone();

        // Apply action to state (mutations or rejected operations)
        let _ = action.apply(&mut state);

        // Assert all protocol invariants hold across the transition
        check_escrow_conservation(&state);
        check_license_monotonicity(&before, &state, &action);
        check_reputation_bounds(&state);
        check_asset_ownership(&before, &state, &action);
    }
});
