import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns";
import { HostError } from "@pluhub/sdk";
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
// IPv6 public unicast only. Exclude documentation and transition mechanisms.
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  );
}
export function assertPublicUrl(url: URL) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    (isIP(hostname) && !isPublicAddress(hostname)) ||
    /(^|\.)(localhost|local|internal|home|lan)$/i.test(hostname) ||
    (!isIP(hostname) && !hostname.includes("."))
  )
    throw new HostError("private_upstream", "个人渠道只允许公网地址", 403);
}
/** Runs inside the connector, so DNS changes cannot bypass validation. */
export const publicLookup = (hostname: string, options: any, callback: any) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
      return callback(
        new HostError("private_upstream", "个人渠道不能连接内网地址", 403),
      );
    const selected = options.family
      ? addresses.filter((a) => a.family === options.family)
      : addresses;
    if (!selected.length)
      return callback(new Error("No address for requested family"));
    if (options.all) callback(null, selected);
    else callback(null, selected[0]!.address, selected[0]!.family);
  });
};
