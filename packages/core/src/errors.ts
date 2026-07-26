/** Thrown when a configuration value is missing or still holds the REPLACE_ME sentinel. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';

  constructor(
    readonly key: string,
    override readonly message: string,
  ) {
    super(message);
  }
}
