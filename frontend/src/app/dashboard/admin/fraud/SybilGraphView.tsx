"use client";

/**
 * Force-directed view of a flagged sybil cluster.
 *
 * The simulation is hand-rolled rather than pulled from d3-force: the whole
 * layout is ~60 lines of physics and the graphs it draws are capped at
 * `maxSubgraphNodes` (60) by the API, so the O(n²) repulsion is cheap and the
 * dependency would cost more than it saves.
 *
 * Nodes start on a circle in a deterministic order, so the same cluster always
 * settles into a recognisable shape and the tests are not racing an animation.
 * Under `prefers-reduced-motion` the circle IS the layout — no ticks run.
 *
 * Colours come from Tailwind fill and stroke utilities rather than SVG
 * presentation attributes: an attribute cannot carry the `dark:` variant, so
 * the graph would stay dark-themed on a light page. The focus highlight is
 * purple-500, which is `--accent` and identical in both themes.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface GraphNode {
  address: string;
  degree: number;
  count: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
  sources: string[];
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  totalMembers: number;
}

interface Props {
  subgraph: Subgraph | null;
  /** The address the operator navigated to; drawn highlighted. */
  focusAddress?: string;
  width?: number;
  height?: number;
}

interface Positioned {
  address: string;
  degree: number;
  count: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const REPULSION = 9_000;
const SPRING = 0.006;
const SPRING_LENGTH = 90;
const CENTERING = 0.012;
const DAMPING = 0.86;
const MAX_TICKS = 260;
/** Below this total kinetic energy the layout has settled; stop burning frames. */
const SETTLED_ENERGY = 0.35;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Deterministic starting ring, ordered by degree so hubs land opposite each other. */
function initialLayout(nodes: GraphNode[], width: number, height: number): Positioned[] {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.36;

  return nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1);
    return {
      ...node,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      vx: 0,
      vy: 0,
    };
  });
}

function step(nodes: Positioned[], edges: GraphEdge[], width: number, height: number): number {
  const index = new Map(nodes.map((node, i) => [node.address, i]));
  const cx = width / 2;
  const cy = height / 2;

  // Every pair pushes apart, so unrelated nodes do not pile up.
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distanceSq = dx * dx + dy * dy;

      // Two nodes exactly on top of each other have no direction to separate
      // along; nudge them apart deterministically instead of dividing by zero.
      if (distanceSq < 1) {
        dx = (i - j) || 1;
        dy = 1;
        distanceSq = dx * dx + dy * dy;
      }

      const force = REPULSION / distanceSq;
      const distance = Math.sqrt(distanceSq);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;

      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Edges pull their endpoints toward a resting length.
  for (const edge of edges) {
    const i = index.get(edge.from);
    const j = index.get(edge.to);
    if (i === undefined || j === undefined) continue;

    const a = nodes[i];
    const b = nodes[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (distance - SPRING_LENGTH) * SPRING;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;

    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  let energy = 0;
  for (const node of nodes) {
    node.vx = (node.vx + (cx - node.x) * CENTERING) * DAMPING;
    node.vy = (node.vy + (cy - node.y) * CENTERING) * DAMPING;
    node.x += node.vx;
    node.y += node.vy;

    // Keep everything inside the viewBox rather than letting it drift off-canvas.
    node.x = Math.max(24, Math.min(width - 24, node.x));
    node.y = Math.max(24, Math.min(height - 24, node.y));

    energy += Math.abs(node.vx) + Math.abs(node.vy);
  }
  return energy;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export default function SybilGraphView({
  subgraph,
  focusAddress,
  width = 720,
  height = 420,
}: Props) {
  const seed = useMemo(
    () => initialLayout(subgraph?.nodes ?? [], width, height),
    [subgraph, width, height]
  );

  const [nodes, setNodes] = useState<Positioned[]>(seed);
  const [renderedSeed, setRenderedSeed] = useState(seed);
  const frame = useRef<number | null>(null);

  // Adjusting state during render is React's documented way to react to a
  // changed prop. Doing it in an effect instead would paint one empty frame
  // first and trip the cascading-render lint; reading a ref during render is
  // not allowed at all under this version's rules.
  if (renderedSeed !== seed) {
    setRenderedSeed(seed);
    setNodes(seed);
  }

  useEffect(() => {
    if (!subgraph || seed.length === 0 || prefersReducedMotion()) return;

    // A private copy the simulation may mutate in place; React state never is.
    const working = seed.map((node) => ({ ...node }));
    let ticks = 0;

    const run = () => {
      const energy = step(working, subgraph.edges, width, height);
      ticks += 1;
      // setState from an animation callback, not synchronously from the
      // effect body — the distinction the cascading-render rule cares about.
      setNodes(working.map((node) => ({ ...node })));

      if (ticks < MAX_TICKS && energy > SETTLED_ENERGY) {
        frame.current = requestAnimationFrame(run);
      }
    };
    frame.current = requestAnimationFrame(run);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [seed, subgraph, width, height]);

  if (!subgraph || subgraph.nodes.length === 0) {
    return (
      <div
        data-testid="sybil-graph-empty"
        className="flex items-center justify-center h-48 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg text-sm text-[var(--muted)]"
      >
        No relationship edges for this address in the current window.
      </div>
    );
  }

  const byAddress = new Map(nodes.map((node) => [node.address, node]));
  const maxDegree = Math.max(...subgraph.nodes.map((n) => n.degree), 1);

  return (
    <div className="bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Cluster graph</h3>
        <p className="text-xs text-[var(--muted)]">
          {subgraph.totalMembers} address{subgraph.totalMembers === 1 ? "" : "es"}
          {subgraph.truncated && `, showing the ${subgraph.nodes.length} most connected`}
        </p>
      </div>

      <svg
        data-testid="sybil-graph"
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Relationship graph of ${subgraph.totalMembers} addresses`}
      >
        {subgraph.edges.map((edge) => {
          const a = byAddress.get(edge.from);
          const b = byAddress.get(edge.to);
          if (!a || !b) return null;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              data-testid="graph-edge"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className="stroke-zinc-400 dark:stroke-zinc-600"
              strokeWidth={Math.min(1 + edge.count / 4, 4)}
              strokeOpacity={0.7}
            />
          );
        })}

        {nodes.map((node) => {
          const focused = node.address === focusAddress;
          const radius = 8 + (node.degree / maxDegree) * 10;
          return (
            <g key={node.address} data-testid="graph-node">
              <circle
                cx={node.x}
                cy={node.y}
                r={radius}
                className={
                  focused
                    ? "fill-purple-500 stroke-purple-700 dark:stroke-purple-200"
                    : "fill-zinc-300 stroke-zinc-400 dark:fill-zinc-700 dark:stroke-zinc-500"
                }
                strokeWidth={focused ? 2.5 : 1}
              />
              <title>{`${node.address} — ${node.degree} connections, ${node.count} interactions`}</title>
              <text
                x={node.x}
                y={node.y + radius + 12}
                textAnchor="middle"
                className="fill-zinc-600 dark:fill-zinc-400"
                fontSize={10}
                fontFamily="monospace"
              >
                {shortAddress(node.address)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
