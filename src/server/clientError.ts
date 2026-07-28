/** A safe, expected error whose message may be returned to an API client. */
export class ClientError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ClientError";
  }
}
