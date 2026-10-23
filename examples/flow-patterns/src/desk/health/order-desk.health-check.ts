import { HealthCheck, HealthCheckResult, type HealthCheckHandler } from "agboss";
import { seconds } from "agboss/units";
import { OrderDeskService } from "../services/order-desk.service.js";

/** Readiness of the order system the desk reads (#300): `app.checkReadiness()` runs it. */
@HealthCheck({ name: "order-desk-health-check", timeout: seconds(2), deps: [OrderDeskService] })
export class OrderDeskHealthCheck implements HealthCheckHandler {
  constructor(private readonly orderDeskService: OrderDeskService) {}

  async check(): Promise<HealthCheckResult> {
    return (await this.orderDeskService.isReachable())
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy({ reason: "the order system is unreachable" });
  }
}
