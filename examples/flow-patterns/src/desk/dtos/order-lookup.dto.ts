import { Text } from "agboss/dto";

/** What `order-status-tool` takes: the order to look up. */
export class OrderLookupDto {
  @Text({ prompt: "the order's id, without #" })
  orderId!: string;
}

/** What `order-status-tool` gives: where the order is. */
export class OrderStatusDto {
  @Text({ prompt: "where the order is" })
  status!: string;
}
