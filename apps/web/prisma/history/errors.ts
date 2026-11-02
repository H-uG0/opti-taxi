/**
 * Expected failures of the history script (bad option, optimizer unreachable,
 * remote database): their French message is printed alone, without a stack trace.
 */
export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryError";
  }
}
