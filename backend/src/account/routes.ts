// Account routes (M4): profile, new channels, feedback, usage, memory and push devices.
// Every route sits behind the session middleware (createApp registers modules after it).
import type { RegisterRoutes } from "../app.ts";
import { createChannel } from "../routes/channels.ts";
import { updateMe } from "../routes/me.ts";
import type { ModelLabels } from "../usage/stats.ts";
import { deleteDevice, registerDevice } from "./devices.ts";
import { sendFeedback } from "./feedback.ts";
import { getMemory, putMemory } from "./memory.ts";
import { fullReset, getUsage, getUsageStats } from "./usage.ts";

/**
 * Handlers read db / events / usage / runs from the app deps. `labels` names models in the Usage
 * panel (models.json labels); without it a model shows its id.
 */
export function registerAccountRoutes(opts: { labels?: ModelLabels } = {}): RegisterRoutes {
  const labels: ModelLabels = opts.labels ?? (() => null);
  return (app) => {
    app.patch("/api/me", updateMe);
    app.post("/api/channels", createChannel);
    app.post("/api/feedback", sendFeedback);
    app.get("/api/usage", getUsage);
    app.get("/api/usage/stats", getUsageStats(labels));
    app.post("/api/usage/full-reset", fullReset);
    app.get("/api/memory", getMemory);
    app.put("/api/memory", putMemory);
    app.post("/api/devices", registerDevice);
    app.delete("/api/devices/:id", deleteDevice);
  };
}
