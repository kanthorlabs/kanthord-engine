import { ProviderFailure } from "../scheduler/contract.ts";
import { HttpStatus } from "../kernel/http.ts";

const QUOTA_TEXT =
  /quota|usage limit|insufficient[_ ]balance|billing|credit balance/i;
const STATUS_TEXT = /(?:^|[^\d])([45]\d{2})(?!\d)/;
const UNAUTHORIZED: readonly number[] = [
  HttpStatus.Unauthorized,
  HttpStatus.Forbidden,
];
const CLIENT_ERROR_MIN = 400;
const SERVER_ERROR_MIN = 500;

export function providerFailureOf(errorMessage: string): ProviderFailure {
  if (QUOTA_TEXT.test(errorMessage)) return ProviderFailure.QuotaExhausted;
  const match = STATUS_TEXT.exec(errorMessage);
  const status = match ? Number(match[1]) : null;
  if (status === HttpStatus.TooManyRequests) return ProviderFailure.RateLimited;
  if (status !== null && UNAUTHORIZED.includes(status))
    return ProviderFailure.Unauthorized;
  if (
    status !== null &&
    status >= CLIENT_ERROR_MIN &&
    status < SERVER_ERROR_MIN
  )
    return ProviderFailure.BadRequest;
  return ProviderFailure.Unavailable;
}
