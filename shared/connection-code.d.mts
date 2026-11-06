export type PhonebaseConnectionAccess = {
  gatewayUrl: string;
  token: string;
};

export function createPhonebaseAccessCode(
  gatewayUrl: string,
  token: string,
): string;
export function readPhonebaseAccessCode(value: string): PhonebaseConnectionAccess;
