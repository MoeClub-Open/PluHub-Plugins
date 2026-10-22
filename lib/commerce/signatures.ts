import {
  createHash,
  createHmac,
  sign,
  verify,
  timingSafeEqual,
} from "node:crypto";
import { HostError } from "@pluhub/sdk";
export function canonical(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .filter(
      (k) =>
        k !== "sign" &&
        k !== "sign_type" &&
        fields[k] !== "" &&
        fields[k] !== undefined &&
        fields[k] !== null,
    )
    .sort()
    .map((k) => {
      if (!["string", "number"].includes(typeof fields[k]))
        throw new HostError("invalid_signature", "Invalid signed parameter");
      return k + "=" + fields[k];
    })
    .join("&");
}
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function epaySign(
  fields: Record<string, unknown>,
  algorithm: "MD5" | "RSA",
  key: string,
) {
  const text = canonical(fields);
  return algorithm === "MD5"
    ? createHash("md5")
        .update(text + key)
        .digest("hex")
    : sign("RSA-SHA256", Buffer.from(text), key).toString("base64");
}
export function epayVerify(
  fields: Record<string, unknown>,
  algorithm: "MD5" | "RSA",
  key: string,
) {
  if (fields.sign_type !== algorithm || typeof fields.sign !== "string")
    return false;
  try {
    return algorithm === "MD5"
      ? equal(epaySign(fields, algorithm, key), fields.sign.toLowerCase())
      : verify(
          "RSA-SHA256",
          Buffer.from(canonical(fields)),
          key,
          Buffer.from(fields.sign, "base64"),
        );
  } catch {
    return false;
  }
}
export function stripeVerify(
  raw: Uint8Array,
  header: string,
  secret: string,
  now = Date.now(),
) {
  const fields = header.split(",").map((p) => p.split("="));
  const t = fields.find((p) => p[0] === "t")?.[1];
  if (!t || !/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > 300)
    throw new HostError("invalid_signature", "Expired Stripe signature");
  const expected = createHmac("sha256", secret)
    .update(t + ".")
    .update(raw)
    .digest("hex");
  if (!fields.some((p) => p[0] === "v1" && equal(expected, p[1] ?? "")))
    throw new HostError("invalid_signature", "Invalid Stripe signature");
}
