interface ObjectFrame { keys: Set<string>; expectsKey: boolean }

/** Reject duplicate decoded keys before an ambiguous package can become authoritative state. */
export function parseStrictJson(source: string): unknown {
  const parsed: unknown = JSON.parse(source, (key: string, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new SyntaxError(`Non-finite JSON number at key ${JSON.stringify(key)}.`);
    }
    return value;
  });

  // JSON.parse has already checked grammar. This second pass needs only container/key state.
  const stack: Array<ObjectFrame | null> = [];
  const tokens = source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],]/g);
  for (const token of tokens) {
    const value = token[0];
    if (value === '{') stack.push({ keys: new Set(), expectsKey: true });
    else if (value === '[') stack.push(null);
    else if (value === '}' || value === ']') stack.pop();
    else {
      const frame = stack.at(-1);
      if (frame == null) continue;
      if (value === ',') frame.expectsKey = true;
      else if (value.startsWith('"') && frame.expectsKey) {
        const key = JSON.parse(value) as string;
        if (frame.keys.has(key)) {
          throw new SyntaxError(`Duplicate JSON key ${JSON.stringify(key)} at character ${token.index}.`);
        }
        frame.keys.add(key);
        frame.expectsKey = false;
      }
    }
  }
  return parsed;
}
