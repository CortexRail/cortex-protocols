// Store active SSE response streams
const sseClients = new Set();

/**
 * Handle new SSE connection from a client.
 */
function registerClient(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  res.write("data: {\"status\":\"connected\"}\n\n");

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
}

/**
 * Check if the stream has less than or equal to 10% of calls remaining.
 * Emits a LOW_BALANCE event to all listening clients if true.
 */
function checkStreamAndAlert(stream) {
  const totalCalls = stream.callsRemaining + stream.callsUsed;
  if (totalCalls <= 0) return;

  const ratio = stream.callsRemaining / totalCalls;
  if (ratio <= 0.1) {
    const eventPayload = {
      event: "LOW_BALANCE",
      streamId: Number(stream.id),
      sender: stream.sender,
      callsRemaining: Number(stream.callsRemaining),
      percentRemaining: Math.round(ratio * 100),
    };

    const message = `event: LOW_BALANCE\ndata: ${JSON.stringify(eventPayload)}\n\n`;

    for (const client of sseClients) {
      try {
        client.write(message);
      } catch (_err) {
        sseClients.delete(client);
      }
    }
  }
}

module.exports = {
  registerClient,
  checkStreamAndAlert,
  _sseClients: sseClients,
};
