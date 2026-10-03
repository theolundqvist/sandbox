import { EgressError, publicGet, type BrokerOptions } from "./box/broker";

/** The largest file add_asset stores, from a url or base64. */
export const ASSET_LIMIT = 50 << 20;

/** Types any asset may arrive as from a server that doesn't know better, like GitHub raw links and object stores. A response without a type counts as one of these. */
const GENERIC = ["application/octet-stream", "binary/octet-stream"];

/**
 * What add_asset stores, by file extension: the type the world serves it as, and the content types a download of it may
 * arrive with besides the generic ones. Only inert models, images, sounds, fonts and data: nothing taken becomes a page
 * or script on the game's origin.
 */
const ASSETS: Record<string, { type: string; accept: string[] }> = {
  glb: { type: "model/gltf-binary", accept: ["model/gltf-binary"] },
  gltf: { type: "model/gltf+json", accept: ["model/gltf+json", "application/json", "text/plain"] },
  bin: { type: "application/octet-stream", accept: [] },
  // Models the guide's skills load as they are: VRM is binary glTF, FBX a model file; neither is a page or a script.
  vrm: { type: "model/gltf-binary", accept: ["model/gltf-binary"] },
  fbx: { type: "application/octet-stream", accept: ["text/plain"] },
  png: { type: "image/png", accept: ["image/png"] },
  jpg: { type: "image/jpeg", accept: ["image/jpeg"] },
  webp: { type: "image/webp", accept: ["image/webp"] },
  ktx2: { type: "image/ktx2", accept: ["image/ktx2"] },
  hdr: { type: "image/vnd.radiance", accept: ["image/vnd.radiance", "image/x-hdr"] },
  ogg: { type: "audio/ogg", accept: ["audio/ogg", "application/ogg"] },
  mp3: { type: "audio/mpeg", accept: ["audio/mpeg", "audio/mp3"] },
  wav: { type: "audio/wav", accept: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"] },
  // The game page takes fonts from the world alone: CSS reads all four, troika-three-text all but woff2.
  ttf: { type: "font/ttf", accept: ["font/ttf", "font/sfnt", "application/x-font-ttf", "application/font-sfnt"] },
  otf: { type: "font/otf", accept: ["font/otf", "font/sfnt", "application/x-font-opentype", "application/font-sfnt", "application/vnd.ms-opentype"] },
  woff: { type: "font/woff", accept: ["font/woff", "application/font-woff"] },
  woff2: { type: "font/woff2", accept: ["font/woff2", "application/font-woff2"] },
  json: { type: "application/json", accept: ["application/json", "text/plain"] },
};

/** The kinds of file add_asset takes, for messages. */
export const ASSET_FILES = Object.keys(ASSETS)
  .map((ext) => `.${ext}`)
  .join(", ");

function asset(name: string) {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext && Object.hasOwn(ASSETS, ext) ? ASSETS[ext]! : null;
}

/** The content type the world serves an asset file as, or null when add_asset doesn't take files like it. */
export function assetType(name: string): string | null {
  return asset(name)?.type ?? null;
}

/**
 * Downloads a builder's asset, to be stored as `name`, the way a mod's fetch goes out: public addresses only, every
 * redirect checked again, each connection pinned to the address that was checked (box/broker's publicGet). Refuses
 * names add_asset doesn't take, responses whose type says they are something else, and anything over `limit` bytes.
 * `options` is for tests only.
 */
export async function download(raw: string, name: string, limit = ASSET_LIMIT, options: BrokerOptions = {}): Promise<Uint8Array> {
  const kind = asset(name);
  if (!kind) throw new EgressError(`add_asset takes only ${ASSET_FILES} files.`);
  const { res, url } = await publicGet(raw, options);
  const refuse = async (message: string): Promise<never> => {
    await res.body?.cancel();
    throw new EgressError(message);
  };
  const tooBig = `The file is larger than the ${Math.round(limit / 2 ** 20)} MiB add_asset takes.`;
  if (!res.ok) return refuse(`Download failed: HTTP ${res.status}`);
  const type = res.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() || GENERIC[0]!;
  if (!GENERIC.includes(type) && !kind.accept.includes(type)) return refuse(`${url.origin} sent ${type}, not a ${name.slice(name.lastIndexOf("."))} file.`);
  if (Number(res.headers.get("content-length")) > limit) return refuse(tooBig);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      if ((total += chunk.byteLength) > limit) throw new EgressError(tooBig);
      chunks.push(chunk);
    }
  } catch (error) {
    throw error instanceof EgressError ? error : new EgressError(`Download from ${url.origin} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Buffer.concat(chunks);
}
