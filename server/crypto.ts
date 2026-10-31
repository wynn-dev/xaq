import { createCipheriv, createDecipheriv, createHash, randomBytes, type ScryptOptions, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { envVar } from "./brand.ts";

/**
 * Secrets at rest (refresh tokens, connection credentials, Google client secret) are AES-256-GCM encrypted.
 * Key source: XAQ_MASTER_KEY (AGENTINBOX_MASTER_KEY before the rename; base64, 32 bytes) or `<dataDir>/master.key` (generated, mode 0600).
 * Ciphertext format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 */
export class Crypto {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("master key must be 32 bytes");
    this.key = key;
  }

  static load(keyFile: string): Crypto {
    const fromEnv = envVar("MASTER_KEY");
    if (fromEnv) return new Crypto(Buffer.from(fromEnv, "base64"));
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
    }
    chmodSync(keyFile, 0o600);
    return new Crypto(Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64"));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  }

  decrypt(enc: string): string {
    if (!enc.startsWith("v1:")) throw new Error("unknown ciphertext version");
    const buf = Buffer.from(enc.slice(3), "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** Fast hash for high-entropy tokens (API keys, session tokens). */
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Password hashing for the admin password. Format: "scrypt$N$r$p$salt$hash". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

const scryptAsync = (password: string, salt: Buffer, length: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, length, opts, (err, key) => (err ? reject(err) : resolve(key))));

/** Like hashPassword, but runs scrypt on the thread pool instead of blocking the event loop. */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Like verifyPassword, but runs scrypt on the thread pool instead of blocking the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
