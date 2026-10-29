import jpeg from "jpeg-js";
import { decode as decodePng, encode as encodePng } from "fast-png";

export function whitenBorderBackground(data: Uint8Array, width: number, height: number): void {
  if (data.length !== width * height * 4) throw new Error("invalid RGBA image dimensions");
  let borderPixels = 0, whitePixels = 0;
  const inspect = (p: number) => {
    borderPixels++;
    if (data[p * 4] === 255 && data[p * 4 + 1] === 255 && data[p * 4 + 2] === 255) whitePixels++;
  };
  for (let x = 0; x < width; x++) { inspect(x); inspect((height - 1) * width + x); }
  for (let y = 1; y + 1 < height; y++) { inspect(y * width); inspect(y * width + width - 1); }
  if (whitePixels / borderPixels >= 0.95) return;
  const seen = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let head = 0, tail = 0;
  const visit = (p: number) => {
    if (seen[p]) return;
    seen[p] = 1;
    const i = p * 4;
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    const high = Math.max(data[i], data[i + 1], data[i + 2]);
    // Only the light, neutral component connected to the border is paper.
    // Enclosed grays and saturated highlights belong to the illustration.
    if (low < 180 || high - low > 14) return;
    queue[tail++] = p;
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++];
    const i = p * 4;
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    const t = Math.min(1, (low - 180) / 35);
    const amount = t * t * (3 - 2 * t);
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] + (255 - data[i + c]) * amount);
    const x = p % width;
    if (x > 0) visit(p - 1);
    if (x + 1 < width) visit(p + 1);
    if (p >= width) visit(p - width);
    if (p + width < width * height) visit(p + width);
  }
}

export function whiteBackgroundPng(bytes: Uint8Array): Uint8Array {
  let width: number, height: number, data: Uint8Array;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const decoded = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
    ({ width, height, data } = decoded);
  } else if (bytes[0] === 137 && bytes[1] === 80) {
    const decoded = decodePng(bytes);
    if (decoded.depth !== 8) throw new Error("white background requires an 8-bit image");
    ({ width, height } = decoded);
    if (width * height > 4_000_000) throw new Error("image exceeds white background size limit");
    data = new Uint8Array(width * height * 4);
    const channels = decoded.channels;
    for (let p = 0; p < width * height; p++) {
      const src = p * channels, dst = p * 4;
      const alpha = channels === 2 || channels === 4 ? decoded.data[src + channels - 1] / 255 : 1;
      for (let c = 0; c < 3; c++) data[dst + c] = Math.round(decoded.data[src + (channels <= 2 ? 0 : c)] * alpha + 255 * (1 - alpha));
      data[dst + 3] = 255;
    }
  } else {
    throw new Error("white background requires a JPEG or PNG image");
  }
  whitenBorderBackground(data, width, height);
  return encodePng({ width, height, data, channels: 4, depth: 8 });
}

export function whiteBackgroundBase64(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const png = whiteBackgroundPng(bytes);
  let binary = "";
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return btoa(binary);
}
