import type { Transport, TransportRequest, TransportResponse } from '../../src/core/http/index.js';

/** A scripted step: a canned response, an error to throw, or a function for custom behaviour. */
export type Step =
  | Partial<TransportResponse>
  | Error
  | ((req: TransportRequest, signal: AbortSignal) => Promise<TransportResponse>);

export interface FakeTransport {
  transport: Transport;
  calls: TransportRequest[];
  signals: AbortSignal[];
}

/**
 * Replays `steps` in order (the last step repeats once the script runs out) and records every
 * request the client actually dispatched, so tests can assert on ordering, headers and counts.
 */
export function fakeTransport(steps: Step[]): FakeTransport {
  const calls: TransportRequest[] = [];
  const signals: AbortSignal[] = [];
  let i = 0;
  const transport: Transport = async (req, signal) => {
    calls.push(structuredClone(req));
    signals.push(signal);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step === undefined) throw new Error('fakeTransport: no steps');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(req, signal);
    return { status: 200, headers: {}, body: '', ...step };
  };
  return { transport, calls, signals };
}

export function jsonStep(value: unknown, status = 200, headers: Record<string, string> = {}): Step {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(value),
  };
}

/** A sleep that never waits but remembers what it was asked for. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

/** Returns the given values in order, then repeats the last one. */
export function seededRandom(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)] ?? 0;
    i += 1;
    return v;
  };
}

export function collectLog(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

/** Wraps bytes in a ReadableStream the way the real fetch transport would. */
export function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
