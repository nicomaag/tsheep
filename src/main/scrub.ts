/**
 * Taking secret values back out of text.
 *
 * `scrub` is for whole strings. `Scrubber` is for a stream: it holds back the
 * last few characters of each chunk, long enough that a value split across two
 * chunks cannot slip through, and hands them over with the next chunk.
 */
type Known = { name: string; value: string }

export function scrub(text: string, known: Known[]): string {
  let out = text
  for (const k of known) out = out.split(k.value).join(`[secret:${k.name}]`)
  return out
}

export class Scrubber {
  private tail = ''
  private readonly hold: number

  constructor(private readonly known: Known[]) {
    this.hold = known.reduce((m, k) => Math.max(m, k.value.length), 0)
  }

  push(chunk: string): string {
    if (!this.known.length) return chunk
    const text = scrub(this.tail + chunk, this.known)
    const keep = Math.min(text.length, this.hold - 1)
    this.tail = text.slice(text.length - keep)
    return text.slice(0, text.length - keep)
  }

  flush(): string {
    const rest = this.tail
    this.tail = ''
    return rest
  }
}
