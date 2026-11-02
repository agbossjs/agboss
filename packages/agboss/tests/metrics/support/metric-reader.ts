import type { Attributes } from "@opentelemetry/api";
import { MeterProvider, MetricReader, type MetricData } from "@opentelemetry/sdk-metrics";

/**
 * #485 — an in-memory OpenTelemetry reader (AC5): what a Prometheus scrape or an OTLP export reads,
 * collected on demand. One per instance (`testWith(App, { meterProviders })`).
 */
export class InMemoryMetricReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** One instance's provider and its reader. */
export interface InstanceMeter {
  readonly provider: MeterProvider;
  readonly reader: InMemoryMetricReader;
}

export function instanceMeter(): InstanceMeter {
  const reader = new InMemoryMetricReader();
  return { provider: new MeterProvider({ readers: [reader] }), reader };
}

/** `count` instances' meters. */
export const instanceMeters = (count: number): readonly InstanceMeter[] =>
  Array.from({ length: count }, () => instanceMeter());

/** One point of a metric: its labels and value. */
export interface MetricPoint {
  readonly attributes: Attributes;
  readonly value: number;
}

/** A collection: each metric by name, with its descriptor and points. */
export type Collected = ReadonlyMap<
  string,
  { readonly data: MetricData; readonly points: readonly MetricPoint[] }
>;

/** Collects now (every observable callback runs); fails on a collection error. */
export async function collect(meter: InstanceMeter): Promise<Collected> {
  const { resourceMetrics, errors } = await meter.reader.collect();
  if (errors.length > 0) throw new Error(`collection failed: ${String(errors[0])}`);
  const collected = new Map<string, { data: MetricData; points: MetricPoint[] }>();
  for (const scope of resourceMetrics.scopeMetrics)
    for (const data of scope.metrics)
      collected.set(data.descriptor.name, {
        data,
        points: data.dataPoints.map((point) => ({
          attributes: point.attributes,
          value: typeof point.value === "number" ? point.value : Number.NaN,
        })),
      });
  return collected;
}

/** A metric's value with exactly these labels (none: the unlabelled point); absent → undefined. */
export function valueOf(
  collected: Collected,
  name: string,
  attributes: Attributes = {},
): number | undefined {
  const wanted = JSON.stringify(Object.entries(attributes).sort());
  return collected
    .get(name)
    ?.points.find((point) => JSON.stringify(Object.entries(point.attributes).sort()) === wanted)
    ?.value;
}

/** The sum of a metric's points (every label set); 0 when absent. */
export const totalOf = (collected: Collected, name: string): number =>
  (collected.get(name)?.points ?? []).reduce((sum, point) => sum + point.value, 0);

/** The values of one metric over the instances' collections (absent → undefined). */
export const acrossInstances = (
  collections: readonly Collected[],
  name: string,
): (number | undefined)[] => collections.map((collected) => valueOf(collected, name));

/** Every instance's collection, at once. */
export const collectAll = (meters: readonly InstanceMeter[]): Promise<Collected[]> =>
  Promise.all(meters.map((meter) => collect(meter)));
