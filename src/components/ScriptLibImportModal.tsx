import {
  CheckSquare,
  FileCode2,
  PackagePlus,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildExtensionPackFromScriptLibs,
  scanScriptLibraryFile,
  type ScannedLibFunction,
  type UploadedScriptLibFile,
} from '../core/extensions/scriptLibScanner';
import type { PolyExtensionPack } from '../core/extensions/types';
import type { ScriptLanguageId } from '../types/project';

interface ScriptLibImportModalProps {
  targetScope: 'project' | 'global';
  projectName: string;
  defaultLanguage: ScriptLanguageId;
  onConfirmPack: (pack: PolyExtensionPack) => void;
  onClose: () => void;
}

export function ScriptLibImportModal({
  targetScope,
  projectName,
  defaultLanguage,
  onConfirmPack,
  onClose,
}: ScriptLibImportModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<UploadedScriptLibFile[]>([]);
  const [functions, setFunctions] = useState<ScannedLibFunction[]>([]);
  const [packId, setPackId] = useState('');
  const [packName, setPackName] = useState('');
  const [iconLabel, setIconLabel] = useState('');
  const [toolboxOrder, setToolboxOrder] = useState<number>(120);
  const [color, setColor] = useState('#10b981');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleSelectFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0) return;

    setErrorMsg(null);
    const scannedList: UploadedScriptLibFile[] = [];
    for (const file of picked) {
      const text = await file.text();
      scannedList.push(scanScriptLibraryFile(file.name, text, defaultLanguage));
    }

    setFiles((prevFiles) => {
      const nextMap = new Map<string, UploadedScriptLibFile>();
      for (const f of prevFiles) nextMap.set(f.fileName, f);
      for (const f of scannedList) nextMap.set(f.fileName, f);
      const mergedFiles = Array.from(nextMap.values());

      // Auto-fill pack metadata on first upload
      if (prevFiles.length === 0 && mergedFiles.length > 0) {
        const primary =
          mergedFiles.find((f) => f.scannedFunctions.length > 0) ?? mergedFiles[0];
        const cleanId = primary.moduleName
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-');
        setPackId((cur) => cur || `${cleanId}-lib`);
        setPackName((cur) => cur || `${primary.moduleName} 算法库`);
        setIconLabel((cur) => cur || primary.moduleName.slice(0, 4).toUpperCase());
      }

      // Rebuild scanned functions preserving user edits for unchanged IDs
      setFunctions((prevFns) => {
        const prevById = new Map(prevFns.map((fn) => [fn.id, fn]));
        const nextFns: ScannedLibFunction[] = [];
        const seen = new Set<string>();
        for (const f of mergedFiles) {
          for (const fn of f.scannedFunctions) {
            if (seen.has(fn.id)) continue;
            seen.add(fn.id);
            nextFns.push(prevById.get(fn.id) ?? fn);
          }
        }
        return nextFns;
      });

      return mergedFiles;
    });
  };

  const handleToggleFileScan = (fileName: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.fileName === fileName ? { ...f, scanForBlocks: !f.scanForBlocks } : f,
      ),
    );
  };

  const handleUpdateFileModuleName = (fileName: string, nextModName: string) => {
    const clean = nextModName.trim();
    const targetFile = files.find((f) => f.fileName === fileName);
    if (!targetFile) return;
    const oldMod = targetFile.moduleName;
    setFiles((prev) =>
      prev.map((f) =>
        f.fileName === fileName
          ? {
              ...f,
              moduleName: clean,
              scannedFunctions: f.scannedFunctions.map((fn) => ({
                ...fn,
                id: `${clean}.${fn.funcName}`,
                moduleName: clean,
                label:
                  fn.label === `${oldMod}.${fn.funcName}`
                    ? `${clean}.${fn.funcName}`
                    : fn.label,
              })),
            }
          : f,
      ),
    );
    setFunctions((prev) =>
      prev.map((fn) =>
        fn.moduleName === oldMod
          ? {
              ...fn,
              id: `${clean}.${fn.funcName}`,
              moduleName: clean,
              label:
                fn.label === `${oldMod}.${fn.funcName}`
                  ? `${clean}.${fn.funcName}`
                  : fn.label,
            }
          : fn,
      ),
    );
  };

  const handleRemoveFile = (fileName: string) => {
    setFiles((prev) => {
      const nextFiles = prev.filter((f) => f.fileName !== fileName);
      const remainingMods = new Set(nextFiles.map((f) => f.moduleName));
      setFunctions((prevFns) =>
        prevFns.filter((fn) => remainingMods.has(fn.moduleName)),
      );
      return nextFiles;
    });
  };

  const scanEnabledModules = useMemo(
    () => new Set(files.filter((f) => f.scanForBlocks).map((f) => f.moduleName)),
    [files],
  );

  const visibleFunctions = useMemo(
    () => functions.filter((fn) => scanEnabledModules.has(fn.moduleName)),
    [functions, scanEnabledModules],
  );

  const selectedCount = visibleFunctions.filter((f) => f.selected).length;

  const handleConfirm = () => {
    try {
      setErrorMsg(null);
      if (files.length === 0) {
        setErrorMsg('请先选择至少 1 个 .lua 或 .py 源码文件');
        return;
      }
      if (!packId.trim() || !/^[a-zA-Z0-9_-]{2,48}$/.test(packId.trim())) {
        setErrorMsg('扩展包 ID 需为 2~48 位字母、数字、横线或下划线');
        return;
      }
      const pack = buildExtensionPackFromScriptLibs({
        packId: packId.trim(),
        packName: packName.trim() || packId.trim(),
        iconLabel: iconLabel.trim() || packId.trim().slice(0, 4),
        color,
        toolboxOrder,
        files,
        functions: visibleFunctions,
      });
      onConfirmPack(pack);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="导入原生脚本库生成扩展包"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-shell script-lib-modal">
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileCode2 size={16} style={{ color: 'var(--accent)' }} />
            <span className="modal-title">导入原生脚本库 (.lua / .py) 自动生成扩展包</span>
            <span className="count-badge">
              {targetScope === 'project'
                ? `项目内嵌 · ${projectName}`
                : '全局扩展库 · 跨项目复用'}
            </span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="关闭脚本库导入向导"
            style={{ padding: '4px 6px' }}
          >
            <X size={15} />
          </button>
        </div>

        <div className="script-lib-body">
          <div className="script-lib-upload-bar">
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                1. 选择 1 个或多个脚本源码文件（支持入口库 + 辅助依赖表同包打包）
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                自动跳过 Lua <code>local function</code> 与 Python <code>_私有函数</code>；源码将写入扩展包 <code>libs[]</code>，沙箱仿真与真机 <code>.zip</code> 导出共用。
              </div>
            </div>
            <button
              type="button"
              className="btn-primary"
              style={{ flexShrink: 0 }}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={13} />
              <span>{files.length > 0 ? '继续添加源码...' : '选择 .lua / .py 文件'}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".lua,.py"
              multiple
              style={{ display: 'none' }}
              onChange={handleSelectFiles}
            />
          </div>

          {files.length > 0 && (
            <>
              <div className="script-lib-meta-grid">
                <label className="script-lib-field">
                  <span>扩展包名称</span>
                  <input
                    type="text"
                    className="dropdown-rename-input"
                    value={packName}
                    onChange={(e) => setPackName(e.target.value)}
                    placeholder="例如：CRC16 校验库"
                  />
                </label>
                <label className="script-lib-field">
                  <span>扩展包 ID</span>
                  <input
                    type="text"
                    className="dropdown-rename-input"
                    value={packId}
                    onChange={(e) => setPackId(e.target.value)}
                    placeholder="crc16-lib"
                  />
                </label>
                <label className="script-lib-field" style={{ maxWidth: 96 }}>
                  <span>角标缩写</span>
                  <input
                    type="text"
                    className="dropdown-rename-input"
                    value={iconLabel}
                    maxLength={4}
                    onChange={(e) => setIconLabel(e.target.value)}
                    placeholder="CRC"
                  />
                </label>
                <label className="script-lib-field" style={{ maxWidth: 92 }}>
                  <span>分类排序</span>
                  <input
                    type="number"
                    className="dropdown-rename-input"
                    value={toolboxOrder}
                    min={0}
                    max={9999}
                    onChange={(e) => setToolboxOrder(Number(e.target.value) || 100)}
                  />
                </label>
                <label className="script-lib-field" style={{ maxWidth: 64 }}>
                  <span>颜色</span>
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    style={{
                      width: '100%',
                      height: 30,
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: 2,
                      background: 'var(--bg-input)',
                      cursor: 'pointer',
                    }}
                  />
                </label>
              </div>

              <div className="script-lib-section">
                <div className="settings-label">
                  2. 已添加源码文件（{files.length} 个 · 勾选「扫描积木」区分入口库与纯辅助依赖）
                </div>
                <div className="lib-file-list">
                  {files.map((f) => (
                    <div key={f.fileName} className="lib-file-row">
                      <span className="count-badge">
                        {f.language === 'lua' ? 'Lua' : 'Python'}
                      </span>
                      <span className="lib-file-name" title={f.fileName}>
                        {f.fileName}
                      </span>
                      <label className="lib-mod-edit">
                        <span>moduleName:</span>
                        <input
                          type="text"
                          className="dropdown-rename-input"
                          style={{ width: 132, height: 24, fontSize: 11.5 }}
                          value={f.moduleName}
                          onChange={(e) =>
                            handleUpdateFileModuleName(f.fileName, e.target.value)
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className={`pack-section-chip ${f.scanForBlocks ? 'active' : ''}`}
                        onClick={() => handleToggleFileScan(f.fileName)}
                        title={
                          f.scanForBlocks
                            ? '入口库：扫描其公开函数生成积木'
                            : '辅助库：仅随包挂载与打包导出，不生成积木'
                        }
                      >
                        {f.scanForBlocks ? (
                          <CheckSquare size={12} />
                        ) : (
                          <Square size={12} />
                        )}
                        <span>
                          {f.scanForBlocks
                            ? `入口库 (${f.scannedFunctions.length} 函数)`
                            : '仅辅助依赖'}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: '3px 5px', color: 'var(--danger)' }}
                        title="移除此文件"
                        onClick={() => handleRemoveFile(f.fileName)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="script-lib-section">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span className="settings-label">
                    3. 扫描到的公开函数（已勾选 {selectedCount} / {visibleFunctions.length} · 可切换形态与编辑积木文案）
                  </span>
                  {visibleFunctions.length > 0 && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ fontSize: 11, padding: '2px 7px' }}
                        onClick={() =>
                          setFunctions((prev) =>
                            prev.map((fn) =>
                              scanEnabledModules.has(fn.moduleName)
                                ? { ...fn, selected: true }
                                : fn,
                            ),
                          )
                        }
                      >
                        全选
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ fontSize: 11, padding: '2px 7px' }}
                        onClick={() =>
                          setFunctions((prev) =>
                            prev.map((fn) =>
                              scanEnabledModules.has(fn.moduleName)
                                ? { ...fn, selected: false }
                                : fn,
                            ),
                          )
                        }
                      >
                        全不选
                      </button>
                    </div>
                  )}
                </div>

                {visibleFunctions.length === 0 ? (
                  <div className="lib-empty-hint">
                    当前勾选为「入口库」的文件中未扫描到公开导出函数（如 <code>function M.foo(...)</code> 或 Python 顶层 <code>def foo(...)</code>）。可切换上方文件勾选，或先导出 JSON 后手动编排积木。
                  </div>
                ) : (
                  <div className="lib-fn-table-wrap">
                    <table className="lib-fn-table">
                      <thead>
                        <tr>
                          <th style={{ width: 34 }}>选</th>
                          <th>函数签名</th>
                          <th style={{ width: 124 }}>积木形态 (kind)</th>
                          <th>积木展示文案</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleFunctions.map((fn) => (
                          <tr key={fn.id} className={fn.selected ? '' : 'muted'}>
                            <td>
                              <input
                                type="checkbox"
                                checked={fn.selected}
                                aria-label={`选择函数 ${fn.id}`}
                                onChange={() =>
                                  setFunctions((prev) =>
                                    prev.map((item) =>
                                      item.id === fn.id
                                        ? { ...item, selected: !item.selected }
                                        : item,
                                    ),
                                  )
                                }
                              />
                            </td>
                            <td>
                              <code className="lib-fn-sig">
                                {fn.moduleName}.{fn.funcName}({fn.params.join(', ')})
                              </code>
                            </td>
                            <td>
                              <button
                                type="button"
                                className={`lib-kind-pill ${fn.kind}`}
                                title="点击在「表达式块 (value)」与「语句块 (statement)」间切换"
                                onClick={() =>
                                  setFunctions((prev) =>
                                    prev.map((item) =>
                                      item.id === fn.id
                                        ? {
                                            ...item,
                                            kind:
                                              item.kind === 'value'
                                                ? 'statement'
                                                : 'value',
                                          }
                                        : item,
                                    ),
                                  )
                                }
                              >
                                {fn.kind === 'value'
                                  ? '表达式 (value)'
                                  : '语句 (statement)'}
                              </button>
                            </td>
                            <td>
                              <input
                                type="text"
                                className="dropdown-rename-input"
                                style={{ width: '100%', height: 26, fontSize: 11.5 }}
                                value={fn.label}
                                onChange={(e) =>
                                  setFunctions((prev) =>
                                    prev.map((item) =>
                                      item.id === fn.id
                                        ? { ...item, label: e.target.value }
                                        : item,
                                    ),
                                  )
                                }
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {errorMsg && <div className="lib-error-banner">{errorMsg}</div>}
        </div>

        <div className="script-lib-footer">
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {files.length > 0
              ? `将生成标准 .polyext.json（含 ${files.length} 个源码模块，${selectedCount} 个积木）`
              : '提示：生成后随时可导出 .polyext.json 微调或提升到全局扩展库'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-outline" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={files.length === 0 || selectedCount === 0}
              onClick={handleConfirm}
            >
              <PackagePlus size={13} />
              <span>生成并导入扩展包</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
