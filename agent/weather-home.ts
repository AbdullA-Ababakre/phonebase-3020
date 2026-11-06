import type { VisionOcrResult } from "./vision-ocr";

// This invitation opens Settings. Cancel only closes it; permission decisions
// (e.g. "Don't Allow" / "Allow Once") must always stay with the customer.
export function weatherSettingsCancel(ocr: VisionOcrResult) {
  if (ocr.imageWidth !== 720 || ocr.imageHeight !== 1560) return null;
  const at = (text: string, x: number, y: number) => ocr.items.find(i =>
    i.text.replace(/[“”]/g, '"') === text && i.confidence >= 0.85 &&
    Math.abs(i.centerX - x) < 28 && Math.abs(i.centerY - y) < 20);
  const cancel = at("Cancel", 492, 893);
  return cancel && at("Turn On Location Services to", 360, 705) && at('Allow "Weather" to', 360, 747)
    && at("Determine Your Location", 360, 789) && at("Settings", 231, 893)
    ? { x: cancel.centerX, y: cancel.centerY } : null;
}
