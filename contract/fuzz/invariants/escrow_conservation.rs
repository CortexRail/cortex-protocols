//! Invariant: Escrow Conservation.
//!
//! Asserts that value is strictly conserved across all stream deposits,
//! active stream locks, escrow holds, and account balances. Value must
//! never be created or destroyed.

use super::model::{EscrowStatus, State, StreamStatus, TokenId};

/// Check that the escrow and stream locks in `state` are internally consistent
/// and that no locked funds or balances are negative or corrupt.
pub fn check_escrow_conservation(state: &State) {
    let mut total_locked: i128 = 0;

    // 1. Verify stream locked amounts and consistency
    for (stream_id, stream) in &state.streams {
        assert!(
            stream.deposit >= 0,
            "Stream {} deposit cannot be negative: {}",
            stream_id,
            stream.deposit
        );
        assert!(
            stream.withdrawn >= 0,
            "Stream {} withdrawn amount cannot be negative: {}",
            stream_id,
            stream.withdrawn
        );
        assert!(
            stream.withdrawn <= stream.deposit,
            "Stream {} withdrawn ({}) exceeds deposit ({})",
            stream_id,
            stream.withdrawn,
            stream.deposit
        );

        match stream.status {
            StreamStatus::Active | StreamStatus::Paused => {
                let expected_locked = stream.deposit - stream.withdrawn;
                assert_eq!(
                    stream.locked_amount, expected_locked,
                    "Stream {} locked_amount ({}) must strictly equal deposit minus withdrawn ({})",
                    stream_id, stream.locked_amount, expected_locked
                );
            }
            StreamStatus::Completed | StreamStatus::Cancelled => {
                assert_eq!(
                    stream.locked_amount, 0,
                    "Closed stream {} must have zero locked_amount, found {}",
                    stream_id, stream.locked_amount
                );
            }
        }

        total_locked = total_locked
            .checked_add(stream.locked_amount)
            .expect("Total locked stream funds overflowed");
    }

    assert!(
        total_locked >= 0,
        "Total stream locked balance cannot be negative"
    );

    // 2. Verify purchase escrow holds
    let mut total_escrow_held: i128 = 0;
    for (license_id, escrow) in &state.escrows {
        assert!(
            escrow.amount >= 0,
            "Escrow {} amount cannot be negative: {}",
            license_id,
            escrow.amount
        );

        if escrow.status == EscrowStatus::Held {
            total_escrow_held = total_escrow_held
                .checked_add(escrow.amount)
                .expect("Total escrow hold amount overflowed");
        }
    }

    assert!(
        total_escrow_held >= 0,
        "Total escrow hold balance cannot be negative"
    );

    // 3. Verify user account balances are non-negative
    for ((account, token), balance) in &state.balances {
        assert!(
            *balance >= 0,
            "Account {} balance for token {} is negative ({})",
            account,
            token,
            balance
        );
    }
}

/// Assert that the total system value for a given token (account balances +
/// locked stream funds + held purchase escrows) is strictly conserved across
/// a state transition from `before` to `after`.
pub fn check_token_value_conservation(before: &State, after: &State, token: &TokenId) {
    let sum_state_token_value = |s: &State| -> i128 {
        let user_balances: i128 = s
            .balances
            .iter()
            .filter(|((_, t), _)| t == token)
            .map(|(_, b)| *b)
            .sum();

        let stream_locked: i128 = s
            .streams
            .values()
            .filter(|st| &st.token == token)
            .map(|st| st.locked_amount)
            .sum();

        let escrow_held: i128 = s
            .escrows
            .values()
            .filter(|e| &e.token == token && e.status == EscrowStatus::Held)
            .map(|e| e.amount)
            .sum();

        user_balances
            .checked_add(stream_locked)
            .and_then(|val| val.checked_add(escrow_held))
            .expect("Token total value overflowed")
    };

    let total_before = sum_state_token_value(before);
    let total_after = sum_state_token_value(after);

    assert_eq!(
        total_before, total_after,
        "Escrow conservation violation: total value for token '{}' changed from {} to {}",
        token, total_before, total_after
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    #[test]
    fn test_escrow_conservation_valid() {
        let mut state = State::new();
        let token = "XLM".to_string();
        state.mint("alice".into(), token.clone(), 1000);

        check_escrow_conservation(&state);

        let stream_id = state
            .open_stream("alice".into(), "bob".into(), token.clone(), 400, 10, 40)
            .unwrap();

        check_escrow_conservation(&state);
        assert_eq!(state.get_balance(&"alice".into(), &token), 600);
        assert_eq!(state.get_stream(stream_id).unwrap().locked_amount, 400);

        state.timestamp += 10;
        state.withdraw_stream("bob".into(), stream_id).unwrap();
        check_escrow_conservation(&state);
        assert_eq!(state.get_balance(&"bob".into(), &token), 100);
        assert_eq!(state.get_stream(stream_id).unwrap().locked_amount, 300);
    }

    #[test]
    #[should_panic(expected = "locked_amount")]
    fn test_escrow_conservation_corrupt_locked_amount() {
        let mut state = State::new();
        let token = "XLM".to_string();
        state.mint("alice".into(), token.clone(), 1000);

        let stream_id = state
            .open_stream("alice".into(), "bob".into(), token, 400, 10, 40)
            .unwrap();

        // Corrupt stream locked_amount
        if let Some(stream) = state.streams.get_mut(&stream_id) {
            stream.locked_amount += 50; // Invariant violation: phantom value created
        }

        check_escrow_conservation(&state);
    }
}
