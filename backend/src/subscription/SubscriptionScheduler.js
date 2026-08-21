const cron = require('node-cron');
const RenewalNotifier = require('./RenewalNotifier');

class SubscriptionScheduler {
    static start() {
        // Run every 10 minutes
        cron.schedule('*/10 * * * *', async () => {
            console.log('Running SubscriptionScheduler...');
            // In a real app, query DB for subscriptions expiring in <= 72 hrs
            // For now, this is a skeleton
            const expiringSubs = [];
            for (const sub of expiringSubs) {
                RenewalNotifier.queueReminder(sub);
            }
        });
    }
}

module.exports = SubscriptionScheduler;
