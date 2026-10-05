import { processTransportJobs } from "../src/lib/transport/worker";
import { processDueJobs } from "../src/lib/automation/engine";
import { POST as maintenance } from "../src/app/api/cron/process-jobs/route";
import { getEnv } from "../src/lib/env";
import { processPublicationJobs } from "../src/lib/publishing/worker";
import { processInsightsJobs } from "../src/lib/insights/worker";

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function transportLoop() {
  while (!stopping) {
    let claimed = 0;
    try {
      claimed = await processTransportJobs(16);
    } catch {
      console.error(
        JSON.stringify({ scope: "worker", error: "transport_unavailable" }),
      );
    }
    if (!stopping) await sleep(claimed ? 100 : 2000);
  }
}
async function legacyLoop() {
  let nextMaintenance = 0;
  while (!stopping) {
    try {
      await processDueJobs(1);
      if (Date.now() >= nextMaintenance) {
        await maintenance(
          new Request("http://worker/api/cron/process-jobs", {
            method: "POST",
            headers: { Authorization: `Bearer ${getEnv().CRON_SECRET}` },
          }),
        );
        nextMaintenance = Date.now() + 3600_000;
      }
    } catch {
      console.error(
        JSON.stringify({ scope: "worker", error: "maintenance_unavailable" }),
      );
    }
    if (!stopping) await sleep(2000);
  }
}
async function publishingLoop() {
  while (!stopping) {
    let claimed = 0;
    try {
      claimed = await processPublicationJobs(4);
    } catch {
      console.error(
        JSON.stringify({ scope: "worker", error: "publishing_unavailable" }),
      );
    }
    if (!stopping) await sleep(claimed ? 200 : 2000);
  }
}
async function main() {
  getEnv();
  await Promise.all([
    transportLoop(),
    legacyLoop(),
    publishingLoop(),
    insightsLoop(),
  ]);
}
async function insightsLoop() {
  let nextPoll = 0;
  while (!stopping) {
    let claimed = 0;
    try {
      if (Date.now() >= nextPoll) claimed = await processInsightsJobs(2);
    } catch {
      console.error(
        JSON.stringify({ scope: "worker", error: "insights_unavailable" }),
      );
    }
    if (Date.now() >= nextPoll)
      nextPoll = Date.now() + (claimed ? 200 : 60_000);
    if (!stopping) await sleep(claimed ? 200 : 2000);
  }
}
main().catch(() => {
  console.error("Worker configuration invalid");
  process.exitCode = 1;
});
