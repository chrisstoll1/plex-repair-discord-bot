import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "v1";

export class SecretBox {
  private readonly key: Buffer;

  private constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("Secret key must be 32 bytes");
    }
    this.key = key;
  }

  static open(keyPath: string): SecretBox {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });

    if (!fs.existsSync(keyPath)) {
      fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
    }

    const key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
    return new SecretBox(key);
  }

  encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
  }

  decrypt(value: string): string {
    const [prefix, ivRaw, tagRaw, ciphertextRaw] = value.split(":");
    if (prefix !== PREFIX || !ivRaw || !tagRaw || !ciphertextRaw) {
      throw new Error("Unsupported encrypted secret format");
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivRaw, "base64"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
