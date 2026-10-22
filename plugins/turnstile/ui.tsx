import type { UIHost } from "@pluhub/ui-sdk";
export function mount(_element: HTMLElement, host: UIHost) {
  host.navigate("/settings/verification?tab=captcha");
  return () => {};
}
