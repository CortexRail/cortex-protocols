/**
 * The relationship graph the fraud detectors reason over.
 *
 * Three independent edge sources are unioned into one undirected graph:
 *
 *   streams  — sender → recipient (who pays whom for a stream)
 *   licenses — buyer → asset owner (who bought from whom)
 *   usage    — caller → counterparty (who actually consumed whose asset)
 *
 * SybilGraphDetector partitions this graph into connected components looking
 * for rings; WashUsageDetector walks it outward from an asset owner to decide
 * which addresses are "close" to that owner. Both share this module so a
 * cluster means the same thing to each of them.
 *
 * Pure functions over plain rows — no database access, so the detectors and
 * their unit tests can build graphs from fixtures.
 */

/** Union-Find with path compression, for connected components. */
class UnionFind {
  constructor() {
    this.parent = new Map();
    this.size = new Map();
  }

  add(node) {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
      this.size.set(node, 1);
    }
    return node;
  }

  find(node) {
    this.add(node);
    let root = node;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root);
    }
    // Path compression: point everything on the way up straight at the root.
    let cursor = node;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return rootA;

    // Union by size keeps the trees shallow.
    const [big, small] =
      this.size.get(rootA) >= this.size.get(rootB) ? [rootA, rootB] : [rootB, rootA];

    this.parent.set(small, big);
    this.size.set(big, this.size.get(big) + this.size.get(small));
    return big;
  }
}

/** Undirected edge key — the same pair in either order maps to one edge. */
function edgeKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Edge rows arrive from three repositories with slightly different column
 * names; normalize them to { from, to, count, value, firstSeen, lastSeen }.
 */
function normalizeEdge(edge) {
  return {
    from: edge.from,
    to: edge.to,
    count: Number(edge.relations ?? edge.calls ?? 1) || 0,
    value: Number(edge.value ?? edge.revenue ?? 0) || 0,
    firstSeen: edge.firstSeen ?? null,
    lastSeen: edge.lastSeen ?? null,
  };
}

function minDefined(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

function maxDefined(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Build the merged graph.
 *
 * @param {object} sources
 * @param {Array} [sources.streams] - streamRepository.edgesInWindow rows
 * @param {Array} [sources.licenses] - licenseRepository.edgesInWindow rows
 * @param {Array} [sources.usage] - usageEventRepository.edgesInWindow rows
 * @returns {{
 *   nodes: Map<string, {address: string, degree: number, count: number, value: number}>,
 *   edges: Map<string, object>,
 *   adjacency: Map<string, Set<string>>,
 *   components: Array<{members: string[], edges: object[], size: number, density: number}>,
 *   componentOf: Map<string, number>
 * }}
 */
function buildGraph({ streams = [], licenses = [], usage = [] } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const adjacency = new Map();
  const uf = new UnionFind();

  const touchNode = (address) => {
    if (!nodes.has(address)) {
      nodes.set(address, { address, degree: 0, count: 0, value: 0 });
      adjacency.set(address, new Set());
    }
    return nodes.get(address);
  };

  const ingest = (rows, source) => {
    for (const raw of rows) {
      const edge = normalizeEdge(raw);
      // A self-loop carries no relationship; wash detection handles those.
      if (!edge.from || !edge.to || edge.from === edge.to) continue;

      touchNode(edge.from);
      touchNode(edge.to);

      const key = edgeKey(edge.from, edge.to);
      const existing = edges.get(key);

      if (existing) {
        existing.count += edge.count;
        existing.value += edge.value;
        existing.firstSeen = minDefined(existing.firstSeen, edge.firstSeen);
        existing.lastSeen = maxDefined(existing.lastSeen, edge.lastSeen);
        if (!existing.sources.includes(source)) existing.sources.push(source);
      } else {
        edges.set(key, {
          from: edge.from,
          to: edge.to,
          count: edge.count,
          value: edge.value,
          firstSeen: edge.firstSeen,
          lastSeen: edge.lastSeen,
          sources: [source],
        });
        adjacency.get(edge.from).add(edge.to);
        adjacency.get(edge.to).add(edge.from);
      }

      uf.union(edge.from, edge.to);
    }
  };

  ingest(streams, "stream");
  ingest(licenses, "license");
  ingest(usage, "usage");

  // Recompute per-node totals from the merged edge set so parallel edges from
  // different sources are counted once.
  for (const edge of edges.values()) {
    for (const address of [edge.from, edge.to]) {
      const node = nodes.get(address);
      node.degree += 1;
      node.count += edge.count;
      node.value += edge.value;
    }
  }

  // Group nodes and edges by connected component.
  const byRoot = new Map();
  for (const address of nodes.keys()) {
    const root = uf.find(address);
    if (!byRoot.has(root)) byRoot.set(root, { members: [], edges: [] });
    byRoot.get(root).members.push(address);
  }
  for (const edge of edges.values()) {
    byRoot.get(uf.find(edge.from)).edges.push(edge);
  }

  const components = [];
  const componentOf = new Map();
  for (const group of byRoot.values()) {
    const size = group.members.length;
    const possibleEdges = (size * (size - 1)) / 2;
    const index = components.length;

    components.push({
      members: group.members.slice().sort(),
      edges: group.edges,
      size,
      density: possibleEdges > 0 ? group.edges.length / possibleEdges : 0,
    });

    for (const address of group.members) componentOf.set(address, index);
  }

  // Biggest first: the interesting rings are rarely the giant organic blob,
  // but callers usually want a stable, meaningful order.
  components.sort((a, b) => b.size - a.size || a.members[0].localeCompare(b.members[0]));
  componentOf.clear();
  components.forEach((component, index) => {
    for (const address of component.members) componentOf.set(address, index);
  });

  return { nodes, edges, adjacency, components, componentOf };
}

/**
 * A component trimmed to at most `maxNodes` addresses, for embedding in a
 * signal's evidence without bloating the row. Highest-degree members are kept
 * because they are what a reviewer looks at first.
 */
function subgraphFor(graph, component, maxNodes = 60) {
  const ranked = component.members
    .slice()
    .sort((a, b) => (graph.nodes.get(b)?.degree || 0) - (graph.nodes.get(a)?.degree || 0));

  const kept = new Set(ranked.slice(0, maxNodes));

  return {
    nodes: [...kept].map((address) => ({
      address,
      degree: graph.nodes.get(address)?.degree || 0,
      count: graph.nodes.get(address)?.count || 0,
    })),
    edges: component.edges
      .filter((edge) => kept.has(edge.from) && kept.has(edge.to))
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        count: edge.count,
        sources: edge.sources,
      })),
    truncated: component.members.length > kept.size,
    totalMembers: component.members.length,
  };
}

module.exports = {
  UnionFind,
  buildGraph,
  subgraphFor,
  edgeKey,
};
