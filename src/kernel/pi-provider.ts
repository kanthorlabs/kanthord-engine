export const ANTHROPIC_SUBSCRIPTION_PLATFORM = "anthropic-subscription";
export const ANTHROPIC_PI_PROVIDER_ID = "anthropic";

type PiProviderId<Platform extends string> =
  | Exclude<Platform, typeof ANTHROPIC_SUBSCRIPTION_PLATFORM>
  | (Platform extends typeof ANTHROPIC_SUBSCRIPTION_PLATFORM
      ? typeof ANTHROPIC_PI_PROVIDER_ID
      : never);

export function piProviderId<Platform extends string>(
  platform: Platform,
): PiProviderId<Platform> {
  return (
    platform === ANTHROPIC_SUBSCRIPTION_PLATFORM
      ? ANTHROPIC_PI_PROVIDER_ID
      : platform
  ) as PiProviderId<Platform>;
}
