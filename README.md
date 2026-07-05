# 德州扑克服务器 MVP

这是一个零第三方依赖的最小可用德州扑克服务器：

- 邮箱注册 / 密码登录
- 邮箱验证码登录
- SQLite 保存用户数据
- 创建房间和大厅列表
- 创建房间时配置小盲 / 大盲 / 初始筹码
- WebSocket 实时同步
- 入座、开始手牌、大小盲、发牌、翻牌 / 转牌 / 河牌
- 未入座可进入房间观战；非手牌进行中可起身或直接换座
- fold / check / call / bet / raise
- 摊牌比牌、主池 / 边池结算
- 30 秒行动倒计时，超时自动过牌或弃牌
- 断线后保留座位，重连后可回到房间继续
- 未轮到自己时可提前预设弃牌、过牌 / 跟注、下注 / 加注
- 离线玩家会显示离线，轮到离线玩家时默认不加注：能过牌就过牌，需要跟注则弃牌
- 简单房间聊天
- 入座随机头像、未开局切换头像、全桌同步
- 5 个快捷互动表情和打赏荷官
- 每手牌提供可验证公平哈希：开局公布牌堆承诺，结算后公开 seed 和完整牌堆

## 本地运行

安装 Node.js 22.5 或更高版本，然后运行：

```powershell
cd poker-server
npm start
```

打开：

```text
http://127.0.0.1:3000
```

## 回归测试

启动服务器后可以跑一轮核心流程回归：

```powershell
$env:BASE_URL="http://127.0.0.1:3000"
npm run test:regression
```

脚本会创建测试账号和测试房间，覆盖邮箱验证登录、WebSocket 同步、入座准备、盲注动画、私牌隔离、提前预设动作、离线自动动作、下注轮转、摊牌结算、公平证明公开和断线重连。

## 部署

把 `poker-server` 目录上传到服务器，安装 Node.js 后执行：

```bash
PORT=3000 node server.js
```

## 邮箱验证码配置

验证码邮件通过 SMTP 发送。部署时建议设置：

服务器会自动读取 `poker-server/.env`，可以先复制 `.env.example`：

```powershell
Copy-Item .env.example .env
```

然后填写你的 SMTP 信息。也可以直接用环境变量启动：

```bash
SMTP_HOST=smtp.example.com \
SMTP_PORT=587 \
SMTP_USER=你的邮箱账号 \
SMTP_PASS=你的邮箱授权码或密码 \
SMTP_FROM=no-reply@example.com \
PORT=3000 \
node server.js
```

如果你的 SMTP 使用 465 SSL 端口，也可以加：

```bash
SMTP_SECURE=true
```

没有配置 `SMTP_HOST` 时，服务器会进入本地开发模式：验证码不会真的发送邮件，而是打印到服务端日志；前端也会显示本地验证码，方便测试。

用户数据保存在：

```text
data/poker.sqlite
```

默认头像读取项目上一级的 `default_user_face` 目录，支持 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`。例如当前结构可以是：

```text
视觉模型记牌器/
  default_user_face/
  poker-server/
```

筹码音效来自 Kenney Casino Audio，授权为 CC0；授权文件保存在：

```text
public/audio/KENNEY_CASINO_AUDIO_LICENSE.txt
```

BGM 曲目来自 OpenGameArt，均为 CC0；授权说明保存在：

```text
public/music/OPEN_GAME_ART_MUSIC_LICENSES.txt
```

大厅固定播放 `Heavenly Loop`；每个房间会优先循环播放本地的 `public/music/room-loop.mp3`，没有这个文件时回退到仓库内置的 `public/music/room-loop.ogg`。同一房间内的玩家会同步到同一首歌和相同进度。`room-loop.mp3` 默认不提交到 Git，用于放置你自己有权使用的房间音乐。

如果使用 Nginx 反向代理，需要转发 WebSocket：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## 当前边界

第一版为了快和简单，房间状态存在内存中，服务器重启会清空房间；用户账号保存在 SQLite，密码使用 PBKDF2 加盐哈希保存。牌局状态由服务器权威控制，客户端只能提交动作，不能决定牌堆或改筹码。当前公平方案能证明一手牌开局后的牌堆没有被中途篡改；如果要进一步防止“服务器运营方作恶”，下一步可以加入多玩家 client seed 共同洗牌。
