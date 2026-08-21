const EventEmitter = require('events');

class RenewalNotifier extends EventEmitter {
    constructor() {
        super();
        this.notifications = [];
    }

    queueReminder(subscription) {
        // Logic to determine if it's 7-day, 24-hour, expiry, or grace period
        this.emit('RENEWAL_REMINDER', subscription);
    }

    notify(topic, data) {
        const notif = { topic, data, timestamp: Date.now() };
        this.notifications.push(notif);
        this.emit(topic, notif);
    }

    getStream(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        const topics = (req.query.topics || '').split(',');

        const listener = (event, data) => {
            if (topics.includes(event)) {
                res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
            }
        };

        this.on('any', listener); // Assume an 'any' event or specific topics

        req.on('close', () => {
            this.off('any', listener);
        });
    }
}

module.exports = new RenewalNotifier();
