export type {
  WorkbookIR,
  PageIR,
  ParamIR,
  DashboardIR,
  ChartIR,
  ChartConfig,
  InteractionConfig,
  SQLParam,
  ScheduleIR,
  NotificationIR,
  AlertIR,
  FilterIR,
  FilterOptionConfig,
  LayoutIR,
  LayoutItemIR,
  DigestIR,
  NarrativeIR,
} from './ir-nodes.js';

export { lowerProgram, lowerWorkbookProgram, resolveRefs, type RefResolutionResult, type LoweringOptions } from './lowering.js';
