import { BlockList, isIP } from "node:net";

const normalize = (address: string) =>
  address.startsWith("::ffff:") && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;
export function clientAddress(trustedProxies: string[]) {
  const trusted = new BlockList();
  for (const item of trustedProxies) {
    const [raw, mask, ...extra] = item.split("/");
    const address = normalize(raw!),
      version = isIP(address);
    if (
      !version ||
      extra.length ||
      (mask !== undefined &&
        (!/^\d+$/.test(mask) || Number(mask) > (version === 4 ? 32 : 128)))
    )
      throw new Error(
        "trustedProxies must contain IP addresses or CIDR subnets",
      );
    if (mask === undefined)
      trusted.addAddress(address, version === 4 ? "ipv4" : "ipv6");
    else
      trusted.addSubnet(address, Number(mask), version === 4 ? "ipv4" : "ipv6");
  }
  const contains = (address: string) => {
    const version = isIP(address);
    return !!version && trusted.check(address, version === 4 ? "ipv4" : "ipv6");
  };
  return (
    remote: string | undefined,
    forwarded: string | string[] | undefined,
  ) => {
    let address = normalize(remote ?? "unknown");
    if (!contains(address) || !forwarded || Array.isArray(forwarded))
      return address;
    const chain = forwarded.split(",").map((s) => normalize(s.trim()));
    if (chain.length > 16 || chain.some((ip) => !isIP(ip))) return address;
    for (let i = chain.length - 1; i >= 0 && contains(address); i--)
      address = chain[i]!;
    return address;
  };
}
