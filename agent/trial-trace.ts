import type { EventInput } from "./observability";

/** Measure server-owned stages without persisting prompts, OCR, targets or images. */
export async function traceTrialStage<T>(
  record: (event: EventInput) => void,
  context: Pick<EventInput, "actor" | "source" | "deviceId" | "requestId" | "receiptId">,
  stage: "planner" | "locator" | "execution" | "frame_wait",
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let status = "completed";
  try { return await run(); }
  catch (error) { status = "failed"; throw error; }
  finally {
    record({ ...context, kind: "agent.stage", status, level: status === "failed" ? "warning" : "info",
      durationMs: Math.round(performance.now() - started), details: { stage } });
  }
}
