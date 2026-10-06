"""
把一条命令彻底脱离当前会话启动。

为什么需要它：
- 在 Bash 工具里写 `cmd &`，进程会在那次工具调用结束时被回收（下一句就 ECONNREFUSED）。
- 用 `run_in_background: true` 能活一阵，但会话/回合边界一到还是会被收掉。
- macOS **没有 `setsid` 命令**，`launchctl submit` 在这台机器上也不生效（不注册、不建日志）。
- `nohup` + `disown` 只改信号处理和 shell 作业表，进程仍在原进程组里。

所以走经典的双 fork：setsid() 开新会话（新进程组，收不到原会话的进程组信号），
再 fork 一次确保拿不回控制终端，然后立刻退出 —— 目标进程被 launchd(pid 1) 收养，彻底独立。

用法：
    python3 daemonize.py <日志文件> <命令> [参数...]
    DAEMON_CWD=<工作目录> python3 daemonize.py /tmp/x.log npm start
"""

import os
import subprocess
import sys

if len(sys.argv) < 3:
    sys.exit('用法: daemonize.py <日志文件> <命令> [参数...]')

log_path, cmd = sys.argv[1], sys.argv[2:]

if os.fork() > 0:
    os._exit(0)          # 第一层父进程退出，让第一层子进程被 init 收养

os.setsid()              # 新会话 + 新进程组：原会话的进程组信号打不到这里

if os.fork() > 0:
    os._exit(0)          # 再 fork 一次，确保不会重新获得控制终端

with open(log_path, 'ab') as out:
    subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=out,
        stderr=out,
        cwd=os.environ.get('DAEMON_CWD') or None,
        start_new_session=True,
    )

os._exit(0)
