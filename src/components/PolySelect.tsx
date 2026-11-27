import { Check, ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

export interface PolySelectOption<T extends string = string> {
  value: T;
  label: string;
  badge?: string;
  description?: string;
  disabled?: boolean;
}

interface PolySelectProps<T extends string = string> {
  value: T;
  options: Array<PolySelectOption<T>>;
  onChange: (nextValue: T) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  size?: 'xs' | 'sm' | 'md';
  variant?: 'default' | 'subtle';
  fullWidth?: boolean;
  className?: string;
  style?: CSSProperties;
  minPopoverWidth?: number;
}

interface PopoverCoords {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
  openUpward: boolean;
}

/**
 * Unified MicroBlocks-styled accessible select dropdown rendered in a portal so it never
 * clips inside modals or scroll panes and never falls back to unstyled OS native popups.
 */
export function PolySelect<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  disabled = false,
  size = 'sm',
  variant = 'default',
  fullWidth = false,
  className = '',
  style,
  minPopoverWidth,
}: PolySelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selectedOption =
    options.find((o) => o.value === value) ?? options[0] ?? null;

  const computeCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 5;
    const estItemHeight = 32;
    const estHeight = Math.min(268, options.length * estItemHeight + 12);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUpward = spaceBelow < estHeight && spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      120,
      Math.min(268, openUpward ? spaceAbove - gap : spaceBelow - gap),
    );
    const minW = Math.max(
      rect.width,
      minPopoverWidth ?? (size === 'xs' ? 116 : 136),
    );
    const clampedLeft = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - minW - 8),
    );
    const top = openUpward
      ? Math.max(8, rect.top - gap)
      : rect.bottom + gap;

    setCoords({
      left: clampedLeft,
      top,
      minWidth: minW,
      maxHeight,
      openUpward,
    });
  }, [options.length, minPopoverWidth, size]);

  useLayoutEffect(() => {
    if (!open) return;
    computeCoords();
  }, [open, computeCoords]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        listRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onViewportChange = () => computeCoords();

    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, options, value, computeCoords]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    );
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const commitIndex = (idx: number) => {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveIndex = (delta: number) => {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let step = 0; step < options.length; step++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };

  const handleTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        moveIndex(1);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
      } else {
        moveIndex(-1);
      }
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
    } else if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault();
      commitIndex(activeIndex);
    } else if (e.key === 'Tab' && open) {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={title}
        disabled={disabled}
        className={`poly-select-trigger size-${size} variant-${variant} ${
          fullWidth ? 'full-width' : ''
        } ${open ? 'open' : ''} ${className}`.trim()}
        style={style}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="poly-select-value">
          {selectedOption?.label ?? ''}
        </span>
        <ChevronDown size={size === 'xs' ? 12 : 13} className="poly-select-chevron" />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className={`poly-select-popover ${coords.openUpward ? 'open-upward' : ''}`}
            style={{
              left: coords.left,
              top: coords.top,
              minWidth: coords.minWidth,
              maxHeight: coords.maxHeight,
            }}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isHighlighted = idx === activeIndex;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  data-option-index={idx}
                  aria-selected={isSelected}
                  disabled={opt.disabled}
                  className={`poly-select-option ${isSelected ? 'selected' : ''} ${
                    isHighlighted ? 'highlighted' : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitIndex(idx)}
                >
                  <span className="poly-select-check">
                    {isSelected && <Check size={12.5} />}
                  </span>
                  <span className="poly-select-option-body">
                    <span className="poly-select-option-label">{opt.label}</span>
                    {opt.description && (
                      <span className="poly-select-option-desc">
                        {opt.description}
                      </span>
                    )}
                  </span>
                  {opt.badge && (
                    <span className="count-badge">{opt.badge}</span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
