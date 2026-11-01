/**
 * `@agboss/core/dto` — data shapes as classes, one field decorator per field (Wiki → Components,
 * Standard DTOs). zod stays inside the framework.
 */
import "../polyfills/symbol-metadata.js";

export {
  CountryCode,
  CurrencyCode,
  Date,
  DateTime,
  Decimal,
  DecimalString,
  Duration,
  Email,
  Flag,
  Integer,
  ListOf,
  MediaType,
  Nested,
  OneOf,
  PhoneNumber,
  Text,
  TimeZone,
  Url,
  Uuid,
  type ListItem,
} from "./decorators.js";
export { DtoError, DtoValidationError, type DtoErrorCode, type DtoIssue } from "./errors.js";
export type {
  DtoClass,
  FieldDecorator,
  FieldFactory,
  FieldOptions,
  OptionalField,
  RequiredField,
  Sensitivity,
} from "./types.js";
export {
  NoInputDto,
  PlainTextDto,
  RagSearchResultDto,
  ReplyInterpreterNotUnderstoodDto,
  ToolCallApprovalAskDto,
  ToolCallApprovalDecisionDto,
  WorkflowFinishTextDto,
  WorkflowPauseAnswerDto,
  WorkflowPauseQuestionDto,
  WorkflowStartTextDto,
} from "./standard/framework.js";
export {
  AddressDto,
  AttachmentDto,
  ContactInfoDto,
  DateRangeDto,
  DateTimeRangeDto,
  MoneyDto,
  PersonNameDto,
  RagSourceReferenceDto,
} from "./standard/domain.js";
/** The DTO wrappers of the flow (#272): the same values as the root entry's. */
export {
  historyOf,
  isVariant,
  listOf,
  oneOf,
  optional,
  variant,
  type HistoryOf,
  type HistoryOptions,
  type HistoryWrapper,
  type ListWrapper,
  type OneOfWrapper,
  type OptionalWrapper,
  type OutputShape,
  type Produced,
  type ProducedValue,
  type ValueOf,
  type ValueShape,
  type Variant,
  type VariantOf,
} from "../flow/dto-wrappers.js";
