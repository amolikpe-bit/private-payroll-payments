/** How a sensitive value is replaced. */
export type RedactionMode = "mask" | "remove" | "replacement";

/** Options shared by every redaction helper. */
export interface RedactionOptions {
  /** How to handle sensitive values. Defaults to `"replacement"`. */
  mode?: RedactionMode;
  /** Replacement text when mode is `"replacement"`. Defaults to `"[redacted]"`. */
  replacement?: string;
  /** Additional field names to treat as sensitive, merged with the built-in defaults. */
  additionalFields?: readonly string[];
}

/** Result of redacting a value: the cleaned value plus the keys that were stripped. */
export interface RedactionResult<T> {
  redacted: T;
  fieldsRedacted: string[];
}
