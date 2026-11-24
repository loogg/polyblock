import * as Blockly from 'blockly';

/**
 * MicroZelosRenderer:
 * Subclasses Blockly's modern Zelos renderer and tightens padding, block height,
 * notch geometry, and corner radii to mirror MicroBlocks' crisp, compact aesthetic.
 */
class MicroZelosConstantProvider extends Blockly.zelos.ConstantProvider {
  constructor() {
    super();

    this.GRID_UNIT = 4;
    this.CORNER_RADIUS = 7;
    this.NOTCH_WIDTH = 24;
    this.NOTCH_HEIGHT = 4;
    this.NOTCH_OFFSET_LEFT = 14;
    this.MIN_BLOCK_HEIGHT = 30;
    this.MIN_BLOCK_WIDTH = 44;
    this.EMPTY_STATEMENT_INPUT_HEIGHT = 24;
    this.TOP_ROW_MIN_HEIGHT = 6;
    this.BOTTOM_ROW_MIN_HEIGHT = 6;
    this.MEDIUM_PADDING = 6;
    this.SMALL_PADDING = 4;
    this.LARGE_PADDING = 10;
    this.FIELD_TEXT_FONTSIZE = 12;
    this.FIELD_TEXT_FONTWEIGHT = '600';
    this.FIELD_TEXT_FONTFAMILY =
      '"Inter", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
    this.FIELD_BORDER_RECT_RADIUS = 10;
    this.FIELD_BORDER_RECT_HEIGHT = 22;
    this.START_HAT_HEIGHT = 18;
    this.START_HAT_WIDTH = 92;
  }
}

class MicroZelosRenderer extends Blockly.zelos.Renderer {
  constructor(name: string) {
    super(name);
  }

  protected override makeConstants_(): Blockly.zelos.ConstantProvider {
    return new MicroZelosConstantProvider();
  }
}

export const MICRO_ZELOS_RENDERER_NAME = 'micro_zelos';

let rendererRegistered = false;

export function registerMicroZelosRenderer(): void {
  if (rendererRegistered) return;
  Blockly.blockRendering.register(MICRO_ZELOS_RENDERER_NAME, MicroZelosRenderer);
  rendererRegistered = true;
}
