# 映集 · 个人视频与照片播放平台

一个面向个人使用的浅色现代化媒体库。视频和照片由浏览器直接上传到腾讯云 COS，应用服务器只保存名称等元数据并签发短时访问地址。视频使用浏览器原生的 HTTP Range 请求按需读取，不会在打开播放页时一次性下载完整文件。

## 功能

- 类 YouTube 的响应式视频首页、搜索、视频详情和相关推荐
- 独立照片图库与沉浸式灯箱浏览
- 无账号管理后台：批量选择、自动封面、分块上传、进度、重试和取消
- 视频在浏览器本地截帧，照片在浏览器本地生成缩略图
- 修改展示名称，以及同时删除数据库记录、COS 原文件和缩略图
- 私有 COS 存储桶、临时预签名播放地址
- FastAPI + React + SQLite，支持 Docker 单机部署

> 当前按需求没有登录或管理密码。任何可以访问网站的人都能查看、上传、改名和删除内容。请将它部署在个人网络、VPN，或有访问控制的反向代理后。

## 1. 配置腾讯云 COS

项目会读取现有 `.env` 中的以下变量：

```dotenv
COS_SECRET_ID=...
COS_SECRET_KEY=...
COS_REGION=ap-guangzhou
COS_BUCKET=example-1250000000
```

`COS_BUCKET` 必须包含 APPID 后缀。其他可调参数见 [.env.example](.env.example)。

建议给这组密钥配置最小权限，至少包括目标存储桶下对象的读取、写入、删除、创建分块上传、上传分块、完成分块上传和终止分块上传权限。不要把 `.env` 提交到 Git，也不要把永久密钥放入前端环境变量。

### COS CORS

浏览器会直接访问 COS，因此需要在腾讯云 COS 控制台为存储桶添加跨域规则。生产环境把 Origin 换成网站的准确协议和域名：

| 配置项 | 值 |
| --- | --- |
| 来源 Origin | `https://wikiroco.com`（开发时另加 `http://localhost:5173`） |
| Allowed Methods | `GET`, `HEAD`, `PUT` |
| Allowed Headers | `*` |
| Expose Headers | `ETag`, `Accept-Ranges`, `Content-Range`, `Content-Length` |
| Max-Age | `3600` |

`ETag` 是完成分块上传必需的；`Range` / `Content-Range` 用于按需播放和拖动进度。应用不会自动修改存储桶权限或 CORS。

## 2. 本地开发

要求 Python 3.13、Node.js 22 和 [uv](https://docs.astral.sh/uv/)。

```powershell
# 后端依赖
uv sync --extra dev

# 前端依赖
cd frontend
npm install
cd ..
```

分别启动两个终端：

```powershell
# 终端一：http://localhost:8002/video-show/
uv run uvicorn app.main:app --host 0.0.0.0 --port 8002 --reload

# 终端二：http://localhost:5173/video-show/
cd frontend
npm run dev
```

开发服务器会把 `/video-show/api` 代理到 FastAPI。API 文档位于
`http://localhost:8002/video-show/docs`。

## 3. Docker 部署

确认 `.env` 配置无误后运行：

```powershell
docker compose up --build -d
```

访问 `http://localhost:8002/video-show/`。SQLite 保存在宿主机 `./data`，备份该目录即可保存媒体元数据；原始媒体仍位于 COS。

如需修改映射端口，可在 `.env` 增加：

```dotenv
APP_PORT=8002
CORS_ORIGINS=https://wikiroco.com
```

生产环境反向代理应允许前端访问 COS 域名，并使用 HTTPS。若启用 Content Security Policy，需要把相应 COS 域名加入 `media-src` 和 `img-src`。

## 4. 接入现有 wikiroco.com Nginx

网站和所有接口统一使用 `/video-show` 前缀：

- 前台：`https://wikiroco.com/video-show/`
- 管理后台：`https://wikiroco.com/video-show/admin`
- API：`https://wikiroco.com/video-show/api/...`
- API 文档：`https://wikiroco.com/video-show/docs`

因为 80 和 443 已由现有服务占用，不要再创建新的 `listen 80` 或
`listen 443`。把项目中的
[`nginx/wikiroco.com-video-show.location.conf`](nginx/wikiroco.com-video-show.location.conf)
放到服务器，例如：

```text
/etc/nginx/snippets/wikiroco.com-video-show.location.conf
```

然后在现有的 `server_name wikiroco.com;` HTTPS `server` 块内部加入：

```nginx
include /etc/nginx/snippets/wikiroco.com-video-show.location.conf;
```

片段内的上游地址为 `127.0.0.1:8002`。`proxy_pass` 后面特意没有 `/`，
这样 Nginx 会把完整的 `/video-show/...` 路径交给 FastAPI。修改完成后：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

如果现有的 80 端口虚拟主机已经统一跳转 HTTPS，只需在 443 的
`wikiroco.com` 虚拟主机中 include；如果 HTTP 也直接提供页面，则在两个
现有 `server` 块中都 include。同一 IP:端口无法由两个独立进程同时监听，
所以若占用 80/443 的不是 Nginx，需要在当前占用者中配置反向代理，或改用
带端口的访问地址。

## 5. 验证按需播放

1. 上传浏览器兼容的 MP4（推荐 H.264 视频和 AAC 音频）。
2. 打开视频详情页和浏览器开发者工具的 Network 面板。
3. 播放或拖动进度，COS 请求应包含 `Range: bytes=...`，响应状态为 `206 Partial Content`。
4. 播放页在非省流量模式下使用 `preload="auto"` 提前缓冲当前视频，并在
   弱网恢复时先积累一小段安全缓冲；浏览器可能根据设备、网络和自身策略
   调整或忽略该提示。
5. 首页只会空闲预取下一页的媒体信息，不会批量预载卡片对应的视频内容。

未进行服务端转码意味着 MOV、MKV 或采用浏览器不支持编码的 MP4 不会被接受。若未来需要多清晰度、自适应码率或更广泛的编码兼容性，可再增加 FFmpeg/HLS 处理流水线。

## 6. 测试与构建

```powershell
# 后端测试
uv run --extra dev pytest

# 前端测试、类型检查和生产构建
cd frontend
npm run test
npm run type-check
npm run build
```

后端自动测试使用模拟 COS，不会读写真实存储桶。
`GET /video-show/api/health?deep=true` 可在部署后主动检查 COS 连通性及
CORS 配置。
