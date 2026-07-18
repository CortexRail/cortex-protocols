// =============================================================================
// Cortex Protocol — Alerting Module
// Sends a webhook notification if a contract becomes unreachable for >3
// consecutive checks. Supports Discord, Slack, and generic webhooks.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import type { ContractHealth, AlertEvent } from "../deploy/src/types.js";

// ── Configuration ──────────────────────────────────────────────────────────────

const WEBHOOK_URL = process.env["ALERT_WEBHOOK_URL"] ?? "";
const ALERT_LOG_FILE = path.resolve(process.cwd(), "alert_log.jsonl");
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

// Cooldown: don't re-alert the same contract within this window (ms)
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// Track last alert time per contract
const lastAlertTime: Record<string, number> = {};

// ── Payload Builders ───────────────────────────────────────────────────────────

function buildDiscordPayload(event: AlertEvent): Record<string, unknown> {
  return {
    username: "Cortex Protocol Monitor",
    avatar_url: "https://avatars.githubusercontent.com/u/1",
    embeds: [
      {
        title: "🚨 Contract Unreachable",
        color: 0xff0000,
        fields: [
          { name: "Contract", value: event.contractName, inline: true },
          { name: "Network", value: process.env["STELLAR_NETWORK"] ?? "testnet", inline: true },
          { name: "Consecutive Failures", value: String(event.consecutiveFailures), inline: true },
          { name: "Address", value: `\`${event.contractAddress}\``, inline: false },
          { name: "Last Error", value: `\`\`\`${event.lastError.slice(0, 500)}\`\`\``, inline: false },
        ],
        footer: { text: "Cortex Protocol Monitoring" },
        timestamp: event.triggeredAt,
      },
    ],
  };
}

function buildSlackPayload(event: AlertEvent): Record<string, unknown> {
  return {
    text: `🚨 *Cortex Protocol Alert* — ${event.contractName} is unreachable!`,
    attachments: [
      {
        color: "danger",
        fields: [
          { title: "Contract", value: event.contractName, short: true },
          { title: "Address", value: event.contractAddress, short: false },
          { title: "Consecutive Failures", value: String(event.consecutiveFailures), short: true },
          { title: "Last Error", value: event.lastError.slice(0, 300), short: false },
        ],
        footer: "Cortex Protocol Monitor",
        ts: Math.floor(new Date(event.triggeredAt).getTime() / 1000),
      },
    ],
  };
}

function buildGenericPayload(event: AlertEvent): Record<string, unknown> {
  return {
    type: "cortex_protocol_alert",
    severity: "critical",
    ...event,
  };
}

// ── Detect Webhook Type ────────────────────────────────────────────────────────

function detectWebhookType(url: string): "discord" | "slack" | "generic" {
  if (url.includes("discord.com/api/webhooks")) return "discord";
  if (url.includes("hooks.slack.com")) return "slack";
  return "generic";
}

// ── Send Webhook ───────────────────────────────────────────────────────────────

async function sendWebhook(event: AlertEvent): Promise<void> {
  if (!WEBHOOK_URL) {
    console.warn("[ALERT] ALERT_WEBHOOK_URL not set — skipping webhook");
    return;
  }

  const webhookType = detectWebhookType(WEBHOOK_URL);
  let payload: Record<string, unknown>;

  switch (webhookType) {
    case "discord":
      payload = buildDiscordPayload(event);
      break;
    case "slack":
      payload = buildSlackPayload(event);
      break;
    default:
      payload = buildGenericPayload(event);
  }

  const body = JSON.stringify(payload);

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    console.log(
      `[ALERT] ✓ Webhook sent (${webhookType}) for ${event.contractName}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ALERT] ✗ Webhook failed for ${event.contractName}: ${msg}`);
    throw err;
  }
}

// ── Log Alert ──────────────────────────────────────────────────────────────────

function logAlert(event: AlertEvent): void {
  const line = JSON.stringify(event) + "\n";
  try {
    fs.appendFileSync(ALERT_LOG_FILE, line);
  } catch (err) {
    console.error("[ALERT] Failed to write alert log:", err);
  }
}

// ── Main Export: Handle Failure ────────────────────────────────────────────────

export async function handleFailure(health: ContractHealth): Promise<void> {
  // Only trigger above threshold
  if (health.consecutiveFailures < CONSECUTIVE_FAILURE_THRESHOLD) return;

  // Enforce cooldown
  const now = Date.now();
  const lastAlert = lastAlertTime[health.name] ?? 0;
  if (now - lastAlert < ALERT_COOLDOWN_MS) {
    console.log(
      `[ALERT] Cooldown active for ${health.name} — skipping (next alert in ${
        Math.ceil((ALERT_COOLDOWN_MS - (now - lastAlert)) / 60_000)
      }min)`
    );
    return;
  }

  const event: AlertEvent = {
    contractName: health.name,
    contractAddress: health.address,
    consecutiveFailures: health.consecutiveFailures,
    lastError: health.lastError ?? "Unknown error",
    triggeredAt: new Date().toISOString(),
    webhookUrl: WEBHOOK_URL || "(not configured)",
  };

  console.log(
    `[ALERT] 🚨 ${health.name} unreachable for ${health.consecutiveFailures} consecutive checks!`
  );

  logAlert(event);

  try {
    await sendWebhook(event);
    lastAlertTime[health.name] = now;
  } catch {
    // Already logged in sendWebhook
  }
}

// ── Recovery Notification ─────────────────────────────────────────────────────

export async function handleRecovery(health: ContractHealth): Promise<void> {
  if (!WEBHOOK_URL) return;

  const webhookType = detectWebhookType(WEBHOOK_URL);
  const recoveryEvent = {
    type: "cortex_protocol_recovery",
    contractName: health.name,
    contractAddress: health.address,
    recoveredAt: new Date().toISOString(),
    responseTimeMs: health.responseTimeMs,
  };

  let payload: Record<string, unknown>;
  if (webhookType === "discord") {
    payload = {
      username: "Cortex Protocol Monitor",
      embeds: [
        {
          title: "✅ Contract Recovered",
          color: 0x00ff00,
          fields: [
            { name: "Contract", value: health.name, inline: true },
            { name: "Response Time", value: `${health.responseTimeMs}ms`, inline: true },
            { name: "Address", value: `\`${health.address}\``, inline: false },
          ],
          timestamp: recoveryEvent.recoveredAt,
        },
      ],
    };
  } else if (webhookType === "slack") {
    payload = {
      text: `✅ *${health.name}* has recovered (${health.responseTimeMs}ms)`,
      attachments: [{ color: "good", text: health.address }],
    };
  } else {
    payload = recoveryEvent;
  }

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log(`[ALERT] ✓ Recovery notification sent for ${health.name}`);
  } catch (err) {
    console.error("[ALERT] Recovery notification failed:", err);
  }
}

// ── Test Alert (for debugging) ────────────────────────────────────────────────

export async function sendTestAlert(contractName = "marketplace"): Promise<void> {
  const testHealth: ContractHealth = {
    name: contractName,
    address: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    status: "unreachable",
    lastChecked: new Date().toISOString(),
    responseTimeMs: null,
    consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD,
    lastError: "TEST ALERT — connection refused (simulated)",
  };

  // Bypass cooldown for test
  delete lastAlertTime[contractName];
  await handleFailure(testHealth);
}
