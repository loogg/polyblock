import type { ScriptLanguageId } from '../../types/project';
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
    supportedLanguages: ['lua', 'python'],
    description:
      '将积木生成的 Lua / Python 脚本直接下发至支持网络协议的远端设备或服务网关，并实时订阅设备日志回传。',
    upgradePath: '实现 ScriptRunner 接口并注册到 RunnerManager 即可无缝接入。',
  },
  {
    id: 'local-bridge-agent',
    name: '本机轻量桥接 Runner（Local Bridge）',
    kind: 'local-bridge',
    protocol: 'ws://127.0.0.1:9527 -> TCP / UDP / 本机进程',
    supportedLanguages: ['lua', 'python'],
    description:
      '适合 GitHub Pages (HTTPS) 场景：通过本机托盘代理转发至局域网明文设备、裸 TCP/UDP 硬件或本机解释器。',
    upgradePath: '前端无需改动，启动本地桥接服务后自动接入当前控制台与下载流程。',
  },
  {
    id: 'web-serial-mcu',
    name: '串口硬件下载 Runner（Web Serial）',
    kind: 'web-serial',
    protocol: 'Web Serial API · 115200 bps',
    supportedLanguages: ['python', 'lua'],
    description:
      '在 Chrome / Edge HTTPS 页面中免驱直连 ESP32 / RP2040 等微控制器，一键写入脚本并监视串口输出。',
    upgradePath: 'GitHub Pages 天然满足 HTTPS 安全上下文要求，后续按需启用。',
  },
];

class RunnerManager {
  private readonly runners = new Map<string, ScriptRunner>();
  private activeRunner: ScriptRunner | null = null;

  constructor() {
    this.register(new WasmoonLuaRunner());
    this.register(new MicroPythonWasmRunner());
  }

  register(runner: ScriptRunner): void {
    this.runners.set(runner.id, runner);
  }

  listBuiltin(): ScriptRunner[] {
    return Array.from(this.runners.values());
  }

  getForLanguage(language: ScriptLanguageId): ScriptRunner {
    for (const runner of this.runners.values()) {
      if (runner.supportedLanguages.includes(language)) {
        return runner;
      }
    }
    throw new Error(`No runner registered for language: ${language}`);
  }

  setActive(runner: ScriptRunner | null): void {
    this.activeRunner = runner;
  }

  stopActive(): void {
    this.activeRunner?.stop();
  }

  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
  }
}

export const runnerManager = new RunnerManager();
