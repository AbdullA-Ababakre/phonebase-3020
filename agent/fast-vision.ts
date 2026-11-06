import type { VisionOcrResult, VisionTextItem } from "./vision-ocr";

type PointerPoint = { x: number; y: number };

export type FastHomeAppMatch = {
  appName: string;
  recognizedLabel: string;
  point: PointerPoint;
  confidence: number;
  homeLabelCount: number;
};

const knownHomeLabels = new Set([
  "telegram", "gemini", "x", "reddit", "poe", "perplexity", "gmail",
  "google", "outlook", "googlephotos", "photos", "passwords", "doji",
  "anyconnect", "capcut", "剪映", "rednote", "alipay", "支付宝", "wechat",
  "微信", "wise", "v2box", "bounty", "games", "preview", "snapchat",
  "weather", "stocks", "findmy", "home", "books", "itunesstore", "fitness",
  "watch", "calculator", "notes", "calendar", "camera", "clock", "maps",
  "appstore", "settings", "messages", "phone", "facetime", "mail", "safari",
  "files", "shortcuts", "translate", "contacts", "voicememos", "compass",
  "measure", "tips", "health", "wallet", "reminders", "music", "podcasts",
  "whatsapp", "youtube", "facebook", "instagram", "tiktok", "chatgpt",
]);

const aliases = new Map<string, string[]>([
  ["telegram", ["telegram"]],
  ["googlephotos", ["googlephotos", "photos"]],
  ["photos", ["googlephotos", "photos"]],
  ["passwords", ["passwords", "密码"]],
  ["wechat", ["wechat", "微信"]],
  ["微信", ["wechat", "微信"]],
  ["alipay", ["alipay", "支付宝"]],
  ["支付宝", ["alipay", "支付宝"]],
  ["rednote", ["rednote", "小红书"]],
  ["小红书", ["rednote", "小红书"]],
]);

export function requestedHomeApp(goal: string): string | null {
  const compact = goal.trim();
  const chinese = compact.match(
    /(?:请(?:帮我)?|帮我)?(?:打开|启动|进入)\s*([A-Za-z0-9][A-Za-z0-9 .+_-]{0,40}|[\p{Script=Han}]{1,12})(?=\s*(?:应用|App|app|，|,|。|并|然后|$))/u,
  );
  if (chinese?.[1]) return chinese[1].trim();
  const english = compact.match(
    /(?:^|\b)(?:open|launch|start)\s+(?:the\s+)?([a-z0-9][a-z0-9 .+_-]{0,40}?)(?=\s+(?:app|application|and|then)|[,.]|$)/i,
  );
  return english?.[1]?.trim() || null;
}

export function locateHomeApp(
  appName: string,
  ocr: VisionOcrResult,
  logicalSize: { width: number; height: number },
): FastHomeAppMatch | null {
  // App names also occur in Settings, articles, search lists and switcher
  // cards. Only an observed icon grid authorizes tapping above a label.
  if (!homeScreenGridVisible(ocr)) return null;
  const normalizedItems = ocr.items.map((item) => ({
    item,
    normalized: normalizeLabel(item.text),
  }));
  const homeLabelCount = new Set(
    normalizedItems
      .map(({ normalized }) => normalized)
      .map(knownHomeLabel)
      .filter((label): label is string => Boolean(label)),
  ).size;
  if (homeLabelCount < 4) return null;

  const requested = normalizeLabel(appName);
  const accepted = new Set(aliases.get(requested) ?? [requested]);
  const candidate = normalizedItems
    .filter(({ item, normalized }) =>
      item.confidence >= 0.35 && [...accepted].some(
        (label) => normalized === label || labelsAreNearMatch(normalized, label),
      )
    )
    .sort((left, right) => right.item.confidence - left.item.confidence)[0];
  if (!candidate) return null;

  const scaleX = logicalSize.width / ocr.imageWidth;
  const scaleY = logicalSize.height / ocr.imageHeight;
  const iconOffset = logicalSize.height * 0.054;
  return {
    appName,
    recognizedLabel: candidate.item.text,
    point: {
      x: clamp(candidate.item.centerX * scaleX, 0, logicalSize.width),
      y: clamp(candidate.item.centerY * scaleY - iconOffset, 0, logicalSize.height),
    },
    confidence: candidate.item.confidence,
    homeLabelCount,
  };
}

export function homeScreenLabelCount(ocr: VisionOcrResult) {
  return new Set(
    ocr.items
      .map((item) => normalizeLabel(item.text))
      .map(knownHomeLabel)
      .filter((label): label is string => Boolean(label)),
  ).size;
}

/** Require an icon-label grid, not just app names in a list or app switcher. */
export function homeScreenGridVisible(ocr: VisionOcrResult) {
  const labels = ocr.items.filter(item => item.confidence >= 0.5 &&
    item.centerY > ocr.imageHeight * 0.08 && item.centerY < ocr.imageHeight * 0.82 &&
    knownHomeLabel(normalizeLabel(item.text)));
  if (new Set(labels.map(item => normalizeLabel(item.text))).size < 6) return false;
  const rows: VisionTextItem[][] = [];
  for (const item of labels.sort((a, b) => a.centerY - b.centerY)) {
    const row = rows.find(row => Math.abs(row[0].centerY - item.centerY) < ocr.imageHeight * 0.025);
    if (row) row.push(item); else rows.push([item]);
  }
  return rows.filter(row => row.length >= 3 &&
    Math.max(...row.map(item => item.centerX)) - Math.min(...row.map(item => item.centerX)) > ocr.imageWidth * 0.4
  ).length >= 2;
}

/** Distinguish the App Library category page from Home, search results, or prose.
 * A title alone is not enough to authorize a horizontal navigation gesture. */
export function appLibraryVisible(ocr: VisionOcrResult) {
  const confident = ocr.items.filter(item => item.confidence >= 0.7);
  const title = confident.some(item => normalizeLabel(item.text) === "applibrary" &&
    item.centerY > ocr.imageHeight * 0.03 && item.centerY < ocr.imageHeight * 0.18 &&
    item.centerX > ocr.imageWidth * 0.2 && item.centerX < ocr.imageWidth * 0.8);
  if (!title) return false;
  const categories = new Set(["suggestions", "recentlyadded", "utilities", "social", "creativity",
    "informationreading", "productivityfinance", "entertainment", "travel", "other"]);
  const labels = confident.filter(item => categories.has(normalizeLabel(item.text)) &&
    item.centerY > ocr.imageHeight * 0.2 && item.centerY < ocr.imageHeight * 0.9);
  return new Set(labels.map(item => normalizeLabel(item.text))).size >= 3 &&
    labels.some(item => item.centerX < ocr.imageWidth * 0.45) &&
    labels.some(item => item.centerX > ocr.imageWidth * 0.55) &&
    Math.max(...labels.map(item => item.centerY)) - Math.min(...labels.map(item => item.centerY)) > ocr.imageHeight * 0.15;
}

export function ocrTextSample(ocr: VisionOcrResult, maximum = 8) {
  return ocr.items
    .filter((item: VisionTextItem) => item.confidence >= 0.35)
    .slice(0, maximum)
    .map((item) => item.text)
    .join(" · ");
}

function normalizeLabel(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function labelsAreNearMatch(left: string, right: string) {
  if (left.length < 5 || right.length < 5 || Math.abs(left.length - right.length) > 1) {
    return false;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] <= 1;
}

function knownHomeLabel(label: string) {
  if (knownHomeLabels.has(label)) return label;
  return [...knownHomeLabels].find((known) => labelsAreNearMatch(label, known)) ?? null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
