export class HarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}
