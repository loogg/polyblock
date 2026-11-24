import * as Blockly from 'blockly';
import {
  Crosshair,
  Minus,
  Plus,
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
  onWorkspaceChange: (workspace: Blockly.WorkspaceSvg) => void;
  onSelectBlock: (blockId: string | null) => void;
}

export const BlocklyWorkbench = forwardRef<
  BlocklyWorkbenchHandle,
  BlocklyWorkbenchProps
>(function BlocklyWorkbench(
  { theme, initialWorkspace, visible, onWorkspaceChange, onSelectBlock },
  ref,
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const onChangeRef = useRef(onWorkspaceChange);
  const onSelectRef = useRef(onSelectBlock);
  const initialDataRef = useRef(initialWorkspace);

  const [activeCat, setActiveCat] = useState<string>('print');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [zoomPct, setZoomPct] = useState<number>(100);

  onChangeRef.current = onWorkspaceChange;
  onSelectRef.current = onSelectBlock;

  const refreshFlyout = useCallback(
    (catId: string, query: string) => {
      const ws = workspaceRef.current;
      if (!ws) return;
      const toolboxDef = buildFlyoutToolbox(ws, catId, query);
      ws.updateToolbox(toolboxDef);
    },
    [],
  );

  // Initialize Blockly workspace once
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    registerMicroZelosRenderer();
    registerPolyBlocks();

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

    // Load initial workspace state safely
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
        // Keep variable flyout fresh if open
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

  // Sync category or search query to flyout
  useEffect(() => {
    refreshFlyout(activeCat, searchQuery);
  }, [activeCat, searchQuery, refreshFlyout]);

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

  useImperativeHandle(
    ref,
    () => ({
      getWorkspace: () => workspaceRef.current,
      loadWorkspaceJson: (state) => {
        const ws = workspaceRef.current;
        if (!ws) return;
        ws.clear();
        Blockly.serialization.workspaces.load(state, ws);
        ws.scrollCenter();
        onChangeRef.current(ws);
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
      {/* MicroBlocks-style Category Dot Strip */}
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
      </nav>

      {/* Main Dot-Grid Blockly Workspace + Docked Flyout Search + Zoom Bar */}
      <div className="canvas-container">
        <div className="flyout-search-dock">
          <Search size={13} />
          <input
            type="text"
            aria-label="搜索积木"
            placeholder="搜索积木 (打印 / 循环 / 列表)"
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
