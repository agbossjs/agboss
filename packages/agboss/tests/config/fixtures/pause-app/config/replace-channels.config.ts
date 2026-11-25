import { defineConfig } from "../../../../../src/index.js";
import {
  DeskRefundChannel,
  InboxSpendingLimitChannel,
} from "../../../../channels/pause-targets.fixture.js";

/** The application's channels, listed again in another order: a class list replaces the declared one. */
export default defineConfig({ channels: [DeskRefundChannel, InboxSpendingLimitChannel] });
