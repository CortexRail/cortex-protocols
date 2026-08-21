const express = require('express');
const router = express.Router();
const RenewalNotifier = require('../subscription/RenewalNotifier');

router.get('/:buyerKey', async (req, res) => {
    // All subscriptions for a wallet
    res.json({ subscriptions: [] });
});

router.get('/:buyerKey/expiring', async (req, res) => {
    // Subscriptions expiring in the next 7 days
    res.json({ subscriptions: [] });
});

router.get('/:buyerKey/:assetId', async (req, res) => {
    // Single subscription detail
    res.json({ subscription: null });
});

router.post('/:assetId/build-renew', async (req, res) => {
    // Returns unsigned renewal XDR
    res.json({ xdr: 'unsigned_renew_xdr' });
});

router.post('/:assetId/build-subscribe', async (req, res) => {
    // Returns unsigned subscribe XDR
    res.json({ xdr: 'unsigned_subscribe_xdr' });
});

// SSE endpoint
router.get('/events/stream', (req, res) => {
    RenewalNotifier.getStream(req, res);
});

module.exports = router;
