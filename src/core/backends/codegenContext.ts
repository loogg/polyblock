import type * as Blockly from 'blockly';

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

const PY_VAR_WRITE_BLOCK_TYPES = new Set<string>([
  'variables_set',
  'math_change',
  'poly_for_range',
  'controls_for',
  'controls_forEach',
]);

/**
 * Generates a precise Python `  global a, b\n` declaration ONLY for workspace global variables
 * that are actually assigned/rebound inside the given hat block BODY (and strictly excludes the
 * callback's own formal parameter names to prevent `SyntaxError: name 'x' is parameter and global`).
 */
export function buildPythonGlobalLineForBlocks(
  hatBlocks: Blockly.Block[],
  generator: { getVariableName(id: string): string },
  excludeParams: string[] = [],
): string {
  if (codegenContext.pythonGlobalVarIdents.length === 0) return '';
  const paramSet = new Set(excludeParams);
  const mutatedIdents = new Set<string>();

  for (const hat of hatBlocks) {
    const bodyRoot = hat.getInputTargetBlock('BODY');
    if (!bodyRoot) continue;
    for (const blk of bodyRoot.getDescendants(false)) {
      if (blk.isShadow() || !blk.isEnabled()) continue;
      if (!PY_VAR_WRITE_BLOCK_TYPES.has(blk.type)) continue;
      const varId = blk.getFieldValue('VAR');
      if (!varId) continue;
      const ident = generator.getVariableName(String(varId));
      if (ident && !paramSet.has(ident)) {
        mutatedIdents.add(ident);
      }
    }
  }

  const ordered = codegenContext.pythonGlobalVarIdents.filter((ident) =>
    mutatedIdents.has(ident),
  );
  if (ordered.length === 0) return '';
  return `  global ${ordered.join(', ')}\n`;
}
