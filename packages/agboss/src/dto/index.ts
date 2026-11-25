/**
 * `@agboss/core/dto` — data shapes as classes, one field decorator per field (Wiki → Components,
 * Standard DTOs). zod stays inside the framework.
 */
import "../polyfills/symbol-metadata.js";

export {
  Bool,
  CountryCode,
  CurrencyCode,
  DecimalString,
  Email,
  Enum,
  Float,
  Integer,
  IsoDate,
  IsoDateTime,
  IsoDuration,
  KeyText,
  List,
  MediaType,
  Nested,
  PhoneNumber,
  Text,
  TimeZone,
  Url,
  Uuid,
  Validate,
  type ListItem,
} from "./decorators.js";
export {
  DtoError,
  DtoValidationError,
  type DtoValidationErrorOptions,
  type DtoErrorCode,
  type DtoErrorOptions,
  type DtoIssue,
} from "./errors.js";
export { maskDto } from "./redact.js";
export { jsonSchemaOf, validate } from "./schema.js";
export type {
  DtoCheck,
  DtoClass,
  FieldDecorator,
  FieldFactory,
  FieldOptions,
  OptionalField,
  RequiredField,
  Sensitivity,
  ValidationIssue,
} from "./types.js";
export {
  NoInputDto,
  PlainTextDto,
  ReplyInterpreterNotUnderstoodDto,
  ToolCallApprovalAskDto,
  ToolCallApprovalDecisionDto,
  WorkflowFinishTextDto,
  WorkflowPauseAnswerDto,
  WorkflowPauseQuestionDto,
  WorkflowStartTextDto,
} from "./standard/framework.js";
export {
  File,
  FileDto,
  FilePayloadSource,
  WorkflowFinishFileDto,
  WorkflowFinishFilesDto,
  type FileDtoOptions,
  type FileFieldOptions,
} from "./standard/file.js";
export {
  AddressDto,
  ContactInfoDto,
  DateRangeDto,
  DateTimeRangeDto,
  MoneyDto,
  PersonNameDto,
} from "./standard/domain.js";
export { type EnumOptions, type ListOptions } from "./decorators.js";
export { type ToolArguments } from "./standard/framework.js";
export {
  type DecimalStringLimits,
  type KeyTextOptions,
  type NumberLimits,
  type TextLimits,
} from "./types.js";
/** @beta Type machinery of the DTO decorators and wrappers: not a contract, names may change. */
export type * as DtoTypes from "./dto-types.js";
export { ValidationError, ValidationErrorKind } from "../core/error-families/effect-errors.js";
