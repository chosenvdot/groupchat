/**
 * A protocol violation whose message is agent-facing prompt text: it explains
 * what was wrong AND the correct next step. The MCP layer renders these as
 * tool errors; they must teach, not just refuse.
 */
export class ProtocolError extends Error {
  readonly agentFacing = true;

  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
