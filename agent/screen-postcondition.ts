import type { VisionOcrResult } from "./vision-ocr";

export type ScreenExpectation = {
  text?: string;
  match?: "exact" | "contains";
  region?: "all" | "top" | "input";
  keyboard?: boolean;
  bounds?: {left:number;top:number;right:number;bottom:number};
};

/** Literal comparison: punctuation is significant; keyboard/suggestion text is
 * excluded from input-field verification. OCR evidence is not an app hierarchy. */
export function evaluateScreenExpectation(ocr: VisionOcrResult, expected: ScreenExpectation, keyboardVisible: boolean) {
  const items = ocr.items.filter(item => item.confidence >= 0.65 &&
    (!expected.bounds || (item.centerX/ocr.imageWidth>=expected.bounds.left && item.centerX/ocr.imageWidth<=expected.bounds.right &&
      item.centerY/ocr.imageHeight>=expected.bounds.top && item.centerY/ocr.imageHeight<=expected.bounds.bottom)) &&
    (expected.region === "top" ? item.centerY < ocr.imageHeight * 0.35 :
      expected.region === "input" ? item.centerY < ocr.imageHeight * 0.62 : true));
  const texts = items.map(item => item.text.normalize("NFC"));
  const needle = expected.text?.normalize("NFC");
  const textMatched = needle === undefined || texts.some(text =>
    expected.match === "exact" ? text === needle : text.includes(needle));
  return {
    matched: textMatched && (expected.keyboard === undefined || expected.keyboard === keyboardVisible),
    textMatched,
    keyboardVisible,
    evidence: texts,
    method: "literal-ocr" as const,
  };
}

export function visibleAccessBlockers(ocr: VisionOcrResult) {
  const text=ocr.items.filter(i=>i.confidence>=0.65).map(i=>i.text).join(" ");
  const blockers:string[]=[];
  if (/what.s your mobile number/i.test(text) && /(?:sign up|meta account)/i.test(text)) blockers.push("account_onboarding_required");
  if (/get the app to keep using reddit/i.test(text)) blockers.push("platform_app_install_gate");
  if (/log in to use old reddit/i.test(text)) blockers.push("platform_login_required");
  return blockers;
}
