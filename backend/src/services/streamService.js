/**
 * Stream indexing service — tracks on-chain payment streams off-chain
 * for fast querying without needing to hit the RPC on every request.
 */

const streamsIndex = new Map();

const STREAM_STATUSES = ["Active", "Paused", "Completed", "Cancelled"];

function indexStream(streamData) {
  const stream = {
    ...streamData,
    status: streamData.status || "Active",
    withdrawn: streamData.withdrawn || 0,
    indexedAt: Date.now(),
  };
  streamsIndex.set(String(stream.id), stream);
  return stream;
}

function updateStreamStatus(id, status) {
  const stream = streamsIndex.get(String(id));
  if (!stream) return null;
  stream.status = status;
  stream.updatedAt = Date.now();
  streamsIndex.set(String(id), stream);
  return stream;
}

function getStream(id) {
  return streamsIndex.get(String(id)) || null;
}

function listStreams({ sender, recipient, status, page = 1, limit = 20 } = {}) {
  let results = Array.from(streamsIndex.values());

  if (sender) results = results.filter((s) => s.sender === sender);
  if (recipient) results = results.filter((s) => s.recipient === recipient);
  if (status) results = results.filter((s) => s.status === status);

  const total = results.length;
  const offset = (page - 1) * limit;
  return {
    data: results.slice(offset, offset + limit),
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

module.exports = { indexStream, updateStreamStatus, getStream, listStreams, STREAM_STATUSES };
