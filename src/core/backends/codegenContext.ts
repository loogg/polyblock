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
  /** Auto-generated cross-file shared state module name (e.g. 'shared'), empty when unused. */
  pythonSharedModuleName: string;
  /** Map of current-workspace Blockly variable ID -> shared module attribute name. */
  pythonSharedVarIdToAttr: Map<string, string>;
  /** Sanitized local Blockly identifiers belonging to the shared module (excluded from `<v> = None` & `global`). */
  pythonSharedVarIdents: Set<string>;
  /** Sanitized identifiers of variables actively referenced by enabled blocks in the current workspace. */
  pythonUsedVarIdents: Set<string> | null;
}

export const codegenContext: CodegenPassContext = {
  debugPass: false,
  eventDrivenMode: false,
  emittedDispatchEvents: new Set<string>(),
  pythonGlobalVarIdents: [],
  pythonSharedModuleName: '',
  pythonSharedVarIdToAttr: new Map<string, string>(),
  pythonSharedVarIdents: new Set<string>(),
  pythonUsedVarIdents: null,
};

export function resetCodegenPassContext(opts: {
  debugPass: boolean;
  eventDrivenMode: boolean;
  pythonGlobalVarIdents?: string[];
  pythonSharedModuleName?: string;
  pythonSharedVarIdToAttr?: Map<string, string>;
  pythonSharedVarIdents?: Set<string>;
  pythonUsedVarIdents?: Set<string> | null;
}): void {
  codegenContext.debugPass = opts.debugPass;
  codegenContext.eventDrivenMode = opts.eventDrivenMode;
  codegenContext.emittedDispatchEvents = new Set<string>();
  codegenContext.pythonGlobalVarIdents = opts.pythonGlobalVarIdents ?? [];
  codegenContext.pythonSharedModuleName = opts.pythonSharedModuleName ?? '';
  codegenContext.pythonSharedVarIdToAttr = new Map(
    opts.pythonSharedVarIdToAttr ?? [],
  );
  codegenContext.pythonSharedVarIdents = new Set(
    opts.pythonSharedVarIdents ?? [],
  );
  codegenContext.pythonUsedVarIdents =
    opts.pythonUsedVarIdents !== undefined ? opts.pythonUsedVarIdents : null;
}

/**
 * Resolves a Python variable reference for a block field (`VAR` / `LIST`):
 * - If the variable is shadowed by an enclosing custom procedure's formal parameter, keeps bare local ident.
 * - If the variable belongs to the handle's cross-file shared module (`shared.py`), emits `shared.<attr>`.
 * - Otherwise returns the standard Blockly Python variable identifier.
 */
export function formatPythonVarRef(
  varId: string,
  generator: { getVariableName(id: string): string },
  block?: Blockly.Block,
): string {
  const sharedMod = codegenContext.pythonSharedModuleName;
  const sharedAttr = sharedMod
    ? codegenContext.pythonSharedVarIdToAttr.get(varId)
    : undefined;
  if (sharedMod && sharedAttr) {
    if (block) {
      const model = block.workspace?.getVariableMap()?.getVariableById(varId);
      const rawName = model?.getName();
      if (rawName) {
        let cur: Blockly.Block | null = block;
        while (cur) {
          if (
            cur.type === 'procedures_defnoreturn' ||
            cur.type === 'procedures_defreturn'
          ) {
            const proc = cur as Blockly.Block & {
              getProcedureDef?: () => [string, string[], boolean];
            };
            const def = proc.getProcedureDef?.();
            if (def && Array.isArray(def[1]) && def[1].includes(rawName)) {
              return generator.getVariableName(varId);
            }
          }
          cur = cur.getSurroundParent();
        }
      }
    }
    return `${sharedMod}.${sharedAttr}`;
  }
  return generator.getVariableName(varId);
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
      if (codegenContext.pythonSharedVarIdToAttr.has(String(varId))) continue;
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
