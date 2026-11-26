/**
 * #1324 (24.1): `TurnFor` finds a channel interpreter by its `ComponentKind`, not by a name suffix:
 * a default-named `RefundChannelInterpreter` and one named `refund-reader` both take the interpreter's turns.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { ReplyInterpreterTurnFor, TurnFor } from "../../src/testing/script-types.js";
import {
  NamedRefundReader,
  PayoutReplyInterpreter,
  RefundChannelInterpreter,
  TreasurerAgent,
} from "../flow/fixtures/replies.fixture.js";

describe("#1324: TurnFor by the kind of a channel interpreter", () => {
  it("a default-named interpreter takes the interpreter's turns", () => {
    expectTypeOf<TurnFor<RefundChannelInterpreter>>().toEqualTypeOf<
      ReplyInterpreterTurnFor<RefundChannelInterpreter>
    >();
  });

  it("an interpreter named by hand takes them too", () => {
    expectTypeOf<TurnFor<NamedRefundReader>>().toEqualTypeOf<
      ReplyInterpreterTurnFor<NamedRefundReader>
    >();
  });

  it("an interpreter with the 0.1.0 suffix still does; an agent does not", () => {
    expectTypeOf<TurnFor<PayoutReplyInterpreter>>().toEqualTypeOf<
      ReplyInterpreterTurnFor<PayoutReplyInterpreter>
    >();
    expectTypeOf<TurnFor<TreasurerAgent>>().not.toEqualTypeOf<
      ReplyInterpreterTurnFor<TreasurerAgent>
    >();
  });
});
