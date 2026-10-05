export const RESERVED_NAME_LOGIN = "login";
export const RESERVED_NAME_PLATFORM = "platform";
export const CREDENTIAL_NAME_MAX_LENGTH = 63;

export function validateNameForm(name: string): boolean {
  return (
    name.length <= CREDENTIAL_NAME_MAX_LENGTH && /^[a-z][a-z0-9-]*$/.test(name)
  );
}

export function isReservedName(name: string): boolean {
  return name === RESERVED_NAME_LOGIN || name === RESERVED_NAME_PLATFORM;
}
