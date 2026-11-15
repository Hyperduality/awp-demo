/** Seven float32 per body: position then quaternion [x, y, z, w]. */
export const POSE_STRIDE = 7;

/** base64 with the functions Node and browsers share, so the same code packs in the world and unpacks in the UI. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function packFloats(values: Float32Array): string {
  return toBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

export function unpackFloats(text: string): Float32Array {
  const bytes = fromBase64(text);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
}
