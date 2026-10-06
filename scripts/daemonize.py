"""
把一条命令彻底脱离当前终端会话启动（`npm run start:bg` 用它把服务挂到后台）。

为什么需要它：
- 在终端里写 `cmd &` 起的进程仍留在原进程组，终端一关（或收到进程组信号）就被带走。
- macOS 没有 `setsid` 命令，`launchctl submit` 也不注册作业、不建日志。
- `nohup` + `disown` 只改信号处理和 shell 作业表，进程仍在原进程组里。

所以走经典的双 fork：setsid() 开新会话（新进程组，收不到原会话的进程组信号），
再 fork 一次确保拿不回控制终端，然后立刻退出 —— 目标进程被 launchd(pid 1) 收养，彻底独立。

用法：
    python3 scripts/daemonize.py <日志文件> <命令> [参数...]
    DAEMON_CWD=<工作目录> python3 scripts/daemonize.py /tmp/x.log npm start

想确认真的脱离了：比对目标进程的 os.getsid(pid) 与本 shell 的会话 id，不同才算成功。
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
