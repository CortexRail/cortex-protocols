# Cortex Agent Payment SDK

The client SDK enables autonomous agents to discover assets, negotiate rates, open payment streams, make metered calls, and close streams programmatically.

## Installation

```bash
npm install cortex-protocols-sdk
```

## Initialization

```javascript
const CortexAgentSDK = require('./CortexAgentSDK');
const { Keypair } = require('@stellar/stellar-sdk');

const sdk = new CortexAgentSDK({
  backendUrl: 'http://localhost:4000',
  buyerKeypair: Keypair.fromSecret('S...'),
  micropaymentsContractId: 'CCMICROPAY...',
});
```

---

## Worked Examples

### 1. Asset Discovery
Find intelligence assets by type and capability filtering:
```javascript
const response = await sdk.discover({
  assetType: 'Prompt',
  limit: 10
});
console.log('Discovered assets:', response.data);
```

### 2. Fetch Signed Quote
Acquire an HMAC-SHA256 signed price quote from the seller server:
```javascript
const quote = await sdk.getQuote(1);
console.log('Price quote:', quote.price);
```

### 3. Basic Stream Opening
Execute the full programmatic handshake, rate negotiation, on-chain stream opening, and JWT token retrieval flow:
```javascript
const { streamId, streamToken } = await sdk.openStream(
  1,        // assetId
  10.0,     // 10.0 XLM deposit
  12        // 12 hours duration
);
console.log(`Stream opened with ID ${streamId}`);
```

### 4. Make a Metered API Call
Send a metered request using the JWT token and handle usage limits:
```javascript
try {
  const result = await sdk.call(streamToken, {
    query: 'Translate text from English to French'
  });
  console.log(`Calls remaining: ${result.calls_remaining}`);
} catch (err) {
  console.error('Call failed:', err.message);
}
```

### 5. Check Claimable Stream Balance
Query the current claimable balance remaining in the payment stream:
```javascript
const balance = await sdk.getBalance(streamId);
console.log(`Current claimable balance: ${balance} stroops`);
```

### 6. Close Stream Early
Close the stream and refund the remaining unearned deposit back to the sender's wallet:
```javascript
const closeResult = await sdk.closeStream(streamId);
console.log('Stream closed successfully. Tx Hash:', closeResult.txHash);
```

### 7. Discovery with Free Search String
Discover assets with customized search text:
```javascript
const searchResult = await sdk.discover({
  search: 'sentiment classifier',
  limit: 5
});
console.log('Matches:', searchResult.data);
```

### 8. Subscribing to Stream Alerts (SSE)
Subscribe to low-balance event alerts:
```javascript
const EventSource = require('eventsource');
const es = new EventSource('http://localhost:4000/api/v1/protocol/events/subscribe');

es.addEventListener('LOW_BALANCE', (event) => {
  const data = JSON.parse(event.data);
  console.warn(`Warning: Stream ${data.streamId} has only ${data.callsRemaining} calls left!`);
});
```

### 9. Custom Rate Proposal
Propose custom rates to negotiate:
```javascript
// Rate negotiation is automated under openStream. 
// Handled off-chain by StreamNegotiator matching proposedRate to asset list price.
const customResult = await sdk.openStream(1, 20.0, 24);
console.log('Opened with custom rate stream token:', customResult.streamToken);
```

### 10. Bulk Manual Settlement
Trigger manual settlement early for a specific stream:
```javascript
const fetch = require('node-fetch');
const settleRes = await fetch(`http://localhost:4000/api/v1/protocol/stream/${streamId}/settle`, {
  method: 'POST'
});
const data = await settleRes.json();
console.log('Manual settlement complete. Settled:', data.settledAmount);
```
