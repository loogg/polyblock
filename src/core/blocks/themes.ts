import * as Blockly from 'blockly';

const BLOCK_STYLES: Record<string, Partial<Blockly.Theme.BlockStyle>> = {
  event_blocks: {
    colourPrimary: '#e0911f',
    colourSecondary: '#c77c14',
    colourTertiary: '#b36b0e',
    hat: 'cap',
  },
  event_stmt_blocks: {
    colourPrimary: '#e0911f',
    colourSecondary: '#c77c14',
    colourTertiary: '#b36b0e',
  },
  timer_hat_blocks: {
    colourPrimary: '#6366f1',
    colourSecondary: '#4f46e5',
    colourTertiary: '#4338ca',
    hat: 'cap',
  },
  timer_blocks: {
    colourPrimary: '#6366f1',
    colourSecondary: '#4f46e5',
    colourTertiary: '#4338ca',
  },
  control_blocks: {
    colourPrimary: '#d97706',
    colourSecondary: '#b45309',
    colourTertiary: '#9a4408',
  },
  print_blocks: {
    colourPrimary: '#0d9488',
    colourSecondary: '#0f766e',
    colourTertiary: '#115e59',
  },
  variable_blocks: {
    colourPrimary: '#db2777',
    colourSecondary: '#be185d',
    colourTertiary: '#9d174d',
  },
  math_blocks: {
    colourPrimary: '#16a34a',
    colourSecondary: '#15803d',
    colourTertiary: '#166534',
  },
  logic_blocks: {
    colourPrimary: '#2563eb',
    colourSecondary: '#1d4ed8',
    colourTertiary: '#1e40af',
  },
  text_blocks: {
    colourPrimary: '#0891b2',
    colourSecondary: '#0e7490',
    colourTertiary: '#155e75',
  },
  list_blocks: {
    colourPrimary: '#7c3aed',
    colourSecondary: '#6d28d9',
    colourTertiary: '#5b21b6',
  },
  procedure_blocks: {
    colourPrimary: '#4f46e5',
    colourSecondary: '#4338ca',
    colourTertiary: '#3730a3',
  },
  loop_blocks: {
    colourPrimary: '#d97706',
    colourSecondary: '#b45309',
    colourTertiary: '#9a4408',
  },
};

export const polyblockLightTheme = Blockly.Theme.defineTheme('polyblockLight', {
  name: 'polyblockLight',
  base: Blockly.Themes.Zelos,
  blockStyles: BLOCK_STYLES,
  componentStyles: {
    workspaceBackgroundColour: '#f5f7fb',
    toolboxBackgroundColour: '#f8fafc',
    toolboxForegroundColour: '#334155',
    flyoutBackgroundColour: '#f8fafc',
    flyoutForegroundColour: '#334155',
    flyoutOpacity: 1,
    scrollbarColour: '#cbd5e1',
    scrollbarOpacity: 0.7,
    insertionMarkerColour: '#4f46e5',
    insertionMarkerOpacity: 0.35,
    cursorColour: '#4f46e5',
  },
  fontStyle: {
    family: '"Inter", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
    weight: '600',
    size: 12,
  },
  startHats: true,
});

export const polyblockDarkTheme = Blockly.Theme.defineTheme('polyblockDark', {
  name: 'polyblockDark',
  base: Blockly.Themes.Zelos,
  blockStyles: BLOCK_STYLES,
  componentStyles: {
    workspaceBackgroundColour: '#11151e',
    toolboxBackgroundColour: '#161b26',
    toolboxForegroundColour: '#cbd5e1',
    flyoutBackgroundColour: '#161b26',
    flyoutForegroundColour: '#cbd5e1',
    flyoutOpacity: 1,
    scrollbarColour: '#36435e',
    scrollbarOpacity: 0.75,
    insertionMarkerColour: '#818cf8',
    insertionMarkerOpacity: 0.45,
    cursorColour: '#818cf8',
  },
  fontStyle: {
    family: '"Inter", "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
    weight: '600',
    size: 12,
  },
  startHats: true,
});
