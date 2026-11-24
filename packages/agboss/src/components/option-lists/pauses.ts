/** The keys of the pause targets, channels, and the application's observers, calendars and health checks: each list is held equal to `keyof` its options type (see `option-keys.ts`). */
import type { ChannelInterpreterOptions } from "../../channels/channel-interpreter.js";
import type { ChannelSelectorOptions } from "../../channels/channel-selector.js";
import type { ExternalTaskOptions, ToolApprovalOptions } from "../../channels/pause-targets.js";
import type { ObserverOptions } from "../../core/observer-hooks.js";
import type { HealthCheckOptions } from "../../health/health-check.js";
import type { ChannelListenerOptions } from "../../pause/channel-listener.js";
import type { WorkingCalendarOptions } from "../../calendar/working-calendar.js";
import type { ChannelOptions } from "../decorators.js";
import { optionKeys } from "../option-keys.js";

export const TOOL_APPROVAL_KEYS = optionKeys<ToolApprovalOptions>()([
  "name",
  "description",
  "respondent",
  "timeout",
  "calendar",
  "remindBefore",
  "escalationLimits",
  "escalatesTo",
  "channelInterpreter",
  "deps",
  "input",
  "output",
  "maxVisits",
]);

export const EXTERNAL_TASK_KEYS = optionKeys<ExternalTaskOptions>()([
  "name",
  "description",
  "respondent",
  "timeout",
  "calendar",
  "remindBefore",
  "escalationLimits",
  "escalatesTo",
  "channelInterpreter",
  "deps",
  "input",
  "output",
  "maxVisits",
]);

export const CHANNEL_KEYS = optionKeys<ChannelOptions>()([
  "name",
  "description",
  "deps",
  "target",
  "ttl",
  "timeout",
]);

export const CHANNEL_SELECTOR_KEYS = optionKeys<ChannelSelectorOptions>()([
  "name",
  "description",
  "target",
  "deps",
]);

export const CHANNEL_LISTENER_KEYS = optionKeys<ChannelListenerOptions>()([
  "name",
  "description",
  "deps",
  "includePauseIds",
]);

export const CHANNEL_INTERPRETER_KEYS = optionKeys<ChannelInterpreterOptions>()([
  "name",
  "description",
  "model",
  "modelProvider",
  "prompt",
  "promptVariables",
  "deps",
]);

export const WORKING_CALENDAR_KEYS = optionKeys<WorkingCalendarOptions>()([
  "name",
  "description",
  "timeout",
  "week",
  "deps",
]);

export const OBSERVER_KEYS = optionKeys<ObserverOptions>()([
  "name",
  "description",
  "workflows",
  "agents",
  "deps",
]);

export const HEALTH_CHECK_KEYS = optionKeys<HealthCheckOptions>()([
  "name",
  "description",
  "timeout",
  "deps",
]);
