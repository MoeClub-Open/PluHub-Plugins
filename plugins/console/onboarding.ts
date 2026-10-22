export function consoleEntry(config: any, name = "console") {
  return config.plugins.find((plugin: any) =>
    new RegExp("/(?:official\\.)?" + name + "$").test(
      plugin.path.replaceAll("\\", "/"),
    ),
  );
}

/** First-install routing is separate from the normal settings navigation. */
export function setupRedirect(
  required: boolean,
  path: string,
  signedIn: boolean,
) {
  if (required && path !== "/setup") return "/setup";
  if (!required && path === "/setup") return signedIn ? "/console" : "/login";
  return undefined;
}
export interface SetupState {
  required: boolean;
  stage: "site" | "admin" | "complete";
  step?: number;
  revision?: string;
  branding?: Record<string, unknown>;
  portal?: Record<string, unknown>;
  publicOrigin?: string;
  secureCookie?: boolean;
}
export function onboardingChecks(state: SetupState, origin: string) {
  return {
    origin:
      !state.publicOrigin || state.publicOrigin.replace(/\/$/, "") === origin,
    cookie: !origin.startsWith("https:") || state.secureCookie === true,
  };
}
