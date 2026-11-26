import { BookOpen, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CORE_TOOLBOX_ORDERS } from '../core/blocks/catalog';

interface ExtensionSpecModalProps {
  onClose: () => void;
}

type SpecTab = 'pack' | 'sections' | 'blocks' | 'sim';

export function ExtensionSpecModal({ onClose }: ExtensionSpecModalProps) {
  const [tab, setTab] = useState<SpecTab>('pack');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="扩展包协议与字段说明"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-shell spec-modal">
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookOpen size={16} style={{ color: 'var(--accent)' }} />
            <span className="modal-title">.polyext.json 扩展包协议与全字段速查</span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="关闭扩展包规范弹窗"
            style={{ padding: '4px 6px' }}
          >
            <X size={15} />
          </button>
        </div>

        <div className="spec-tab-bar" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pack'}
            className={`spec-tab-btn ${tab === 'pack' ? 'active' : ''}`}
            onClick={() => setTab('pack')}
          >
            1. 顶层结构与模块源码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sections'}
            className={`spec-tab-btn ${tab === 'sections' ? 'active' : ''}`}
            onClick={() => setTab('sections')}
          >
            2. 组件 sections 与句柄配置
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'blocks'}
            className={`spec-tab-btn ${tab === 'blocks' ? 'active' : ''}`}
            onClick={() => setTab('blocks')}
          >
            3. 积木 blocks 与 kind 分类
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sim'}
            className={`spec-tab-btn ${tab === 'sim' ? 'active' : ''}`}
            onClick={() => setTab('sim')}
          >
            4. 模拟控件与 VS Code 快捷编写
          </button>
        </div>

        <div className="spec-modal-body">
          {tab === 'pack' && (
            <div className="spec-section">
              <p className="spec-lead">
                采用<strong>一模块一扩展包、单轨 <code>sections[]</code></strong>架构：纯真机导出包只需填基础必填项，模拟控件与沙箱模块均按需选填。
              </p>
              <table className="spec-table">
                <thead>
                  <tr>
                    <th>字段名</th>
                    <th>必填</th>
                    <th>说明与默认值</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>format</code> / <code>version</code></td>
                    <td>必填</td>
                    <td>固定为 <code>"polyblock-extension"</code> 与 <code>1</code>。</td>
                  </tr>
                  <tr>
                    <td><code>id</code> / <code>name</code></td>
                    <td>必填</td>
                    <td>唯一包标识（2~48 位字母/数字/<code>-</code>/<code>_</code>）与中文展示名。</td>
                  </tr>
                  <tr>
                    <td><code>iconLabel</code> / <code>color</code></td>
                    <td>可选</td>
                    <td>卡片角标缩写（默认取首个 section 的 label）与主题色（默认 <code>#6366f1</code>）。</td>
                  </tr>
                  <tr>
                    <td><code>imports</code></td>
                    <td>可选</td>
                    <td>
                      包级默认顶部导入（<code>{`{ lua: [...], python: [...] }`}</code>），普通/表达式积木自动继承并在文件顶部<strong>按内容全局去重</strong>。纯语法包不填。
                    </td>
                  </tr>
                  <tr>
                    <td><code>sections</code></td>
                    <td>必填</td>
                    <td>至少 1 个组件；单组件包写 1 项即可，多组件包（如 <code>rt</code>）自动支持按组件细粒度裁剪。</td>
                  </tr>
                  <tr>
                    <td><code>sandboxMock</code></td>
                    <td>可选</td>
                    <td>
                      <strong>仅浏览器沙箱假桩</strong>（模拟真机 C 固件 API，如 <code>board</code> / <code>i2c</code>），<strong>真机 .zip 打包导出时严格剥离</strong>。单包内 <code>moduleName</code> 不可与 <code>libs[]</code> 同名。
                    </td>
                  </tr>
                  <tr>
                    <td><code>libs</code></td>
                    <td>可选</td>
                    <td>
                      <strong>真实纯脚本库源码数组</strong>（支持多文件如 <code>crc16.lua</code> + <code>crc16_table.lua</code>，可选 <code>role: "entry" | "helper"</code>）：既在浏览器沙箱直接运行真实现，也在打包导出真机 <code>.zip</code> 时随行输出。建议直接用「导入脚本库 (.lua/.py)」或卡片回形针按钮自动写入，无需手写 JSON 转义。
                    </td>
                  </tr>
                  <tr>
                    <td><code>simWidgets</code></td>
                    <td>可选</td>
                    <td>包内共享模拟控件资产表；仅在配置了 <code>sandboxMock</code> 或非空 <code>libs[]</code> 时生效，并按已启用积木的 <code>simWidgetKeys</code> 自动过滤显示。</td>
                  </tr>
                </tbody>
              </table>

              <h4 className="spec-subhead">模块查找优先级（纯 3 层作用域）与冲突规则</h4>
              <div className="spec-tip-box">
                <div>
                  <strong>唯一查找顺序：</strong>
                  <code>1. 当前句柄脚本</code> &gt; <code>2. 项目内嵌包</code> &gt; <code>3. 全局扩展包（预装 rt/board 与用户包平级）</code>。项目内嵌包可用任意包 ID（含 <code>rt</code>）在本项目内无条件覆盖全局包。
                </div>
                <div style={{ marginTop: 4 }}>
                  <strong>交付属性解耦：</strong>
                  浏览器沙箱直接挂载胜出者源码；真机 <code>.zip</code> 导出仅打包胜出的真实源码（句柄脚本与 <code>libs[]</code>），胜出者为 <code>sandboxMock</code> 时严格剥离。同一作用域层级内若 2 个启用包声明同一 <code>moduleName</code>，将触发静态 Error 并阻断运行与导出。
                </div>
              </div>
            </div>
          )}

          {tab === 'sections' && (
            <div className="spec-section">
              <p className="spec-lead">
                每个 <code>section</code> 决定侧边栏展示位置、显隐、排序、可选句柄资源配置，并直接内嵌属于该组件的 <code>blocks[]</code>。
              </p>
              <table className="spec-table">
                <thead>
                  <tr>
                    <th>字段名</th>
                    <th>默认值</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>id</code> / <code>label</code></td>
                    <td>必填</td>
                    <td>包内唯一组件 ID（多组件时能力 ID 为 <code>&lt;pack.id&gt;.&lt;section.id&gt;</code>）与侧边栏分类名。</td>
                  </tr>
                  <tr>
                    <td><code>visible</code></td>
                    <td><code>true</code></td>
                    <td>是否在左侧 Blockly 工具箱显示；设为 <code>false</code> 时积木仍可解析生成，但不占侧边栏位置。</td>
                  </tr>
                  <tr>
                    <td><code>categoryTarget</code></td>
                    <td><code>"own"</code></td>
                    <td>
                      不填默认 <code>"own"</code>（独立侧边栏分类）；也可填任意核心分类 ID 合并注入：
                      <div className="spec-chip-list" style={{ marginTop: 5 }}>
                        {CORE_TOOLBOX_ORDERS.map((c) => (
                          <span key={c.id} className="toolbox-order-chip">
                            <code>{c.id}</code> ({c.label} #{c.order})
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td><code>toolboxOrder</code></td>
                    <td><code>100</code></td>
                    <td>仅 <code>categoryTarget === "own"</code> 时生效：数值越小越靠上（如 <code>15</code> 排在事件 #10 与打印 #20 之间）。</td>
                  </tr>
                  <tr>
                    <td><code>handleConfigs</code></td>
                    <td>无</td>
                    <td>
                      可扩展的每句柄资源配置数组。当前内置 <code>kind: "channel-pool"</code>（<code>label</code> 资源名、<code>prefix</code> 易读前缀如 <code>T</code>/<code>PWM</code>、<code>min</code>/<code>max</code>/<code>defaultCount</code>）：声明后<strong>自动生成抽屉顶部配置按钮、句柄别名面板与越界校验</strong>。未来将平级支持 <code>kind: "fields"</code>（串口波特率、引脚等表单配置）。
                    </td>
                  </tr>
                  <tr>
                    <td><code>blocks</code></td>
                    <td>必填</td>
                    <td>直接内嵌属于本组件的积木定义数组，无重复 ID 引用。</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {tab === 'blocks' && (
            <div className="spec-section">
              <p className="spec-lead">
                积木 <code>kind</code> 只有 <strong>3 种完备形态</strong>（事件循环自动扫描整个句柄是否含 <code>hat</code>，无需额外开关）：
              </p>
              <table className="spec-table">
                <thead>
                  <tr>
                    <th><code>kind</code> 取值</th>
                    <th>积木形态与判别口诀</th>
                    <th>典型例子</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>"statement"</code></td>
                    <td><strong>语句块</strong>（上下凹凸拼接）：执行一个动作、不向外层槽位返回值（含给变量赋值）。</td>
                    <td>点亮 LED、启动定时器、给变量赋值</td>
                  </tr>
                  <tr>
                    <td><code>"value"</code></td>
                    <td><strong>表达式块</strong>（左侧输出口）：算出一个值并嵌进其他积木参数槽（如插进「设置变量为」）。</td>
                    <td>读取温度、<code>rt.tick()</code>、<code>crc16(data)</code></td>
                  </tr>
                  <tr>
                    <td><code>"hat"</code></td>
                    <td><strong>事件回调帽块</strong>（圆顶 + C 型包裹体）：生成顶层零闭包 <code>function on_xxx(...)</code>。</td>
                    <td><code>on_run</code>、<code>on_timer</code>、<code>on_button</code></td>
                  </tr>
                </tbody>
              </table>

              <h4 className="spec-subhead">积木核心字段与能力标记</h4>
              <table className="spec-table">
                <thead>
                  <tr>
                    <th>字段名</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>message0</code> / <code>args0</code></td>
                    <td>积木展示文案（用 <code>%1</code>、<code>%2</code> 按顺序占位）与参数定义数组；每个参数的 <code>name</code> 在代码模板中写作 <code>{`{{NAME}}`}</code>。详见下方速查表。</td>
                  </tr>
                  <tr>
                    <td><code>lua</code> / <code>python</code></td>
                    <td>
                      代码生成模板 <code>{`{ template, imports? }`}</code>，<strong>两者至少填一个即可</strong>（支持单语言扩展包；切到未提供模板的语言时校验面板会自动报 Error）。占位符修饰器支持 <code>:json</code>、<code>:int</code>、<code>:bool_lua</code>、<code>:bool_py</code>、<code>:channel_comment_lua</code>、<code>:channel_comment_py</code>。不写 <code>imports</code> 时自动继承包顶层 <code>imports</code>，写 <code>[]</code> 可显式取消导入。
                    </td>
                  </tr>
                  <tr>
                    <td><code>simWidgetKeys</code></td>
                    <td>可选字符串数组，引用 <code>pack.simWidgets</code> 的 <code>key</code>（如 <code>["oled"]</code>）。启用本组件时，模拟面板自动按已启用积木去重聚合所需控件。</td>
                  </tr>
                  <tr>
                    <td><code>sandboxRunnable</code></td>
                    <td>默认 <code>true</code>；仅对无沙箱实现的纯真机积木设为 <code>false</code>（导出正常，沙箱运行时给出明确提示）。</td>
                  </tr>
                </tbody>
              </table>

              <h4 className="spec-subhead">args0 参数类型速查表（name 对应模板 {`{{NAME}}`}）</h4>
              <table className="spec-table">
                <thead>
                  <tr>
                    <th><code>type</code></th>
                    <th>画布形态</th>
                    <th>常用属性与模板用法</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>input_value</code></td>
                    <td>凹进去的值插槽（可拖入数字/文本/表达式）</td>
                    <td><code>name</code>、可选 <code>check</code>（<code>"Number"</code>/<code>"String"</code>/<code>"Boolean"</code>）；可配合积木 <code>shadows</code> 填默认阴影值，模板写 <code>{`{{X}}`}</code>。</td>
                  </tr>
                  <tr>
                    <td><code>field_number</code></td>
                    <td>积木上的内联数字输入框</td>
                    <td><code>name</code>、<code>value</code>（默认值）、<code>min</code>、<code>max</code>、<code>precision</code>；模板写 <code>{`{{MS}}`}</code> 或 <code>{`{{MS:int}}`}</code>。</td>
                  </tr>
                  <tr>
                    <td><code>field_input</code></td>
                    <td>积木上的内联文本输入框</td>
                    <td><code>name</code>、<code>text</code>（默认文本）；模板写 <code>{`{{TXT:json}}`}</code> 自动加双引号转义。</td>
                  </tr>
                  <tr>
                    <td><code>field_dropdown</code></td>
                    <td>固定选项下拉菜单</td>
                    <td><code>name</code>、<code>options: [["展示名", "值"], ...]</code>；模板写 <code>{`{{DIR:json}}`}</code> 或 <code>{`{{STATE:bool_lua}}`}</code>。</td>
                  </tr>
                  <tr>
                    <td><code>field_checkbox</code></td>
                    <td>积木上的勾选框（布尔开关）</td>
                    <td><code>name</code>、<code>checked: true | false</code>；模板写 <code>{`{{EN:bool_lua}}`}</code> / <code>{`{{EN:bool_py}}`}</code>。</td>
                  </tr>
                  <tr>
                    <td><code>field_variable</code></td>
                    <td>工作区变量选择器下拉框</td>
                    <td><code>name</code>、<code>variable</code>（默认变量名如 <code>"cfg"</code>）；模板写 <code>{`{{DICT}}`}</code> 自动输出合法变量标识符。</td>
                  </tr>
                  <tr>
                    <td><code>field_channel_id</code></td>
                    <td>每句柄通道池下拉框（带别名与越界校验）</td>
                    <td><code>name</code>；<strong>无需手写绑定 ID</strong>，自动绑定所属 <code>section.handleConfigs</code> 中的 <code>channel-pool</code>；模板可用 <code>{`{{CH:int}}`}</code> 与 <code>{`{{CH:channel_comment_lua}}`}</code>。</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {tab === 'sim' && (
            <div className="spec-section">
              <p className="spec-lead">
                右侧「模拟」面板支持 <strong>8 种通用声明式控件</strong>；所有控件的关闭/未激活态均自动跟随明暗主题，无需额外配置熄灭色。
              </p>
              <table className="spec-table">
                <thead>
                  <tr>
                    <th><code>kind</code></th>
                    <th>用途</th>
                    <th>关键属性</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>led</code></td>
                    <td>单色指示灯（开/关）</td>
                    <td><code>color</code>（亮灯色，默认绿）、<code>default</code>（布尔）</td>
                  </tr>
                  <tr>
                    <td><code>tricolor</code></td>
                    <td>三色离散灯（仅红/绿/蓝 + 灭）</td>
                    <td><code>default</code>（如 <code>"#1e293b"</code>）</td>
                  </tr>
                  <tr>
                    <td><code>rgb</code></td>
                    <td>全彩 RGB 灯（任意 HEX 色）</td>
                    <td><code>default</code>（HEX 颜色）</td>
                  </tr>
                  <tr>
                    <td><code>bar</code></td>
                    <td>数值进度条（转速/舵机角/电量）</td>
                    <td><code>min</code>、<code>max</code>、<code>unit</code>、<code>color</code></td>
                  </tr>
                  <tr>
                    <td><code>screen</code></td>
                    <td>多行文本屏（OLED / 终端）</td>
                    <td><code>maxLines</code>（支持 <code>key:append</code> / <code>key:clear</code>）</td>
                  </tr>
                  <tr>
                    <td><code>slider</code></td>
                    <td>交互式模拟传感器滑块</td>
                    <td><code>min</code>、<code>max</code>、<code>step</code>、<code>unit</code>、<code>marks</code></td>
                  </tr>
                  <tr>
                    <td><code>toggle</code> / <code>button</code></td>
                    <td>交互开关 / 按键（可发异步中断）</td>
                    <td><code>emitEvent: {`{ eventName, args, trigger }`}</code></td>
                  </tr>
                </tbody>
              </table>

              <h4 className="spec-subhead">在 VS Code 中快速编写扩展包</h4>
              <div className="spec-tip-box">
                <div>
                  1. 在 <code>.polyext.json</code> 顶部添加{' '}
                  <code>"$schema": "./schemas/polyext.schema.json"</code>，即可获得全字段中文悬浮提示、枚举下拉补全与实时校验。
                </div>
                <div style={{ marginTop: 6 }}>
                  2. 仓库已内置 <code>.vscode/polyext.code-snippets</code>，在 JSON 文件内直接输入以下前缀回车即可一键生成骨架：
                  <code>poly-pack</code>（整包）、<code>poly-section</code>（新组件）、<code>poly-block-stmt</code>（语句块）、<code>poly-block-val</code>（表达式块）、<code>poly-block-hat</code>（事件帽块）、<code>poly-pool</code>（通道池）、<code>poly-widget</code>（模拟控件）、<code>poly-lib</code>（脚本库模块）。
                </div>
                <div style={{ marginTop: 6 }}>
                  3. 完整图文规范同步保存在仓库 <code>docs/extension-pack-spec.md</code>。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
