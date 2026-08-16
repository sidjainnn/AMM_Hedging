// Seedable RNG — first-class requirement (design-rules.md Q5).
// Whole sim is reproducible from one seed: market events, agent behaviour,
// fills, vol shocks all draw from RNG instances derived from the master seed.

// mulberry32: tiny, fast, good-enough statistical quality for a research sim.
export class RNG {
  private state: number;

  constructor(seed: number) {
    // force to uint32
    this.state = seed >>> 0;
  }

  // uniform [0,1)
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // uniform [min,max)
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  // integer [min,max] inclusive
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  // standard normal via Box–Muller
  normal(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + std * z;
  }

  // bernoulli
  chance(p: number): boolean {
    return this.next() < p;
  }

  // pick a random element
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // derive an independent named sub-stream so adding a new agent type
  // doesn't perturb the draw sequence of existing ones.
  derive(label: string): RNG {
    let h = this.state ^ 0x9e3779b9;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    }
    return new RNG(h >>> 0);
  }
}
