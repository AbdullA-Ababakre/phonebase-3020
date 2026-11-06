import type { VisionOcrResult } from "./vision-ocr";

export type IosKeyboardPoint = {
  x: number;
  y: number;
  key: string;
  /** Give iOS time to finish changing keyboard layouts before the next tap. */
  delayAfterMs?: number;
};

export type IosKeyboardCalibration = {
  points: Record<string, { x: number; y: number }>;
  strict: boolean;
};
export type IosKeyboardGeometry = {rows:{dx:number;y:number}[];mode:{x:number;y:number};space:{x:number;y:number}};

export function iosKeyboardGeometryFromOcr(ocr: VisionOcrResult): IosKeyboardGeometry | undefined {
  if (ocr.imageWidth !== 720 || ocr.imageHeight !== 1560) return undefined;
  const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const rows=alphaRows.map(row=>{
    const samples=ocr.items.filter(i=>i.confidence>=0.5 && /^[a-z]$/i.test(i.text.trim()) &&
      row.keys.includes(i.text.trim().toLowerCase()) && i.centerY>970 && i.centerY<1340)
      .map(i=>({y:i.centerY,dx:i.centerX-row.xs[row.keys.indexOf(i.text.trim().toLowerCase())]}))
      .filter(i=>Math.abs(i.dx)<25);
    return samples.length>=3 ? {y:median(samples.map(i=>i.y)),dx:median(samples.map(i=>i.dx))} : null;
  });
  const mode=ocr.items.find(i=>i.confidence>=0.65 && i.text.trim()==="123" && i.centerY>1320 && i.centerX<170);
  const space=ocr.items.find(i=>i.confidence>=0.65 && i.text.trim().toLowerCase()==="space" && i.centerY>1320);
  if (rows.some(r=>!r) || !mode || !space) return undefined;
  const valid=rows as {dx:number;y:number}[];
  if (valid[1].y-valid[0].y<70 || valid[1].y-valid[0].y>125 || valid[2].y-valid[1].y<70 || valid[2].y-valid[1].y>125) return undefined;
  return {rows:valid,mode:{x:mode.centerX,y:mode.centerY},space:{x:space.centerX,y:space.centerY}};
}

const alphaRows = [
  { keys: "qwertyuiop", xs: [43, 115, 187, 259, 331, 403, 475, 547, 619, 685], y: 1_105 },
  { keys: "asdfghjkl", xs: [79, 151, 223, 295, 367, 439, 511, 583, 653], y: 1_198 },
  { keys: "zxcvbnm", xs: [151, 223, 295, 367, 439, 511, 583], y: 1_292 },
] as const;

const numericRows = [
  { keys: "1234567890", xs: [43, 115, 187, 259, 331, 403, 475, 547, 619, 685], y: 1_105 },
  { keys: ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'], xs: [43, 115, 187, 259, 331, 403, 475, 547, 619, 685], y: 1_198 },
  { keys: [".", ",", "?", "!", "'"], xs: [163, 259, 367, 475, 571], y: 1_292 },
] as const;

const alphabet = new Map<string, IosKeyboardPoint>();
for (const row of alphaRows) {
  [...row.keys].forEach((key, index) => {
    alphabet.set(key, { x: row.xs[index], y: row.y, key });
  });
}

const numeric = new Map<string, IosKeyboardPoint>();
for (const row of numericRows) {
  [...row.keys].forEach((key, index) => {
    numeric.set(key, { x: row.xs[index], y: row.y, key });
  });
}

const secondarySymbols = new Map<string,IosKeyboardPoint>();
for (const [index,key] of [..."[]{}#%^*+="].entries()) secondarySymbols.set(key,{x:alphaRows[0].xs[index],y:1105,key});
for (const [index,key] of [..."_\\|~<>€£¥•"].entries()) secondarySymbols.set(key,{x:alphaRows[0].xs[index],y:1198,key});
export const IOS_ENGLISH_SUPPORTED_CHARACTERS = [...alphabet.keys(),...alphabet.keys()].map((key,index)=>index < alphabet.size ? key : key.toUpperCase()).join("") + [...numeric.keys(),...secondarySymbols.keys()].join("") + " ";

const switchMode = { x: 50, y: 1_388, delayAfterMs: 450 } as const;
const shift = { x: 52, y: 1_292 } as const;
const space = { x: 360, y: 1_388, key: "space" } as const;

const phoneKeypad = new Map<string, IosKeyboardPoint>([
  ["1", { x: 123, y: 1_058, key: "phone-1" }],
  ["2", { x: 360, y: 1_058, key: "phone-2" }],
  ["3", { x: 599, y: 1_058, key: "phone-3" }],
  ["4", { x: 123, y: 1_161, key: "phone-4" }],
  ["5", { x: 360, y: 1_161, key: "phone-5" }],
  ["6", { x: 599, y: 1_161, key: "phone-6" }],
  ["7", { x: 123, y: 1_265, key: "phone-7" }],
  ["8", { x: 360, y: 1_265, key: "phone-8" }],
  ["9", { x: 599, y: 1_265, key: "phone-9" }],
  ["0", { x: 360, y: 1_369, key: "phone-0" }],
]);

/** Read letter case from the visible keyboard, excluding ambiguous c/C, s/S, etc. */
export function iosKeyboardInitialShift(ocr: VisionOcrResult): boolean | undefined {
  const letters = new Set(ocr.items
    .filter((item) => item.confidence >= 0.5 &&
      item.centerY / ocr.imageHeight >= 0.63 &&
      item.centerY / ocr.imageHeight <= 0.85)
    .map((item) => item.text.trim())
    .filter((text) => /^[abdefghijklmnpqrt]$/i.test(text)));
  const lower = [...letters].filter((letter) => letter === letter.toLowerCase()).length;
  const upper = letters.size - lower;
  if (lower >= 4 && lower > upper) return false;
  if (upper >= 6 && lower === 0) return true;
  return undefined;
}

/** Converts a phone number into one batched gesture on the iOS 3×4 phone keypad. */
export function iosPhoneKeypadSequence(text: string): IosKeyboardPoint[] {
  if (!/^\d+$/.test(text)) {
    throw new Error("The iOS phone keypad accepts digits only");
  }
  return [...text].map((digit) => phoneKeypad.get(digit)!);
}

/**
 * Converts text into taps on the calibrated iOS portrait English keyboard.
 * A standard alphabet keyboard must be focused initially. The sequence always
 * restores alphabet mode. Enter is intentionally a separate explicit action.
 */
export function iosEnglishKeyboardSequence(
  text: string,
  calibration?: IosKeyboardCalibration,
  initialShift = false,
  geometry?: IosKeyboardGeometry,
): IosKeyboardPoint[] {
  const points: IosKeyboardPoint[] = [];
  let mode: "alpha" | "numeric" | "symbols" = "alpha";
  let shifted = initialShift;

  const setMode = (next: typeof mode) => {
    if (mode === next) return;
    if (next === "alpha") points.push({...switchMode,key:"ABC"});
    else {
      if (mode === "alpha") points.push({...switchMode,key:"123"});
      if (next === "symbols" || mode === "symbols") points.push({...shift,key:next === "symbols" ? "#+=" : "123-symbols",delayAfterMs:450});
    }
    mode = next;
    shifted = false;
  };

  for (const character of text) {
    if (character === " ") {
      points.push(space);
      continue;
    }
    if (character === "\n" || character === "\r") {
      throw new Error("input_text does not submit forms; use the key action with enter explicitly");
    }
    const lower = character.toLowerCase();
    const letter = alphabet.get(lower);
    if (letter) {
      setMode("alpha");
      if ((character !== lower) !== shifted) points.push({ ...shift, key: "shift" });
      points.push(letter);
      shifted = false;
      continue;
    }
    const symbol = numeric.get(character);
    if (symbol) {
      setMode("numeric");
      points.push({...symbol,delayAfterMs:120});
      continue;
    }
    const secondary = secondarySymbols.get(character);
    if (secondary) {
      setMode("symbols");
      points.push({...secondary,delayAfterMs:120});
      continue;
    }
    throw new Error(`The calibrated iOS English keyboard cannot type ${JSON.stringify(character)}`);
  }

  setMode("alpha");
  if (!calibration && geometry) return points.map(p=>{
    if (p.y===1388) return {...p,...(p.key==="space"?geometry.space:geometry.mode)};
    const rowIndex=p.y===1105?0:p.y===1198?1:2;
    return {...p,x:p.x+geometry.rows[rowIndex].dx,y:geometry.rows[rowIndex].y};
  });
  if (!calibration) return points;
  return points.map((keyPoint) => {
    const calibrated = calibration.points[keyPoint.key];
    if (calibrated) return { ...keyPoint, ...calibrated };
    if (calibration.strict) {
      throw new Error(
        `The physical keyboard key ${JSON.stringify(keyPoint.key)} is not calibrated for this device`,
      );
    }
    return keyPoint;
  });
}
