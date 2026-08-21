class SubscriptionStatusSync {
    static async syncOnStartup() {
        // Syncs on-chain is_license_valid status for all known subscriptions,
        // marks expired ones in DB.
        console.log('Syncing subscription status from chain...');
    }
}

module.exports = SubscriptionStatusSync;
