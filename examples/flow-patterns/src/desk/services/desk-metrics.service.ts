import { Injectable } from "@agboss/core";

/** Where the desk's observer counts — a metrics client in production; here, the line it would send. */
@Injectable()
export class DeskMetricsService {
  increment(metric: string, labels: Readonly<Record<string, string>>): string {
    return `${metric} ${JSON.stringify(labels)} +1`;
  }
}
