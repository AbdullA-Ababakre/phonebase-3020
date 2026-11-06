import { decode } from "jpeg-js";

// 24×24 luminance fingerprint of this fixed iPhone's calibrated bottom-left
// "123" key while the standard alphabet keyboard is visible.  Correlation is
// used instead of absolute colors so wallpaper translucency may vary slightly.
const ALPHA_KEY_TEMPLATE = Buffer.from(
  "GhoaGxobGhoaGhsbGxwdHR0dHR4dHRweGhscHSUnJycnJycoKCgoKSoqKichHB4eHBktQ0dGR0ZGRkZHR0dHSEhISEhGLB4fHSdIR0VGRkZGRkZHR0dHR0dHR0hHSiofHDpGRUVGR0ZGRkdHR0hIR0dIR0dIRz4eHUBFRUVGRkZFR0dHR0dHR0dISEhHSEUdHUJGRkZGRkZGR0dHR0dISEdISUhHSEYeHUJFRkZGRUdHR0dHR0hIR0lJR0lISUUdHkJFRkZFQzRFRz5HO0dLO0k9SUlISEYdHUJGRkZCj+tSP7nC2VtQz73RR0pISEYeHUJGRkpQo+ZOWa8wn5ZxdDugaVBKSEcfHUNHR0ZJOuNPTEg7zXFFVJDQSklKSUcgHUNHR0ZHPeNPS0CZnTtIWJnZV01KSkYfHUNGR0dHPeNQSW+rLT5uUjp8hE5KSkYgHkNGRkdHPeNPSvDAuoN61I7bYU9KSUcgH0NHR0ZHRGtHT29ub19BbYpjSktJSUghIERISEhHR0lJRUlJSklJSkZISUpKSkggIEVISEhISElJSElISEhKSUlJSUpKSUggH0NIR0hJSEhISEdHSEhJSElJSkpKSkkiH0JJR0hJSUlHSEdHSEhJSEpJSUpJSkciHj9HR0hHR0dISEdISEhISEpJSUpJSkAjIS5IR0hIR0lHSEhISElISElJSUpJSy8kICA0R0hISEdISEhJSUlJSUpKSktJNSEkISEhJCwvLi8uLi4vLzAwMDAxMS0mIiMk",
  "base64",
);

function fingerprint(jpeg: Buffer) {
  const image = decode(jpeg, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 2,
  });
  if (image.width !== 720 || image.height !== 1_560) return null;
  const output = new Uint8Array(24 * 24);
  const left = 8;
  const top = 1_344;
  const width = 86;
  const height = 84;
  for (let row = 0; row < 24; row += 1) {
    for (let column = 0; column < 24; column += 1) {
      let total = 0;
      let samples = 0;
      const startY = Math.floor(top + row * height / 24);
      const endY = Math.floor(top + (row + 1) * height / 24);
      const startX = Math.floor(left + column * width / 24);
      const endX = Math.floor(left + (column + 1) * width / 24);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * image.width + x) * 4;
          total += image.data[offset] * 0.2126 +
            image.data[offset + 1] * 0.7152 +
            image.data[offset + 2] * 0.0722;
          samples += 1;
        }
      }
      output[row * 24 + column] = Math.round(total / samples);
    }
  }
  return output;
}

function correlation(left: Uint8Array, right: Uint8Array) {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    covariance += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : 0;
}

export function iosEnglishKeyboardConfidence(jpeg: Buffer) {
  try {
    const current = fingerprint(jpeg);
    return current ? correlation(current, ALPHA_KEY_TEMPLATE) : 0;
  } catch {
    return 0;
  }
}

export function iosEnglishKeyboardVisible(jpeg: Buffer) {
  return iosEnglishKeyboardConfidence(jpeg) >= 0.9;
}
