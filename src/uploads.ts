// Zeynep Sudem Aktaş, 2025502009
// Bonus 12: helpers for image uploads.

export const MAX_UPLOAD_BYTES = 1_000_000;
export const ALLOWED_TYPES = ["image/png", "image/jpeg"] as const;
export type ImageType = (typeof ALLOWED_TYPES)[number];

const EXT: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg" };
const TYPE_BY_EXT: Record<string, ImageType> = { png: "image/png", jpg: "image/jpeg" };

/** The first bytes of a file say what it really is; the type the client sends can lie. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** A generated name: never the name the user sent. */
export function newAttachmentName(type: ImageType): string {
  return `${crypto.randomUUID()}.${EXT[type]}`;
}

const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpg)$/;

/** Only names this server generated are ever turned into a path (no "../"). */
export function contentTypeOf(name: string): ImageType | null {
  if (!SAFE_NAME.test(name)) return null;
  return TYPE_BY_EXT[name.split(".")[1]] ?? null;
}

export async function removeFile(dir: string, name: string | null): Promise<void> {
  if (!name || !SAFE_NAME.test(name)) return;
  try {
    await Deno.remove(`${dir}/${name}`);
  } catch {
    // already gone
  }
}
