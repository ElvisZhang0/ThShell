/**
 * 终端底部「快捷命令」的数据源。
 *
 * 抽成单独文件而不是写在组件里，是因为这份表会一直长 —— 上百条命令时
 * 混在 .vue 的 script 里找一条要滚半天，也没法单独复用（比如以后做命令面板搜索）。
 *
 * 三条约定：
 * - `desc` 是"这条命令用来回答什么问题"，不是翻译命令本身。
 *   「df -i → inode 使用率」比「df -i → 显示 inode 信息」更有用。
 * - `note` 放参数怎么读、什么情况下会误判，只在鼠标悬停时出现。
 * - `mode: 'fill'` 的命令带占位参数（端口号、服务名），点了只写进提示符不回车，
 *   否则会跑一条写死的参数、什么也不输出，看着像命令没生效。
 */

export interface QuickCommand {
  /** 实际下发到终端的命令 */
  cmd: string
  /** 一句话说明：这条命令用来干什么 */
  desc: string
  /** 补充说明：参数怎么读、哪些情况会误判。悬停时和 desc 一起显示 */
  note?: string
  /**
   * run（默认）：点击直接执行。
   * fill：只把命令写进提示符、不回车，留给用户改参数。
   */
  mode?: 'run' | 'fill'
  /** 常驻在终端底部那条栏上的一键命令 */
  hot?: boolean
}

export interface QuickGroup {
  label: string
  commands: QuickCommand[]
}

export const QUICK_GROUPS: QuickGroup[] = [
  {
    label: '系统',
    commands: [
      {
        cmd: 'uptime',
        desc: '运行时长与平均负载',
        note: '三个数字是 1 / 5 / 15 分钟的平均负载，超过核数就说明在排队',
        hot: true
      },
      {
        cmd: 'w -h',
        desc: '谁在登录、在跑什么',
        note: '-h 去掉表头；每行一个会话，最后一列是该会话当前执行的命令'
      },
      { cmd: 'uname -a', desc: '内核版本与 CPU 架构' },
      {
        cmd: 'cat /etc/os-release',
        desc: '发行版名称与版本号',
        note: 'CentOS 6 及更早没有这个文件，用 cat /etc/redhat-release'
      },
      {
        cmd: 'hostnamectl',
        desc: '主机名、系统、内核一览',
        note: '依赖 systemd；老系统用 hostname 命令'
      },
      {
        cmd: 'date',
        desc: '系统时间与时区',
        note: '和本地时间差太多会让日志时间对不上，排查时序问题先看这条'
      },
      {
        cmd: 'last -n 10',
        desc: '最近 10 次登录记录',
        note: '查异常登录先看这里；reboot 表示那次是重启'
      }
    ]
  },
  {
    label: '磁盘与文件',
    commands: [
      {
        cmd: 'df -h',
        desc: '各分区容量与使用率',
        hot: true
      },
      {
        cmd: 'df -i',
        desc: 'inode 使用率',
        note: '报"空间不足"但 df -h 还有余量时，多半是小文件把 inode 用完了'
      },
      {
        cmd: 'du -sh * | sort -h',
        desc: '当前目录下各项占用排序',
        note: '排查"这目录怎么这么大"的第一步，然后 cd 进去再来一次',
        hot: true
      },
      {
        cmd: 'du -sh /* 2>/dev/null | sort -h',
        desc: '根目录一级目录占用排序',
        note: '2>/dev/null 是为了吃掉 /proc、/sys 的权限报错'
      },
      {
        cmd: 'lsblk',
        desc: '块设备与分区树',
        note: '看新挂的盘有没有识别、是不是做了 LVM'
      },
      {
        cmd: 'find / -xdev -size +500M -type f 2>/dev/null',
        desc: '全盘找出 500MB 以上的文件',
        note: '-xdev 不跨文件系统，避免钻进挂载进来的网络盘/NAS'
      },
      {
        cmd: 'ls -alh',
        desc: '当前目录详细列表（含隐藏文件）',
        hot: true
      }
    ]
  },
  {
    label: '内存与进程',
    commands: [
      {
        cmd: 'free -m',
        desc: '内存与 Swap 使用量（MB）',
        note: '重点看 available，不是 free —— Linux 会把空闲内存拿去做缓存',
        hot: true
      },
      {
        cmd: 'top -bn1 | head -20',
        desc: '进程快照（默认按 CPU 排序）',
        note: '-b 批处理模式，一次性输出后退出；直接 top 会占住终端',
        hot: true
      },
      {
        cmd: 'vmstat 1 5',
        desc: '每秒采样一次，共 5 次',
        note: 'si / so 不是 0 说明在用 swap，性能会突然掉一截'
      },
      {
        cmd: 'ps aux --sort=-%cpu | head -11',
        desc: 'CPU 占用前 10 的进程',
        note: 'head -11 是因为第一行是表头'
      },
      {
        cmd: 'ps aux --sort=-%mem | head -11',
        desc: '内存占用前 10 的进程',
        note: 'RSS 一列才是真实占用的物理内存'
      }
    ]
  },
  {
    label: '网络',
    commands: [
      {
        cmd: 'ss -tunlp',
        desc: '监听中的端口与占用进程',
        note: '-t TCP · -u UDP · -n 不解析端口名 · -l 只看监听 · -p 显示进程',
        hot: true
      },
      {
        cmd: 'ss -s',
        desc: '各状态连接数统计',
        note: 'TIME-WAIT 特别多，说明短连接太频繁或者没开复用'
      },
      { cmd: 'ip a', desc: '网卡与 IP 地址' },
      { cmd: 'ip route', desc: '路由表与默认网关' },
      {
        cmd: 'cat /etc/resolv.conf',
        desc: 'DNS 服务器配置',
        note: '网络通但域名解析不了，先看这里'
      },
      {
        cmd: 'ping -c 4 223.5.5.5',
        desc: '测外网出口是否通',
        note: '223.5.5.5 是阿里公共 DNS；内网机器本来就不出外网，不通不代表故障'
      },
      {
        cmd: 'lsof -i:8080',
        desc: '查某个端口被谁占用',
        note: '把 8080 换成要查的端口；没装 lsof 时用 ss -tunlp 顶',
        mode: 'fill'
      }
    ]
  },
  {
    label: '服务与定时',
    commands: [
      {
        cmd: 'systemctl --failed',
        desc: '启动失败的服务',
        note: '"服务起不来"排查的第一条命令，比一个个 status 快得多'
      },
      {
        cmd: 'systemctl list-units --type=service --state=running',
        desc: '正在运行的服务列表',
        note: '对比预期应该有的服务，能发现漏启动的'
      },
      {
        cmd: 'systemctl status sshd',
        desc: '单个服务的运行状态',
        note: '把 sshd 换成要看的服务名；退不出按 q',
        mode: 'fill'
      },
      {
        cmd: 'crontab -l',
        desc: '当前用户的定时任务',
        note: '看 root 的任务要 sudo crontab -l；系统级任务在 /etc/cron.d 和 /etc/crontab'
      }
    ]
  },
  {
    label: '日志与排查',
    commands: [
      {
        cmd: 'journalctl -p err -n 50 --no-pager',
        desc: '最近 50 条错误级日志',
        note: '仅 systemd 系统；CentOS 6 看 /var/log/messages，--no-pager 是为了别进翻页器'
      },
      {
        cmd: 'tail -f /var/log/messages',
        desc: '实时跟随系统日志',
        note: 'Debian / Ubuntu 上是 /var/log/syslog；退出按 Ctrl+C'
      },
      {
        cmd: 'dmesg -T | tail -n 50',
        desc: '内核日志（时间可读）',
        note: '-T 把开机秒数换算成日期，不加 -T 看到的是 [12345.67]'
      },
      {
        cmd: 'dmesg -T | grep -iE "oom|out of memory"',
        desc: '查有没有被 OOM 杀过进程',
        note: '进程莫名消失、服务自己重启时先看这条'
      },
      {
        cmd: 'history | tail -20',
        desc: '最近执行过的 20 条命令',
        note: '别人刚在上面动过什么；只记录当前 shell，退出就没了'
      }
    ]
  }
]

/** 底部常驻的一键命令，按分组顺序拼出来 */
export const HOT_COMMANDS: QuickCommand[] = QUICK_GROUPS.flatMap((g) => g.commands).filter((c) => c.hot)

/** 面板里一共多少条，用于顶部的计数文案 */
export const QUICK_TOTAL = QUICK_GROUPS.reduce((n, g) => n + g.commands.length, 0)
