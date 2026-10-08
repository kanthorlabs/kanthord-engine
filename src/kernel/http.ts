/** HTTP values shared by transport declarations, clients, and their tests. */
export const HttpStatus = {
  OK: 200,
  Accepted: 202,
  NoContent: 204,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  RequestTimeout: 408,
  Conflict: 409,
  PayloadTooLarge: 413,
  UnsupportedMediaType: 415,
  TooManyRequests: 429,
  InternalServerError: 500,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
} as const;

export const HttpMethod = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
} as const;

export const MediaType = {
  JSON: "application/json",
  YAML: "application/yaml",
  Binary: "application/octet-stream",
} as const;
