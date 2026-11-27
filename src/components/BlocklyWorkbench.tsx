import * as Blockly from 'blockly';
import {
  Crosshair,
  LayoutGrid,
  Lock,
  Minus,
  Plus,
  Puzzle,
  Redo2,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  buildFlyoutToolbox,
  DEFAULT_EXTENSION_TOOLBOX_ORDER,
  getOrderedToolboxCategories,
  type BlockCategorySpec,
} from '../core/blocks/catalog';
import { ChannelIdFieldDropdown } from '../core/blocks/channelField';
import { registerPolyBlocks } from '../core/blocks/definitions';
import { OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK } from '../core/extensions/registry';
import {
  MICRO_ZELOS_RENDERER_NAME,
  registerMicroZelosRenderer,
} from '../core/blocks/renderer';
import {
  polyblockDarkTheme,
  polyblockLightTheme,
} from '../core/blocks/themes';
import {
  formatChannelLabel,
  getActiveChannelPoolConfig,
  getActiveHandleSharedFunctions,
  registerChannelAliasPromptHandler,
  setActiveChannelPoolConfigs,
  setActiveProjectCapabilities,
  type ChannelAliasPromptRequest,
} from '../core/blocks/workspaceContextBridge';
import type { ChannelPoolConfig, ThemeMode } from '../types/project';
import type {
  HandleVariableMutation,
  VariableScopeKind,
} from '../core/projects/handleVariables';

function findChannelFieldOnBlock(
  blk: Blockly.Block | undefined | null,
): ChannelIdFieldDropdown | null {
  if (!blk) return null;
  for (const input of blk.inputList) {
    for (const field of input.fieldRow) {
      if (field instanceof ChannelIdFieldDropdown) {
        return field;
      }
    }
  }
  return null;
}

/**
 * Arranges all top-level blocks into clean, strictly non-overlapping columns
 * using their real rendered bounding dimensions (`getHeightWidth()`).
 */
function arrangeTopBlocksCleanly(ws: Blockly.WorkspaceSvg, undoable = true): void {
  const tops = ws
    .getTopBlocks(true)
    .filter((b) => !b.isShadow()) as Blockly.BlockSvg[];
  if (tops.length <= 1) return;

  const colCount = tops.length <= 2 ? 1 : tops.length <= 6 ? 2 : 3;
  const perCol = Math.ceil(tops.length / colCount);
  const gapX = 68;
  const gapY = 48;
  const startX = 36;
  const startY = 28;

  const columns: Blockly.BlockSvg[][] = Array.from({ length: colCount }, () => []);
  tops.forEach((blk, idx) => {
    const colIdx = Math.min(colCount - 1, Math.floor(idx / perCol));
    columns[colIdx].push(blk);
  });

  if (undoable) {
    Blockly.Events.setGroup(true);
  }
  try {
    let cursorX = startX;
    for (const col of columns) {
      let cursorY = startY;
      let maxColWidth = 0;
      for (const blk of col) {
        const hw = blk.getHeightWidth();
        const xy = blk.getRelativeToSurfaceXY();
        const dx = cursorX - xy.x;
        const dy = cursorY - xy.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          blk.moveBy(dx, dy);
        }
        cursorY += hw.height + gapY;
        maxColWidth = Math.max(maxColWidth, hw.width);
      }
      cursorX += maxColWidth + gapX;
    }
  } finally {
    if (undoable) {
      Blockly.Events.setGroup(false);
    }
  }
}

/**
 * Checks whether any two top-level blocks overlap after loading; if and only if
 * an actual intersection exists, cleanly separates them via `arrangeTopBlocksCleanly`.
 */
function declutterIfOverlapping(ws: Blockly.WorkspaceSvg): void {
  const tops = ws
    .getTopBlocks(true)
    .filter((b) => !b.isShadow()) as Blockly.BlockSvg[];
  if (tops.length <= 1) return;

  const rects = tops.map((blk) => {
    const xy = blk.getRelativeToSurfaceXY();
    const hw = blk.getHeightWidth();
    return {
      left: xy.x,
      top: xy.y,
      right: xy.x + hw.width,
      bottom: xy.y + hw.height,
    };
  });

  let hasOverlap = false;
  for (let i = 0; i < rects.length && !hasOverlap; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 2 && overlapY > 2) {
        hasOverlap = true;
        break;
      }
    }
  }

  if (hasOverlap) {
    arrangeTopBlocksCleanly(ws, false);
  }
}

export type HandleFunctionMutation =
  | { kind: 'rename'; oldName: string; newName: string }
  | { kind: 'delete'; name: string };

export interface BlocklyWorkbenchHandle {
  getWorkspace: () => Blockly.WorkspaceSvg | null;
  loadWorkspaceJson: (state: Record<string, unknown>) => void;
  saveWorkspaceJson: () => Record<string, unknown>;
  createVariable: (name: string, scope: VariableScopeKind) => void;
  createProcedure: (name: string, hasReturn: boolean) => void;
  refreshToolbox: () => void;
  focusBlock: (blockId: string) => void;
  resize: () => void;
}

interface BlocklyWorkbenchProps {
  theme: ThemeMode;
  initialWorkspace: Record<string, unknown>;
  visible: boolean;
  executingBlockId: string | null;
  isPaused: boolean;
  readOnlyLocked?: boolean;
  readOnlyLabel?: string;
  breakpoints: string[];
  enabledCapabilities: string[];
  extraCategories: BlockCategorySpec[];
  channelPoolConfigs: Record<string, ChannelPoolConfig>;
  onWorkspaceChange: (workspace: Blockly.WorkspaceSvg) => void;
  onHandleVariableEvent?: (mutation: HandleVariableMutation) => void;
  onRequestCreateVariable?: (initialScope: VariableScopeKind) => void;
  onRequestCreateFunction?: (initialScope: VariableScopeKind) => void;
  onToggleSharedFunction?: (fnName: string) => void;
  onHandleFunctionEvent?: (mutation: HandleFunctionMutation) => void;
  onSelectBlock: (blockId: string | null) => void;
  onToggleBreakpoint: (blockId: string) => void;
  onEditChannelAlias: (req: ChannelAliasPromptRequest) => void;
  onOpenHandleTimerSettings: () => void;
  onOpenExtensionsPage: () => void;
}

// Singleton hook bridge so Blockly's global ContextMenuRegistry invokes current React callbacks
let breakpointMenuRegistered = false;
let currentToggleBpHandler: ((blockId: string) => void) | null = null;
let currentEditAliasHandler: ((req: ChannelAliasPromptRequest) => void) | null = null;
let currentToggleSharedFnHandler: ((fnName: string) => void) | null = null;
let currentBreakpointsSet = new Set<string>();
let currentReadOnlyLocked = false;

function applyWorkspaceReadOnlyLock(
  ws: Blockly.WorkspaceSvg,
  locked: boolean,
): void {
  for (const blk of ws.getAllBlocks(false)) {
    if (!blk.isShadow()) {
      blk.setMovable(!locked);
      blk.setDeletable(!locked);
    }
    blk.setEditable(!locked);
  }
}

function syncExecutionHighlightClasses(
  ws: Blockly.WorkspaceSvg,
  executingBlockId: string | null,
  isPaused: boolean,
): void {
  for (const block of ws.getAllBlocks(false)) {
    const root = (block as Blockly.BlockSvg).getSvgRoot?.();
    if (!root) continue;
    root.classList.remove('pb-block-executing', 'pb-block-paused');
  }
  if (executingBlockId) {
    const target = ws.getBlockById(executingBlockId) as Blockly.BlockSvg | null;
    const root = target?.getSvgRoot?.();
    if (root) {
      root.classList.add(isPaused ? 'pb-block-paused' : 'pb-block-executing');
    }
  }
}

function syncBreakpointDots(
  ws: Blockly.WorkspaceSvg,
  breakpoints: string[],
): void {
  const bpSet = new Set(breakpoints);
  for (const block of ws.getAllBlocks(false)) {
    const root = (block as Blockly.BlockSvg).getSvgRoot?.();
    if (!root) continue;
    const existing = root.querySelector(':scope > circle.pb-bp-dot');
    const hasBp = bpSet.has(block.id);
    if (hasBp && !existing) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('class', 'pb-bp-dot');
      dot.setAttribute('cx', '1');
      dot.setAttribute('cy', '15');
      dot.setAttribute('r', '5.5');
      root.appendChild(dot);
    } else if (!hasBp && existing) {
      existing.remove();
    }
  }
}

function registerBreakpointContextMenu(): void {
  if (breakpointMenuRegistered) return;

  const bpMenuItem: Blockly.ContextMenuRegistry.RegistryItem = {
    id: 'polyblock_toggle_breakpoint',
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -5,
    displayText: (scope) => {
      const id = scope.block?.id;
      return id && currentBreakpointsSet.has(id)
        ? '取消此积木断点'
        : '在此积木设置断点';
    },
    preconditionFn: (scope) => {
      const blk = scope.block;
      if (!blk || blk.isInFlyout || !blk.previousConnection) {
        return 'hidden';
      }
      return 'enabled';
    },
    callback: (scope) => {
      if (scope.block?.id) {
        currentToggleBpHandler?.(scope.block.id);
      }
    },
  };

  const aliasMenuItem: Blockly.ContextMenuRegistry.RegistryItem = {
    id: 'polyblock_edit_channel_alias',
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -6,
    displayText: (scope) => {
      const field = findChannelFieldOnBlock(scope.block);
      if (!field) return '设置通道别名...';
      const cid = Math.trunc(Number(field.getValue() ?? 0));
      const cfg = getActiveChannelPoolConfig(field.configKey, field.defaultCount);
      const label = formatChannelLabel(cid, cfg, field.prefix);
      return label.includes('·')
        ? `修改 ${label} 别名...`
        : `设置${field.poolLabel} ${field.prefix}${cid} 别名...`;
    },
    preconditionFn: (scope) => {
      const blk = scope.block;
      if (
        currentReadOnlyLocked ||
        !blk ||
        blk.isInFlyout ||
        !findChannelFieldOnBlock(blk)
      ) {
        return 'hidden';
      }
      return 'enabled';
    },
    callback: (scope) => {
      const field = findChannelFieldOnBlock(scope.block);
      if (!field) return;
      const cid = Math.trunc(Number(field.getValue() ?? 0));
      if (Number.isInteger(cid) && cid >= 0) {
        currentEditAliasHandler?.({
          configKey: field.configKey,
          channelId: cid,
          prefix: field.prefix,
          label: field.poolLabel,
        });
      }
    },
  };

  const extractSingleMenuItem: Blockly.ContextMenuRegistry.RegistryItem = {
    id: 'polyblock_extract_single_block',
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -4,
    displayText: () => '仅抽出此积木 (Ctrl+拖)',
    preconditionFn: (scope) => {
      const blk = scope.block;
      if (
        currentReadOnlyLocked ||
        !blk ||
        blk.isInFlyout ||
        !blk.previousConnection ||
        !blk.nextConnection
      ) {
        return 'hidden';
      }
      if (!blk.previousConnection.isConnected() && !blk.nextConnection.isConnected()) {
        return 'hidden';
      }
      return 'enabled';
    },
    callback: (scope) => {
      const blk = scope.block as Blockly.BlockSvg | undefined;
      if (!blk) return;
      Blockly.Events.setGroup(true);
      try {
        blk.unplug(true);
        blk.moveBy(28, 18);
      } finally {
        Blockly.Events.setGroup(false);
      }
    },
  };

  const toggleSharedFnMenuItem: Blockly.ContextMenuRegistry.RegistryItem = {
    id: 'polyblock_toggle_shared_function',
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: -5.5,
    displayText: (scope) => {
      const fnName = String(scope.block?.getFieldValue('NAME') || '').trim();
      const isShared = (getActiveHandleSharedFunctions() ?? []).includes(fnName);
      return isShared
        ? '转为本文件私有函数（仅本脚本可用）'
        : '设为跨文件公共函数（归入 shared 模块）';
    },
    preconditionFn: (scope) => {
      const blk = scope.block;
      if (
        currentReadOnlyLocked ||
        !blk ||
        blk.isInFlyout ||
        (blk.type !== 'procedures_defnoreturn' && blk.type !== 'procedures_defreturn')
      ) {
        return 'hidden';
      }
      return 'enabled';
    },
    callback: (scope) => {
      const fnName = String(scope.block?.getFieldValue('NAME') || '').trim();
      if (fnName) {
        currentToggleSharedFnHandler?.(fnName);
      }
    },
  };

  try {
    Blockly.ContextMenuRegistry.registry.register(bpMenuItem);
  } catch {
    // Already registered in HMR
  }
  try {
    Blockly.ContextMenuRegistry.registry.register(toggleSharedFnMenuItem);
  } catch {
    // Already registered in HMR
  }
  try {
    Blockly.ContextMenuRegistry.registry.register(aliasMenuItem);
  } catch {
    // Already registered in HMR
  }
  try {
    Blockly.ContextMenuRegistry.registry.register(extractSingleMenuItem);
  } catch {
    // Already registered in HMR
  }
  breakpointMenuRegistered = true;
}

export const BlocklyWorkbench = forwardRef<
  BlocklyWorkbenchHandle,
  BlocklyWorkbenchProps
>(function BlocklyWorkbench(
  {
    theme,
    initialWorkspace,
    visible,
    executingBlockId,
    isPaused,
    readOnlyLocked = false,
    readOnlyLabel,
    breakpoints,
    enabledCapabilities,
    extraCategories,
    channelPoolConfigs,
    onWorkspaceChange,
    onHandleVariableEvent,
    onRequestCreateVariable,
    onRequestCreateFunction,
    onToggleSharedFunction,
    onHandleFunctionEvent,
    onSelectBlock,
    onToggleBreakpoint,
    onEditChannelAlias,
    onOpenHandleTimerSettings,
    onOpenExtensionsPage,
  },
  ref,
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const onChangeRef = useRef(onWorkspaceChange);
  const onHandleVarRef = useRef(onHandleVariableEvent);
  const onRequestCreateVarRef = useRef(onRequestCreateVariable);
  const onRequestCreateFnRef = useRef(onRequestCreateFunction);
  const onHandleFnRef = useRef(onHandleFunctionEvent);
  const suppressedCreateNamesRef = useRef<Set<string>>(new Set());
  const onSelectRef = useRef(onSelectBlock);
  const onOpenTimerCfgRef = useRef(onOpenHandleTimerSettings);
  const initialDataRef = useRef(initialWorkspace);
  const enabledCapsRef = useRef<string[]>(enabledCapabilities);
  const extraCatsRef = useRef<BlockCategorySpec[]>(extraCategories);
  const readOnlyLockedRef = useRef<boolean>(readOnlyLocked);
  const executingBlockIdRef = useRef<string | null>(executingBlockId);
  const isPausedRef = useRef<boolean>(isPaused);
  const breakpointsRef = useRef<string[]>(breakpoints);
  const effectiveFlyoutCollapsedRef = useRef<boolean>(false);

  const [activeCat, setActiveCat] = useState<string>('print');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [flyoutCollapsed, setFlyoutCollapsed] = useState<boolean>(false);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [flyoutWidth, setFlyoutWidth] = useState<number>(230);
  const activeCatRef = useRef<string>(activeCat);
  const searchQueryRef = useRef<string>(searchQuery);
  const lastScaleRef = useRef<number>(0.92);

  activeCatRef.current = activeCat;
  searchQueryRef.current = searchQuery;

  const syncFlyoutWidth = useCallback((ws: Blockly.WorkspaceSvg | null) => {
    if (!ws) return;
    const rawW = ws.getFlyout()?.getWidth?.();
    if (typeof rawW === 'number' && Number.isFinite(rawW) && rawW > 40) {
      setFlyoutWidth(Math.round(rawW));
    }
  }, []);

  const orderedCategories = useMemo(
    () => getOrderedToolboxCategories(enabledCapabilities, extraCategories),
    [enabledCapabilities, extraCategories],
  );

  onChangeRef.current = onWorkspaceChange;
  onHandleVarRef.current = onHandleVariableEvent;
  onRequestCreateVarRef.current = onRequestCreateVariable;
  onRequestCreateFnRef.current = onRequestCreateFunction;
  onHandleFnRef.current = onHandleFunctionEvent;
  onSelectRef.current = onSelectBlock;
  onOpenTimerCfgRef.current = onOpenHandleTimerSettings;
  enabledCapsRef.current = enabledCapabilities;
  extraCatsRef.current = extraCategories;
  currentToggleBpHandler = onToggleBreakpoint;
  currentEditAliasHandler = onEditChannelAlias;
  currentToggleSharedFnHandler = onToggleSharedFunction ?? null;
  registerChannelAliasPromptHandler(onEditChannelAlias);
  currentBreakpointsSet = new Set(breakpoints);
  currentReadOnlyLocked = readOnlyLocked;
  readOnlyLockedRef.current = readOnlyLocked;
  executingBlockIdRef.current = executingBlockId;
  isPausedRef.current = isPaused;
  breakpointsRef.current = breakpoints;

  // Auto-collapse unusable toolbox flyout while running/paused to maximize viewing canvas space
  const effectiveFlyoutCollapsed = flyoutCollapsed || readOnlyLocked;
  effectiveFlyoutCollapsedRef.current = effectiveFlyoutCollapsed;

  const refreshFlyout = useCallback(
    (catId: string, query: string) => {
      const ws = workspaceRef.current;
      if (!ws) return;
      const toolboxDef = buildFlyoutToolbox(
        ws,
        catId,
        query,
        extraCatsRef.current,
        enabledCapsRef.current,
      );
      ws.updateToolbox(toolboxDef);
      if (effectiveFlyoutCollapsedRef.current) {
        ws.getFlyout()?.setVisible(false);
        Blockly.svgResize(ws);
      } else {
        requestAnimationFrame(() => syncFlyoutWidth(ws));
      }
    },
    [syncFlyoutWidth],
  );

  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    effectiveFlyoutCollapsedRef.current = effectiveFlyoutCollapsed;
    ws.getFlyout()?.setVisible(!effectiveFlyoutCollapsed);
    Blockly.svgResize(ws);
    if (effectiveFlyoutCollapsed && executingBlockIdRef.current) {
      ws.centerOnBlock(executingBlockIdRef.current);
    } else {
      ws.scroll(0, 0);
    }
  }, [effectiveFlyoutCollapsed]);

  // Initialize Blockly workspace once
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    registerMicroZelosRenderer();
    registerPolyBlocks();
    registerBreakpointContextMenu();

    const ws = Blockly.inject(el, {
      renderer: MICRO_ZELOS_RENDERER_NAME,
      theme: theme === 'dark' ? polyblockDarkTheme : polyblockLightTheme,
      media: './blockly-media/',
      toolbox: buildFlyoutToolbox(
        null,
        'print',
        '',
        extraCatsRef.current,
        enabledCapsRef.current,
      ),
      grid: {
        spacing: 18,
        length: 0,
        colour: 'transparent',
        snap: true,
      },
      zoom: {
        controls: false,
        wheel: true,
        startScale: 0.92,
        maxScale: 1.6,
        minScale: 0.5,
        scaleSpeed: 1.12,
      },
      move: {
        scrollbars: true,
        drag: true,
        wheel: true,
      },
      trashcan: true,
      sounds: false,
    });

    workspaceRef.current = ws;

    // Ensure Blockly MetricsManager reports flyout width=0 whenever collapsed (manual or runtime read-only)
    // so scroll(0, 0), scrollCenter(), and centerOnBlock() use the full dot-grid canvas with zero phantom margin.
    const metricsMgr = ws.getMetricsManager();
    const origGetFlyoutMetrics = metricsMgr.getFlyoutMetrics.bind(metricsMgr);
    metricsMgr.getFlyoutMetrics = (own?: boolean) => {
      const m = origGetFlyoutMetrics(own);
      return effectiveFlyoutCollapsedRef.current ? { ...m, width: 0 } : m;
    };

    ws.registerButtonCallback('CREATE_SHARED_VARIABLE', () => {
      if (readOnlyLockedRef.current) return;
      if (onRequestCreateVarRef.current) {
        onRequestCreateVarRef.current('shared');
      } else {
        Blockly.Variables.createVariableButtonHandler(ws, () => {
          refreshFlyout('variables', '');
        });
      }
    });

    ws.registerButtonCallback('CREATE_FILE_VARIABLE', () => {
      if (readOnlyLockedRef.current) return;
      if (onRequestCreateVarRef.current) {
        onRequestCreateVarRef.current('file');
      } else {
        Blockly.Variables.createVariableButtonHandler(ws, () => {
          refreshFlyout('variables', '');
        });
      }
    });

    ws.registerButtonCallback('CREATE_VARIABLE', () => {
      if (readOnlyLockedRef.current) return;
      if (onRequestCreateVarRef.current) {
        onRequestCreateVarRef.current('file');
      } else {
        Blockly.Variables.createVariableButtonHandler(ws, () => {
          refreshFlyout('variables', '');
        });
      }
    });

    ws.registerButtonCallback('CREATE_SHARED_FUNCTION', () => {
      if (readOnlyLockedRef.current) return;
      onRequestCreateFnRef.current?.('shared');
    });

    ws.registerButtonCallback('CREATE_PRIVATE_FUNCTION', () => {
      if (readOnlyLockedRef.current) return;
      onRequestCreateFnRef.current?.('file');
    });

    ws.registerButtonCallback(OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK, () => {
      if (readOnlyLockedRef.current) return;
      onOpenTimerCfgRef.current();
    });

    try {
      Blockly.Events.disable();
      try {
        Blockly.serialization.workspaces.load(initialDataRef.current, ws);
        declutterIfOverlapping(ws);
      } finally {
        Blockly.Events.enable();
      }
    } catch {
      ws.clear();
    }

    lastScaleRef.current = ws.getScale();
    setZoomPct(Math.round(ws.getScale() * 100));
    requestAnimationFrame(() => syncFlyoutWidth(ws));
    onChangeRef.current(ws);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let zoomRafId: number | null = null;

    const listener = (event: Blockly.Events.Abstract) => {
      if (event.type === Blockly.Events.SELECTED) {
        const sel = event as Blockly.Events.Selected;
        onSelectRef.current(sel.newElementId ?? null);
        return;
      }

      if (event.type === Blockly.Events.VIEWPORT_CHANGE) {
        const nextScale = ws.getScale();
        setZoomPct(Math.round(nextScale * 100));
        if (Math.abs(nextScale - lastScaleRef.current) > 0.005) {
          lastScaleRef.current = nextScale;
          if (zoomRafId !== null) cancelAnimationFrame(zoomRafId);
          zoomRafId = requestAnimationFrame(() => {
            zoomRafId = null;
            refreshFlyout(activeCatRef.current, searchQueryRef.current);
          });
        }
        return;
      }

      if (event.isUiEvent) return;

      if (event.type === Blockly.Events.VAR_CREATE) {
        const ve = event as Blockly.Events.VarCreate;
        if (ve.varName && !suppressedCreateNamesRef.current.delete(ve.varName)) {
          onHandleVarRef.current?.({
            kind: 'create',
            name: ve.varName,
            scope: 'file',
          });
        }
        setActiveCat((curr) => {
          if (curr === 'variables') {
            setTimeout(() => refreshFlyout('variables', ''), 0);
          }
          return curr;
        });
      } else if (event.type === Blockly.Events.VAR_RENAME) {
        const ve = event as Blockly.Events.VarRename;
        if (ve.oldName && ve.newName) {
          onHandleVarRef.current?.({
            kind: 'rename',
            oldName: ve.oldName,
            newName: ve.newName,
          });
        }
        setActiveCat((curr) => {
          if (curr === 'variables') {
            setTimeout(() => refreshFlyout('variables', ''), 0);
          }
          return curr;
        });
      } else if (event.type === Blockly.Events.VAR_DELETE) {
        const ve = event as Blockly.Events.VarDelete;
        if (ve.varName) {
          onHandleVarRef.current?.({ kind: 'delete', name: ve.varName });
        }
        setActiveCat((curr) => {
          if (curr === 'variables') {
            setTimeout(() => refreshFlyout('variables', ''), 0);
          }
          return curr;
        });
      } else if (event.type === Blockly.Events.BLOCK_CHANGE) {
        const ce = event as Blockly.Events.BlockChange;
        const blk = ce.blockId ? ws.getBlockById(ce.blockId) : null;
        if (
          blk &&
          (blk.type === 'procedures_defnoreturn' || blk.type === 'procedures_defreturn')
        ) {
          if (
            ce.element === 'field' &&
            ce.name === 'NAME' &&
            typeof ce.oldValue === 'string' &&
            typeof ce.newValue === 'string' &&
            ce.oldValue.trim() &&
            ce.newValue.trim() &&
            ce.oldValue.trim() !== ce.newValue.trim()
          ) {
            onHandleFnRef.current?.({
              kind: 'rename',
              oldName: ce.oldValue.trim(),
              newName: ce.newValue.trim(),
            });
          }
          if (activeCatRef.current === 'functions') {
            setTimeout(() => refreshFlyout('functions', ''), 0);
          }
        }
      } else if (event.type === Blockly.Events.BLOCK_DELETE) {
        const de = event as Blockly.Events.BlockDelete;
        const oldJson = de.oldJson as
          | { type?: string; fields?: { NAME?: string } }
          | undefined;
        if (
          oldJson &&
          (oldJson.type === 'procedures_defnoreturn' ||
            oldJson.type === 'procedures_defreturn')
        ) {
          const fnName = String(oldJson.fields?.NAME ?? '').trim();
          if (fnName) {
            onHandleFnRef.current?.({ kind: 'delete', name: fnName });
          }
          if (activeCatRef.current === 'functions') {
            setTimeout(() => refreshFlyout('functions', ''), 0);
          }
        }
      } else if (event.type === Blockly.Events.BLOCK_CREATE) {
        const cre = event as Blockly.Events.BlockCreate;
        const blk = cre.blockId ? ws.getBlockById(cre.blockId) : null;
        if (
          blk &&
          (blk.type === 'procedures_defnoreturn' ||
            blk.type === 'procedures_defreturn') &&
          activeCatRef.current === 'functions'
        ) {
          setTimeout(() => refreshFlyout('functions', ''), 0);
        }
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        onChangeRef.current(ws);
      }, 60);
    };

    ws.addChangeListener(listener);

    const ro = new ResizeObserver(() => {
      if (workspaceRef.current) {
        Blockly.svgResize(workspaceRef.current);
        syncFlyoutWidth(workspaceRef.current);
      }
    });
    ro.observe(el);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (zoomRafId !== null) cancelAnimationFrame(zoomRafId);
      ro.disconnect();
      ws.removeChangeListener(listener);
      ws.dispose();
      workspaceRef.current = null;
    };
  }, [refreshFlyout, syncFlyoutWidth]);

  // Sync theme updates live
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    ws.setTheme(theme === 'dark' ? polyblockDarkTheme : polyblockLightTheme);
  }, [theme]);

  // Sync per-handle channel pool counts & aliases across ALL ChannelIdFieldDropdown blocks
  useEffect(() => {
    setActiveChannelPoolConfigs(channelPoolConfigs);
    const ws = workspaceRef.current;
    if (!ws) return;
    for (const blk of ws.getAllBlocks(false)) {
      for (const input of blk.inputList) {
        for (const field of input.fieldRow) {
          if (field instanceof ChannelIdFieldDropdown) {
            field.getOptions(false);
            field.forceRerender();
          }
        }
      }
    }
    refreshFlyout(activeCat, searchQuery);
  }, [channelPoolConfigs, activeCat, searchQuery, refreshFlyout]);

  // Sync category, search query, enabled capabilities, or extension categories to flyout
  useEffect(() => {
    setActiveProjectCapabilities(enabledCapabilities);
    const allIds = new Set(orderedCategories.map((c) => c.id));
    if (!allIds.has(activeCat)) {
      setActiveCat('print');
      return;
    }
    refreshFlyout(activeCat, searchQuery);
  }, [
    activeCat,
    searchQuery,
    enabledCapabilities,
    orderedCategories,
    refreshFlyout,
  ]);

  // Resize cleanly whenever blocks page becomes visible again
  useEffect(() => {
    if (!visible || !workspaceRef.current) return;
    const id = requestAnimationFrame(() => {
      if (workspaceRef.current) {
        Blockly.svgResize(workspaceRef.current);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // Sync runtime read-only debug lock without destroying workspace or losing pan/zoom
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    if (readOnlyLocked) {
      ws.hideChaff();
    }
    applyWorkspaceReadOnlyLock(ws, readOnlyLocked);
  }, [readOnlyLocked]);

  // Apply live execution glow / paused ring directly on Blockly SVG block root
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    syncExecutionHighlightClasses(ws, executingBlockId, isPaused);
  }, [executingBlockId, isPaused]);

  // Render crisp crimson breakpoint dots directly on blocks that have breakpoints
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    syncBreakpointDots(ws, breakpoints);
  }, [breakpoints, executingBlockId]);

  useImperativeHandle(
    ref,
    () => ({
      getWorkspace: () => workspaceRef.current,
      loadWorkspaceJson: (state) => {
        const ws = workspaceRef.current;
        if (!ws) return;
        Blockly.Events.disable();
        try {
          ws.clear();
          Blockly.serialization.workspaces.load(state, ws);
          declutterIfOverlapping(ws);
          if (readOnlyLockedRef.current) {
            applyWorkspaceReadOnlyLock(ws, true);
          }
          ws.clearUndo();
          ws.scroll(0, 0);
        } finally {
          Blockly.Events.enable();
        }
        syncBreakpointDots(ws, breakpointsRef.current);
        syncExecutionHighlightClasses(
          ws,
          executingBlockIdRef.current,
          isPausedRef.current,
        );
        refreshFlyout(activeCatRef.current, searchQueryRef.current);
        ws.scroll(0, 0);
      },
      saveWorkspaceJson: () => {
        const ws = workspaceRef.current;
        if (!ws) return {};
        return Blockly.serialization.workspaces.save(ws) as Record<
          string,
          unknown
        >;
      },
      createVariable: (name: string, _scope: VariableScopeKind) => {
        const ws = workspaceRef.current;
        const trimmed = name.trim();
        if (!ws || !trimmed) return;
        suppressedCreateNamesRef.current.add(trimmed);
        ws.getVariableMap().createVariable(trimmed);
        refreshFlyout(activeCatRef.current, searchQueryRef.current);
      },
      createProcedure: (name: string, hasReturn: boolean) => {
        const ws = workspaceRef.current;
        const trimmed = name.trim();
        if (!ws || !trimmed) return;
        const blockType = hasReturn
          ? 'procedures_defreturn'
          : 'procedures_defnoreturn';
        const tops = ws
          .getTopBlocks(true)
          .filter((b) => !b.isShadow()) as Blockly.BlockSvg[];
        let targetX = 36;
        let targetY = 36;
        if (tops.length > 0) {
          let maxBottom = 28;
          for (const top of tops) {
            const xy = top.getRelativeToSurfaceXY();
            const hw = top.getHeightWidth();
            maxBottom = Math.max(maxBottom, xy.y + hw.height);
          }
          targetX = 36;
          targetY = maxBottom + 44;
        }
        Blockly.Events.setGroup(true);
        let created: Blockly.BlockSvg | null = null;
        try {
          created = ws.newBlock(blockType) as Blockly.BlockSvg;
          created.setFieldValue(trimmed, 'NAME');
          created.initSvg();
          created.render();
          created.moveBy(targetX, targetY);
        } finally {
          Blockly.Events.setGroup(false);
        }
        if (created) {
          Blockly.common.setSelected(created);
          ws.centerOnBlock(created.id);
          onSelectRef.current(created.id);
        }
        refreshFlyout(activeCatRef.current, searchQueryRef.current);
        onChangeRef.current(ws);
      },
      refreshToolbox: () => {
        refreshFlyout(activeCatRef.current, searchQueryRef.current);
      },
      focusBlock: (blockId: string) => {
        const ws = workspaceRef.current;
        if (!ws) return;
        const block = ws.getBlockById(blockId);
        if (!block) return;
        Blockly.common.setSelected(block);
        ws.centerOnBlock(blockId);
        onSelectRef.current(blockId);
      },
      resize: () => {
        if (workspaceRef.current) {
          Blockly.svgResize(workspaceRef.current);
        }
      },
    }),
    [],
  );

  const handleZoom = (delta: number) => {
    const ws = workspaceRef.current;
    if (!ws) return;
    ws.zoomCenter(delta);
    setZoomPct(Math.round(ws.getScale() * 100));
  };

  const handleArrangeBlocks = () => {
    if (readOnlyLocked) return;
    const ws = workspaceRef.current;
    if (!ws) return;
    arrangeTopBlocksCleanly(ws, true);
    ws.scroll(0, 0);
  };

  const handleCenter = () => {
    const ws = workspaceRef.current;
    if (!ws) return;
    ws.setScale(0.92);
    ws.scrollCenter();
    setZoomPct(92);
  };

  const handleUndo = (redo: boolean) => {
    if (readOnlyLocked) return;
    workspaceRef.current?.undo(redo);
  };

  const handleCanvasKeyDownCapture = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!readOnlyLocked) return;
    const k = e.key.toLowerCase();
    const isMod = e.ctrlKey || e.metaKey;
    if (
      k === 'delete' ||
      k === 'backspace' ||
      (isMod && (k === 'z' || k === 'y' || k === 'x' || k === 'v' || k === 'd'))
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleMountContextMenuCapture = (
    e: React.MouseEvent<HTMLDivElement>,
  ) => {
    if (!readOnlyLocked) return;
    const targetEl = e.target instanceof Element ? e.target : null;
    // Allow right-clicking blocks (to toggle breakpoints), but suppress empty-canvas mutating menu
    if (!targetEl?.closest('.blocklyDraggable')) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const firstExtIdx = orderedCategories.findIndex(
    (c) => c.order >= DEFAULT_EXTENSION_TOOLBOX_ORDER,
  );

  return (
    <div className="blockly-area">
      <nav
        className={`cat-strip ${readOnlyLocked ? 'readonly-locked' : ''}`}
        aria-label="积木分类"
      >
        {orderedCategories.map((cat, idx) => (
          <div key={cat.id} style={{ display: 'contents' }}>
            {firstExtIdx > 0 && idx === firstExtIdx && (
              <div className="cat-divider" />
            )}
            <button
              type="button"
              disabled={readOnlyLocked}
              className={`cat-btn ${
                !searchQuery && !flyoutCollapsed && activeCat === cat.id
                  ? 'active'
                  : ''
              }`}
              style={{ '--cat-color': cat.color } as React.CSSProperties}
              aria-pressed={!searchQuery && !flyoutCollapsed && activeCat === cat.id}
              onClick={() => {
                if (!searchQuery && activeCat === cat.id) {
                  setFlyoutCollapsed((prev) => !prev);
                } else {
                  setSearchQuery('');
                  setActiveCat(cat.id);
                  setFlyoutCollapsed(false);
                }
              }}
              title={
                readOnlyLocked
                  ? '运行中画布已只读锁定（请先停止再拖入积木）'
                  : `${cat.isExtension ? '扩展分类：' : ''}${cat.label}（分类序 #${cat.order} · 再次点击可收起抽屉）`
              }
            >
              <span className="cat-dot" />
              <span>{cat.label}</span>
            </button>
          </div>
        ))}

        <button
          type="button"
          className="cat-add-ext"
          onClick={onOpenExtensionsPage}
          title="查看或管理自定义扩展积木包"
        >
          <Puzzle size={13} />
          <span>+扩展</span>
        </button>
      </nav>

      <div
        className={`canvas-container ${effectiveFlyoutCollapsed ? 'flyout-collapsed' : ''} ${
          readOnlyLocked ? 'readonly-locked' : ''
        }`}
        onKeyDownCapture={handleCanvasKeyDownCapture}
      >
        {readOnlyLocked && (
          <div
            className="canvas-readonly-badge"
            role="status"
            title="运行中画布已只读锁定：禁止拖拽或修改积木；仍可自由切换脚本/句柄、缩放平移、点选代码对行或右键增删断点"
          >
            <Lock size={11} style={{ flexShrink: 0 }} />
            <span>{readOnlyLabel ?? '运行中 · 只读'}</span>
          </div>
        )}

        {!effectiveFlyoutCollapsed && (
          <div
            className={`flyout-search-dock ${flyoutWidth < 185 ? 'compact' : ''}`}
            style={{
              width: Math.max(96, Math.min(248, flyoutWidth - 16)),
            }}
          >
            <Search size={flyoutWidth < 185 ? 11 : 13} style={{ flexShrink: 0 }} />
            <input
              type="text"
              aria-label="搜索积木"
              disabled={readOnlyLocked}
              placeholder={
                readOnlyLocked
                  ? '运行中只读'
                  : flyoutWidth < 185
                    ? '搜索积木'
                    : '搜索积木 (打印 / 等待 / 循环)'
              }
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (flyoutCollapsed) setFlyoutCollapsed(false);
              }}
            />
            {searchQuery && !readOnlyLocked && (
              <button
                type="button"
                className="flyout-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="清除搜索"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <div
          className="blockly-mount"
          ref={mountRef}
          onContextMenuCapture={handleMountContextMenuCapture}
        />

        <div className="canvas-controls" aria-label="画布视图控制">
          <button
            type="button"
            className="canvas-ctrl-btn"
            disabled={readOnlyLocked}
            onClick={() => handleUndo(false)}
            title={readOnlyLocked ? '运行中画布只读' : '撤销 (Ctrl+Z)'}
            aria-label="撤销"
          >
            <Undo2 size={13} />
          </button>
          <button
            type="button"
            className="canvas-ctrl-btn"
            disabled={readOnlyLocked}
            onClick={() => handleUndo(true)}
            title={readOnlyLocked ? '运行中画布只读' : '重做 (Ctrl+Y)'}
            aria-label="重做"
          >
            <Redo2 size={13} />
          </button>
          <span className="canvas-ctrl-sep" />
          <button
            type="button"
            className="canvas-ctrl-btn"
            onClick={() => handleZoom(-1)}
            title="缩小画布"
            aria-label="缩小画布"
          >
            <Minus size={13} />
          </button>
          <span
            style={{
              minWidth: 38,
              textAlign: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-secondary)',
            }}
          >
            {zoomPct}%
          </span>
          <button
            type="button"
            className="canvas-ctrl-btn"
            onClick={() => handleZoom(1)}
            title="放大画布"
            aria-label="放大画布"
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="canvas-ctrl-btn"
            disabled={readOnlyLocked}
            onClick={handleArrangeBlocks}
            title={
              readOnlyLocked ? '运行中画布只读' : '自动整理画布积木（消除重叠）'
            }
          >
            <LayoutGrid size={12} />
            <span>整理</span>
          </button>
          <button
            type="button"
            className="canvas-ctrl-btn"
            onClick={handleCenter}
            title="居中并重置缩放"
          >
            <Crosshair size={12} />
            <span>居中</span>
          </button>
        </div>
      </div>
    </div>
  );
});
