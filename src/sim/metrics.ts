/** One point of the live time series shown in the analytics panel. */
export interface Sample {
  t: number;
  vehicles: number;
  queued: number;
  /** Mean speed of vehicles in the network (km/h). */
  speed: number;
  /** Completed trips per hour over the recent window. */
  throughput: number;
  /** Mean delay (s) of trips completed in the recent window. */
  delay: number;
}

/** Trips completed within this many seconds feed the "recent" figures. */
const RECENT = 300;
const SAMPLE_EVERY = 5;
const MAX_SAMPLES = 2000;

export class Metrics {
  /** Totals since the start of the measurement window (reset after an experiment's warm-up). */
  trips = 0;
  travelSum = 0;
  delaySum = 0;
  stopsSum = 0;
  windowStart = 0;
  incidents = 0;
  readonly incidentLog: string[] = [];
  readonly samples: Sample[] = [];
  private recent: { t: number; delay: number }[] = [];
  private nextSample = SAMPLE_EVERY;

  recordTrip(t: number, travel: number, delay: number, stops: number): void {
    this.trips++;
    this.travelSum += travel;
    this.delaySum += delay;
    this.stopsSum += stops;
    this.recent.push({ t, delay });
  }

  recordIncident(message: string): void {
    this.incidents++;
    this.incidentLog.push(message);
    if (this.incidentLog.length > 20) this.incidentLog.shift();
  }

  resetWindow(t: number): void {
    this.trips = 0;
    this.travelSum = 0;
    this.delaySum = 0;
    this.stopsSum = 0;
    this.windowStart = t;
  }

  get meanDelay(): number {
    return this.trips === 0 ? 0 : this.delaySum / this.trips;
  }

  get meanTravel(): number {
    return this.trips === 0 ? 0 : this.travelSum / this.trips;
  }

  get meanStops(): number {
    return this.trips === 0 ? 0 : this.stopsSum / this.trips;
  }

  /** Completed trips per hour over the measurement window. */
  windowThroughput(t: number): number {
    const span = t - this.windowStart;
    return span <= 0 ? 0 : (this.trips / span) * 3600;
  }

  private trim(t: number): void {
    let i = 0;
    while (i < this.recent.length && this.recent[i].t < t - RECENT) i++;
    if (i > 0) this.recent = this.recent.slice(i);
  }

  recentThroughput(t: number): number {
    this.trim(t);
    const span = Math.min(RECENT, t);
    return span <= 0 ? 0 : (this.recent.length / span) * 3600;
  }

  recentDelay(t: number): number {
    this.trim(t);
    if (this.recent.length === 0) return 0;
    let sum = 0;
    for (const r of this.recent) sum += r.delay;
    return sum / this.recent.length;
  }

  maybeSample(t: number, vehicles: number, queued: number, speedKmh: number): void {
    if (t < this.nextSample) return;
    this.nextSample += SAMPLE_EVERY;
    this.samples.push({
      t,
      vehicles,
      queued,
      speed: speedKmh,
      throughput: this.recentThroughput(t),
      delay: this.recentDelay(t),
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }
}
