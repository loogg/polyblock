import type { ScriptLanguageId } from '../../types/project';
import { getSupportedLanguageIds } from '../backends/registry';
import { WasmoonLuaRunner } from './luaRunner';
import { MicroPythonWasmRunner } from './pythonRunner';
import type { RunnerKind, ScriptRunner } from './types';

export interface PlannedRunnerDescriptor {
  id: string;
  name: string;
  kind: RunnerKind;
  protocol: string;
  supportedLanguages: ScriptLanguageId[];
  description: string;
  upgradePath: string;
}

export const PLANNED_RUNNER_SLOTS: PlannedRunnerDescriptor[] = [
  {
    id: 'remote-ws-device',
    name: '网络设备 Runner（WebSocket / HTTP）',
    kind: 'network-ws',
    protocol: 'wss:// 或 https:// API',
    get supportedLanguages() {
      return getSupportedLanguageIds();
    },
    description:
      '将积木生成的目标脚本直接下发至支持网络协议的远端设备或服务网关，并实时订阅设备日志回传。',
    upgradePath: '实现 ScriptRunner 接口并注册到 RunnerManager 即可无缝接入。',
  },
  {
    id: 'local-bridge-agent',
    name: '本机轻量桥接 Runner（Local Bridge）',
    kind: 'local-bridge',
    protocol: 'ws://127.0.0.1:9527 -> TCP / UDP / 本机进程',
    get supportedLanguages() {
      return getSupportedLanguageIds();
    },
    description:
      '适合 GitHub Pages (HTTPS) 场景：通过本机托盘代理转发至局域网明文设备、裸 TCP/UDP 硬件或本机解释器。',
    upgradePath: '前端无需改动，启动本地桥接服务后自动接入当前控制台与下载流程。',
  },
  {
    id: 'web-serial-mcu',
    name: '串口硬件下载 Runner（Web Serial）',
    kind: 'web-serial',
    protocol: 'Web Serial API · 115200 bps',
    get supportedLanguages() {
      return getSupportedLanguageIds();
    },
    description:
      '在 Chrome / Edge HTTPS 页面中免驱直连 ESP32 / RP2040 等微控制器，一键写入脚本并监视串口输出。',
    upgradePath: 'GitHub Pages 天然满足 HTTPS 安全上下文要求，后续按需启用。',
  },
];

export class RunnerManager {
  private readonly runners = new Map<string, ScriptRunner>();
  private readonly factories = new Map<ScriptLanguageId, () => ScriptRunner>();
  private activeRunner: ScriptRunner | null = null;

  constructor() {
    this.registerFactory('lua', () => new WasmoonLuaRunner());
    this.registerFactory('python', () => new MicroPythonWasmRunner());
  }

  register(runner: ScriptRunner): void {
    this.runners.set(runner.id, runner);
  }

  registerFactory(
    language: ScriptLanguageId,
    factory: () => ScriptRunner,
  ): void {
    this.factories.set(language, factory);
    this.register(factory());
  }

  /** Creates a fresh isolated ScriptRunner instance (used for multi-handle concurrent runs). */
  createForLanguage(language: ScriptLanguageId): ScriptRunner {
    const factory = this.factories.get(language);
    if (!factory) {
      throw new Error(`No runner factory registered for language: ${language}`);
    }
    return factory();
  }

  listBuiltin(): ScriptRunner[] {
    return Array.from(this.runners.values());
  }

  findForLanguage(language: ScriptLanguageId): ScriptRunner | null {
    for (const runner of this.runners.values()) {
      if (runner.supportedLanguages.includes(language)) {
        return runner;
      }
    }
    return null;
  }

  hasRunnerForLanguage(language: ScriptLanguageId): boolean {
    return this.findForLanguage(language) !== null;
  }

  getForLanguage(language: ScriptLanguageId): ScriptRunner {
    const found = this.findForLanguage(language);
    if (!found) {
      throw new Error(`No runner registered for language: ${language}`);
    }
    return found;
  }

  setActive(runner: ScriptRunner | null): void {
    this.activeRunner = runner;
  }

  getActive(): ScriptRunner | null {
    return this.activeRunner;
  }

  stopActive(force = false): void {
    this.activeRunner?.stop(force);
  }

  resumeActive(): void {
    this.activeRunner?.resume?.();
  }

  stepNextActive(): void {
    this.activeRunner?.stepNext?.();
  }

  pauseActive(): void {
    this.activeRunner?.pause?.();
  }

  updateActiveBreakpoints(breakpoints: string[]): void {
    this.activeRunner?.updateBreakpoints?.(breakpoints);
  }

  updateActiveStepDelay(stepDelayMs: number): void {
    this.activeRunner?.updateStepDelay?.(stepDelayMs);
  }

  updateActiveTimeSlice(timeSliceMs: number): void {
    this.activeRunner?.updateTimeSlice?.(timeSliceMs);
  }

  updateActiveMockInputs(mockInputs: Record<string, unknown>): void {
    this.activeRunner?.updateMockInputs?.(mockInputs);
  }

  emitActiveEvent(eventName: string, args: unknown[] = []): void {
    this.activeRunner?.emitEvent?.(eventName, args);
  }

  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
  }
}

export const runnerManager = new RunnerManager();
