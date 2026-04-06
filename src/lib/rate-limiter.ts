// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

const MAX_CONCURRENT = 3;
const MAX_PER_MINUTE = 40;

let activeCalls = 0;
let callTimestamps: number[] = [];

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

function pruneOldTimestamps(): void {
  const oneMinuteAgo = Date.now() - 60_000;
  callTimestamps = callTimestamps.filter((ts) => ts > oneMinuteAgo);
}

export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  pruneOldTimestamps();

  if (activeCalls >= MAX_CONCURRENT) {
    throw new RateLimitError(
      `Concurrent request limit reached (${MAX_CONCURRENT}). Please retry shortly.`
    );
  }

  if (callTimestamps.length >= MAX_PER_MINUTE) {
    throw new RateLimitError(
      `Per-minute request limit reached (${MAX_PER_MINUTE}). Please retry shortly.`
    );
  }

  activeCalls++;
  callTimestamps.push(Date.now());

  try {
    return await fn();
  } finally {
    activeCalls--;
  }
}
