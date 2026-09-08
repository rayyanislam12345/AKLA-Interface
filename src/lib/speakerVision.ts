import type { Worker } from "tesseract.js";

// Reading Zoom's on-screen active speaker off the shared video, so diarized
// speakers can be given real names automatically.
//
// This deliberately keys on Zoom's *Speaker View* rather than the gallery's
// highlighted tile: in Speaker View the active speaker simply is the main
// tile, so there's no border colour to detect — a colour that shifts between
// Zoom versions and themes and would be the first thing to break. All that's
// needed is the name label, and where that sits is established once by the
// user dragging a box over it rather than guessed from layout heuristics.

// Fractions of frame width/height, so a calibration survives the window
// being resized or the capture resolution changing.
export interface NameLabelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpeakerObservation {
  name: string;
  atSec: number;
}

// Zoom's label is small, light text on a translucent dark pill. Tesseract
// does much better on it upscaled and hard-thresholded than on the raw crop.
const OCR_UPSCALE = 3;

export function grabFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

export function cropRegion(source: HTMLCanvasElement, region: NameLabelRegion): HTMLCanvasElement | null {
  const sx = Math.max(0, Math.floor(region.x * source.width));
  const sy = Math.max(0, Math.floor(region.y * source.height));
  const sw = Math.max(1, Math.floor(region.width * source.width));
  const sh = Math.max(1, Math.floor(region.height * source.height));

  const canvas = document.createElement("canvas");
  canvas.width = sw * OCR_UPSCALE;
  canvas.height = sh * OCR_UPSCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  // Zoom draws the name light-on-dark, which Tesseract reads poorly. Convert
  // to luminance, then invert to dark-on-light — the orientation its models
  // were trained on.
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const value = 255 - luma;
    px[i] = px[i + 1] = px[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);

  return canvas;
}

// Imported dynamically: Tesseract is several megabytes of JS plus a WASM
// build, and speaker detection is an opt-in extra that most sessions never
// touch. A static import would put all of that in the main bundle for every
// page load in the app.
export async function createOcrWorker(): Promise<Worker> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  await worker.setParameters({
    // Names only: letters, spaces and the punctuation that shows up in
    // display names. Constraining the alphabet keeps digits and symbols from
    // being hallucinated out of the pill's rounded edges.
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .'-",
  });
  return worker;
}

// Zoom suffixes the label with things like "(Host)", "(Guest)", "(Me)", and
// the mute icon often OCRs as stray punctuation on either end.
export function tidyName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\((host|co-host|guest|me|you|外部)\)/gi, "")
    .replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "")
    .trim();
}

export async function readNameLabel(
  worker: Worker,
  video: HTMLVideoElement,
  region: NameLabelRegion
): Promise<string | null> {
  const frame = grabFrame(video);
  if (!frame) return null;
  const crop = cropRegion(frame, region);
  if (!crop) return null;

  const { data } = await worker.recognize(crop);
  const name = tidyName(data.text ?? "");
  // A confident read of a plausible name, or nothing. Two characters is
  // below any real display name and is usually the pill's border.
  if (name.length < 3) return null;
  if (typeof data.confidence === "number" && data.confidence < 55) return null;
  return name;
}
