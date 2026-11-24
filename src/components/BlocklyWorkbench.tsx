import * as Blockly from 'blockly';
import {
  Crosshair,
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
  useRef,
  useState,
} from 'react';
import {
  BLOCK_CATEGORIES,
  buildFlyoutToolbox,
  type BlockCategorySpec,
} from '../core/blocks/catalog';
import { registerPolyBlocks } from '../core/blocks/definitions';
import {
  MICRO_ZELOS_RENDERER_NAME,
  registerMicroZelosRenderer,
} from '../core/blocks/renderer';
import {
  polyblockDarkTheme,
  polyblockLightTheme,
} from '../core/blocks/themes';
import type { ThemeMode } from '../types/project';

export interface BlocklyWorkbenchHandle {
  getWorkspace: () => Blockly.WorkspaceSvg | null;
  loadWorkspaceJson: (state: Record<string, unknown>) => void;
  saveWorkspaceJson: () => Record<string, unknown>;
  focusBlock: (blockId: string) => void;
  resize: () => void;
}

interface BlocklyWorkbenchProps {
  theme: ThemeMode;
  initialWorkspace: Record<string, unknown>;
  visible: boolean;
  executingBlockId: string | null;
  isPaused: boolean;
  breakpoints: string[];
  extraCategories: BlockCategorySpec[];
  onWorkspaceChange: (workspace: Blockly.WorkspaceSvg) => void;
  onSelectBlock: (blockId: string | null) => void;
  onToggleBreakpoint: (blockId: string) => void;
  onOpenExtensionsPage: () => void;
}

// Singleton hook bridge so Blockly's global ContextMenuRegistry invokes current React callbacks
let breakpointMenuRegistered = false;
let currentToggleBpHandler: ((blockId: string) => void) | null = null;
let currentBreakpointsSet = new Set<string>();

function registerBreakpointContextMenu(): void {
  if (breakpointMenuRegistered) return;

  const menuItem: Blockly.ContextMenuRegistry.RegistryItem = {
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

  try {
    Blockly.ContextMenuRegistry.registry.register(menuItem);
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
    breakpoints,
    extraCategories,
    onWorkspaceChange,
    onSelectBlock,
    onToggleBreakpoint,
    onOpenExtensionsPage,
  },
  ref,
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const onChangeRef = useRef(onWorkspaceChange);
  const onSelectRef = useRef(onSelectBlock);
  const initialDataRef = useRef(initialWorkspace);
  const extraCatsRef = useRef<BlockCategorySpec[]>(extraCategories);

  const [activeCat, setActiveCat] = useState<string>('print');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [zoomPct, setZoomPct] = useState<number>(100);

  onChangeRef.current = onWorkspaceChange;
  onSelectRef.current = onSelectBlock;
  extraCatsRef.current = extraCategories;
  currentToggleBpHandler = onToggleBreakpoint;
  currentBreakpointsSet = new Set(breakpoints);

  const refreshFlyout = useCallback((catId: string, query: string) => {
    const ws = workspaceRef.current;
    if (!ws) return;
    const toolboxDef = buildFlyoutToolbox(ws, catId, query, extraCatsRef.current);
    ws.updateToolbox(toolboxDef);
  }, []);

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
      toolbox: buildFlyoutToolbox(null, 'print', ''),
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

    ws.registerButtonCallback('CREATE_VARIABLE', (button) => {
      Blockly.Variables.createVariableButtonHandler(
        button.getTargetWorkspace(),
        () => {
          refreshFlyout('variables', '');
        },
      );
    });

    try {
      Blockly.serialization.workspaces.load(initialDataRef.current, ws);
    } catch {
      ws.clear();
    }

    setZoomPct(Math.round(ws.getScale() * 100));
    onChangeRef.current(ws);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const listener = (event: Blockly.Events.Abstract) => {
      if (event.type === Blockly.Events.SELECTED) {
        const sel = event as Blockly.Events.Selected;
        onSelectRef.current(sel.newElementId ?? null);
        return;
      }

      if (event.type === Blockly.Events.VIEWPORT_CHANGE) {
        setZoomPct(Math.round(ws.getScale() * 100));
        return;
      }

      if (event.isUiEvent) return;

      if (
        event.type === Blockly.Events.VAR_CREATE ||
        event.type === Blockly.Events.VAR_DELETE ||
        event.type === Blockly.Events.VAR_RENAME
      ) {
        setActiveCat((curr) => {
          if (curr === 'variables') {
            setTimeout(() => refreshFlyout('variables', ''), 0);
          }
          return curr;
        });
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
      }
    });
    ro.observe(el);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      ro.disconnect();
      ws.removeChangeListener(listener);
      ws.dispose();
      workspaceRef.current = null;
    };
  }, [refreshFlyout]);

  // Sync theme updates live
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    ws.setTheme(theme === 'dark' ? polyblockDarkTheme : polyblockLightTheme);
  }, [theme]);

  // Sync category, search query, or dynamically enabled extension categories to flyout
  useEffect(() => {
    const allIds = new Set([
      ...BLOCK_CATEGORIES.map((c) => c.id),
      ...extraCategories.map((c) => c.id),
    ]);
    if (!allIds.has(activeCat)) {
      setActiveCat('print');
      return;
    }
    refreshFlyout(activeCat, searchQuery);
  }, [activeCat, searchQuery, extraCategories, refreshFlyout]);

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

  // Apply live execution glow / paused ring directly on Blockly SVG block root
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;

    const allBlocks = ws.getAllBlocks(false);
    for (const block of allBlocks) {
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
  }, [executingBlockId, isPaused]);

  // Render crisp crimson breakpoint dots directly on blocks that have breakpoints
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;
    const bpSet = new Set(breakpoints);
    const allBlocks = ws.getAllBlocks(false);

    for (const block of allBlocks) {
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
          ws.clearUndo();
          ws.scroll(0, 0);
        } finally {
          Blockly.Events.enable();
        }
      },
      saveWorkspaceJson: () => {
        const ws = workspaceRef.current;
        if (!ws) return {};
        return Blockly.serialization.workspaces.save(ws) as Record<
          string,
          unknown
        >;
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

  const handleCenter = () => {
    const ws = workspaceRef.current;
    if (!ws) return;
    ws.setScale(0.92);
    ws.scrollCenter();
    setZoomPct(92);
  };

  const handleUndo = (redo: boolean) => {
    workspaceRef.current?.undo(redo);
  };

  return (
    <div className="blockly-area">
      <nav className="cat-strip" aria-label="积木分类">
        {BLOCK_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`cat-btn ${
              !searchQuery && activeCat === cat.id ? 'active' : ''
            }`}
            style={{ '--cat-color': cat.color } as React.CSSProperties}
            onClick={() => {
              setSearchQuery('');
              setActiveCat(cat.id);
            }}
            title={cat.label}
          >
            <span className="cat-dot" />
            <span>{cat.label}</span>
          </button>
        ))}

        {extraCategories.length > 0 && <div className="cat-divider" />}

        {extraCategories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`cat-btn ${
              !searchQuery && activeCat === cat.id ? 'active' : ''
            }`}
            style={{ '--cat-color': cat.color } as React.CSSProperties}
            onClick={() => {
              setSearchQuery('');
              setActiveCat(cat.id);
            }}
            title={`扩展分类：${cat.label}`}
          >
            <span className="cat-dot" />
            <span>{cat.label}</span>
          </button>
        ))}

        <button
          type="button"
          className="cat-add-ext"
          onClick={onOpenExtensionsPage}
          title="管理或导入自定义扩展积木包"
        >
          <Puzzle size={13} />
          <span>+扩展</span>
        </button>
      </nav>

      <div className="canvas-container">
        <div className="flyout-search-dock">
          <Search size={13} />
          <input
            type="text"
            aria-label="搜索积木"
            placeholder="搜索积木 (打印 / 等待 / 循环)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
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

        <div className="blockly-mount" ref={mountRef} />

        <div className="canvas-controls" aria-label="画布视图控制">
          <button
            type="button"
            className="canvas-ctrl-btn"
            onClick={() => handleUndo(false)}
            title="撤销 (Ctrl+Z)"
            aria-label="撤销"
          >
            <Undo2 size={13} />
          </button>
          <button
            type="button"
            className="canvas-ctrl-btn"
            onClick={() => handleUndo(true)}
            title="重做 (Ctrl+Y)"
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
