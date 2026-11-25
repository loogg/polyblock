/**
 * Shared transient codegen pass context read by both core generators and
 * declarative `.polyext.json` hat/statement generators during Pass 1 (clean export)
 * and Pass 2 (instrumented async sandbox debug).
 */
export interface CodegenPassContext {
  debugPass: boolean;
  eventDrivenMode: boolean;
  emittedDispatchEvents: Set<string>;
  pythonGlobalVarIdents: string[];
}

export const codegenContext: CodegenPassContext = {
  debugPass: false,
  eventDrivenMode: false,
  emittedDispatchEvents: new Set<string>(),
  pythonGlobalVarIdents: [],
};

export function resetCodegenPassContext(opts: {
  debugPass: boolean;
  eventDrivenMode: boolean;
  pythonGlobalVarIdents?: string[];
}): void {
  codegenContext.debugPass = opts.debugPass;
  codegenContext.eventDrivenMode = opts.eventDrivenMode;
  codegenContext.emittedDispatchEvents = new Set<string>();
  codegenContext.pythonGlobalVarIdents = opts.pythonGlobalVarIdents ?? [];
}
