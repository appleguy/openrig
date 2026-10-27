import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexGoalClient } from "../src/adapters/codex-goal-client.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { Binding } from "../src/domain/types.js";
import { codexCommandRemote } from "../src/domain/native-process-lineage.js";

const threadId = "01a179a1-9ac1-7cf1-b249-4acf7d07868a";
const binding: Binding = { id: "b", nodeId: "n", tmuxSession: "audit@rig", tmuxPane: "%1", tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "same" };
afterEach(() => vi.restoreAllMocks());
function setup(remote = "unix:///target/rpc.sock", token = threadId, processEnv: { home?: string; codexHome?: string } = { home: "/target/home" }) {
  const runCodexCli = vi.fn(async (_args: string[], env: NodeJS.ProcessEnv) => ({ status: 0, stdout: JSON.stringify({ status: "running", cliVersion: "1", appServerVersion: "1", socketPath: `${env.CODEX_HOME}/app-server-control/app-server-control.sock` }), stderr: "" }));
  const adapter = new CodexRuntimeAdapter({ tmux: { getPanePid: async () => 10 } as unknown as TmuxAdapter,
    fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] },
    listProcesses: async () => [
      { pid: 10, ppid: 1, command: "zsh", executableName: "zsh", startedAt: "shell-start", pgid: 10, tpgid: 20 },
      { pid: 20, ppid: 10, command: `codex --remote ${remote} resume ${token}`, executableName: "codex", pgid: 20, tpgid: 20, startedAt: "stable" },
    ], resolveHomeDirByPid: async () => "/target/home", resolveCodexProcessEnvironmentByPid: async () => processEnv, runCodexCli });
  const close = vi.fn();
  const apply = vi.fn(async (_thread, _change, check) => { await check(); return { goal: null, changed: false }; });
  const connect = vi.spyOn(CodexGoalClient, "connect").mockResolvedValue({ close, apply } as unknown as CodexGoalClient);
  return { adapter, connect, close, apply, runCodexCli };
}
describe("Codex goal adapter process and endpoint boundary", () => {
  it("never accepts prompt text or another option's value as a remote transport", () => {
    expect(codexCommandRemote(`codex resume ${threadId} --remote unix:///wrong.sock`)).toBeNull();
    expect(codexCommandRemote(`codex --model --remote resume ${threadId}`)).toBeNull();
    expect(codexCommandRemote(`codex --remote unix:///a --remote unix:///b resume ${threadId}`)).toBeNull();
  });
  it("uses the endpoint from the verified target process with no launch or turn start", async () => {
    const { adapter, connect, close, runCodexCli } = setup();
    await adapter.controlGoal({ binding, threadId, socketPath: "/target/rpc.sock", change: { operation: "get" }, beforeMutation: async () => {} });
    expect(connect).toHaveBeenCalledExactlyOnceWith("/target/rpc.sock");
    expect(close).toHaveBeenCalledOnce(); expect(runCodexCli).not.toHaveBeenCalled();
  });
  it("refuses a different socket or conversation before connecting", async () => {
    const { adapter, connect } = setup();
    await expect(adapter.controlGoal({ binding, threadId, socketPath: "/other/rpc.sock", change: { operation: "clear" }, beforeMutation: async () => {} })).rejects.toMatchObject({ code: "goal_endpoint_unverified" });
    await expect(adapter.controlGoal({ binding, threadId: "other", socketPath: "/target/rpc.sock", change: { operation: "clear" }, beforeMutation: async () => {} })).rejects.toMatchObject({ code: "goal_identity_unverified" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("resolves a default Unix endpoint using the target home and Codex's read-only metadata", async () => {
    const { adapter, runCodexCli, connect } = setup("unix://");
    const socketPath = "/target/home/.codex/app-server-control/app-server-control.sock";
    await adapter.controlGoal({ binding, threadId, socketPath, change: { operation: "get" }, beforeMutation: async () => {} });
    expect(runCodexCli).toHaveBeenCalledExactlyOnceWith(["app-server", "daemon", "version"], expect.objectContaining({ HOME: "/target/home", CODEX_HOME: "/target/home/.codex" }), 3000);
    expect(connect).toHaveBeenCalledExactlyOnceWith(socketPath);
  });
  it("resolves the default endpoint from the target process CODEX_HOME override", async () => {
    const processCodexHome = "/target/home/private-codex";
    const { adapter, runCodexCli, connect } = setup("unix://", threadId, { home: "/target/home", codexHome: processCodexHome });
    const socketPath = `${processCodexHome}/app-server-control/app-server-control.sock`;
    await adapter.controlGoal({ binding, threadId, socketPath, change: { operation: "get" }, beforeMutation: async () => {} });
    expect(runCodexCli).toHaveBeenCalledExactlyOnceWith(["app-server", "daemon", "version"], expect.objectContaining({ HOME: "/target/home", CODEX_HOME: processCodexHome }), 3000);
    expect(connect).toHaveBeenCalledExactlyOnceWith(socketPath);
  });
  it("refuses default endpoint metadata that does not name the supplied socket", async () => {
    const { adapter, connect, runCodexCli } = setup("unix://");
    runCodexCli.mockResolvedValueOnce({ status: 0, stdout: JSON.stringify({ status: "running", cliVersion: "1", appServerVersion: "1", socketPath: "/wrong/home/app-server-control/app-server-control.sock" }), stderr: "" });
    await expect(adapter.controlGoal({ binding, threadId, socketPath: "/target/home/.codex/app-server-control/app-server-control.sock", change: { operation: "get" }, beforeMutation: async () => {} })).rejects.toMatchObject({ code: "goal_endpoint_unverified" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("serializes concurrent operations for the same endpoint and exact thread", async () => {
    const { adapter, connect, apply } = setup();
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { signalFirst = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let active = 0, maximumActive = 0;
    apply.mockImplementation(async (_thread, _change, check) => {
      active += 1; maximumActive = Math.max(maximumActive, active);
      if (apply.mock.calls.length === 1) signalFirst();
      await check();
      if (apply.mock.calls.length === 1) await firstGate;
      active -= 1;
      return { goal: null, changed: true };
    });
    const first = adapter.controlGoal({ binding, threadId, socketPath: "/target/rpc.sock", change: { operation: "clear" }, beforeMutation: async () => {} });
    await firstStarted;
    const second = adapter.controlGoal({ binding, threadId, socketPath: "/target/rpc.sock", change: { operation: "clear" }, beforeMutation: async () => {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(connect).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
