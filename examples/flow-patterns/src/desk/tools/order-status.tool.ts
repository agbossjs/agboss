import { Tool, type ToolHandler } from "@agboss/core";
import { OrderLookupDto, OrderStatusDto } from "../dto/order-lookup.dto.js";
import { OrderDeskService } from "../services/order-desk.service.js";

/** Looks an order up. */
@Tool({
  name: "order-status-tool",
  description: "Where an order is",
  input: OrderLookupDto,
  output: OrderStatusDto,
  deps: [OrderDeskService],
})
export class OrderStatusTool implements ToolHandler<OrderLookupDto, OrderStatusDto> {
  constructor(private readonly orderDeskService: OrderDeskService) {}

  async run({ orderId }: OrderLookupDto): Promise<OrderStatusDto> {
    return { status: await this.orderDeskService.statusOf(orderId) };
  }
}
