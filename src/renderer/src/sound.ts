/**
 * The sounds for "a command waits for you", made with Web Audio so no sound
 * files ship with the app.
 */
import type { AttentionSound } from '@shared/types'

let ctx: AudioContext | null = null

/** One note that fades out: frequency in Hz, start and length in seconds. */
function note(c: AudioContext, type: OscillatorType, freq: number, start: number, length: number, volume: number): void {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  const t = c.currentTime + start
  gain.gain.setValueAtTime(volume, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + length)
  osc.connect(gain).connect(c.destination)
  osc.start(t)
  osc.stop(t + length)
}

export function playSound(sound: AttentionSound): void {
  if (sound === 'none') return
  try {
    ctx ??= new AudioContext()
    void ctx.resume()
    if (sound === 'chime') {
      note(ctx, 'sine', 880, 0, 0.35, 0.25)
      note(ctx, 'sine', 1318.5, 0.16, 0.5, 0.25)
    } else if (sound === 'ping') {
      note(ctx, 'sine', 1568, 0, 0.45, 0.3)
    } else {
      note(ctx, 'triangle', 170, 0, 0.09, 0.6)
      note(ctx, 'triangle', 150, 0.17, 0.11, 0.6)
    }
  } catch {
    /* no audio device: stay silent */
  }
}
