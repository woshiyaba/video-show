# 映集 · 个人视频与照片播放平台

一个面向个人使用的浅色现代化媒体库。视频和照片由浏览器直接上传到腾讯云 COS，应用服务器只保存名称等元数据并签发短时访问地址。视频使用浏览器原生的 HTTP Range 请求按需读取，不会在打开播放页时一次性下载完整文件。

## 功能

- 类 YouTube 的响应式视频首页、搜索、视频详情和相关推荐
- 独立照片图库与沉浸式灯箱浏览
- 无账号管理后台：批量选择、自动封面、分块上传、进度、重试和取消
- 视频在浏览器本地截帧，照片在浏览器本地生成缩略图
- 修改展示名称，以及同时删除数据库记录、COS 原文件和缩略图
- 私有 COS 存储桶、临时预签名播放地址
- 可选的数据万象自动压缩：1080p/720p HLS 自适应码率播放
- 转码成功后自动删除高码率原片，失败时保留原片
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

### 数据万象自动压缩（推荐）

当前代码支持让腾讯云数据万象在新视频上传后自动生成 1080p 和 720p
两档 HLS 播放文件。开通前应用保持原来的 MP4 直播放式；只有配置完整并显式
启用后，新上传的视频才会进入“云端压缩中”状态。

腾讯云参考文档：[自适应码流](https://cloud.tencent.com/document/product/460/58430)、
[配置工作流](https://cloud.tencent.com/document/product/436/53967)、
[工作流回调](https://intl.cloud.tencent.com/zh/document/api/1045/43741)。

1. 在腾讯云 COS 控制台绑定当前 Bucket 到数据万象，并开通媒体处理。
2. 创建 HLS 自适应码流模板，使用以下参数：

   | 参数 | 1080p | 720p |
   | --- | --- | --- |
   | 视频编码 | H.264 | H.264 |
   | 最大分辨率 | 1920 × 1080 | 1280 × 720 |
   | 视频码率 | 5000 Kbps | 2500 Kbps |
   | 最大帧率 | 30 fps | 30 fps |
   | 音频 | AAC-LC，128 Kbps | AAC-LC，128 Kbps |

   选择保持原始宽高比、禁止低分辨率视频放大，HLS 使用 TS 分片，分片时长
   4 秒，关键帧间隔不超过 2 秒。这样 93 秒、824 MB、约 70 Mbps 的 DJI
   4K 原片，播放带宽会降到约 2.5–5 Mbps；两档播放文件合计通常约
   80–90 MB，实际大小取决于内容复杂度。
3. 创建并启用数据工作流：

   - 输入路径：`/media/videos/`
   - 输入格式：音视频文件
   - 处理节点：上一步的 HLS 自适应码流模板
   - 输出 Bucket：当前 Bucket
   - 输出路径：`/media/hls/${InputName}/`
   - 主播放列表文件名：`master.${Ext}`
   - 回调格式：JSON
   - 回调事件：`WorkflowFinish`
   - 回调地址：
     `https://wikiroco.com/video-show/api/transcode/callback/<随机令牌>`

   输出路径和文件名必须保持一致；应用会验证
   `media/hls/<媒体ID>/master.m3u8` 及其 TS 分片后才切换播放地址。
4. 从工作流详情复制工作流 ID，生成至少 32 个不可预测字符的回调令牌，
   写入服务器 `.env`：

   ```dotenv
   VIDEO_TRANSCODING_ENABLED=true
   COS_WORKFLOW_ID=wxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TRANSCODE_CALLBACK_TOKEN=replace-with-a-long-random-secret
   ```

   `.env` 中的令牌必须与回调 URL 最后一段完全一致。令牌会出现在腾讯云
   工作流配置中，不要提交到 Git 或放进前端环境变量。
5. 应用使用的 COS 密钥还需要拥有输出目录的
   `GetObject`、`HeadObject`、`GetBucket`、`DeleteObject` 权限。数据万象
   工作流本身按控制台提示授权其服务角色读取源文件和写入 HLS 输出。

工作流成功后，应用先把播放状态切换为 HLS，再删除原片；若删除暂时失败，
会保留待清理标记并在应用启动时重试。工作流失败不会删除原片。工作流只会
自动处理启用后新上传到输入路径的对象，不会追溯处理已有视频。

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

Docker 构建默认使用国内的 npm 镜像，以及清华 TUNA 的 Debian 和 PyPI 镜像。需要切换镜像时，可在 `.env` 中覆盖：

```dotenv
DOCKER_NPM_REGISTRY=https://registry.npmmirror.com
DOCKER_DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian
DOCKER_DEBIAN_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security
DOCKER_PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple
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

## 5. 验证视频播放

1. 上传一段高码率 MP4。
2. 打开视频详情页和浏览器开发者工具的 Network 面板。
3. 管理页和播放页应先显示“云端压缩中”，完成后自动变为可播放状态。
4. 播放时应先请求应用内的 `master.m3u8` 和子播放列表；TS 分片请求会收到
   307 跳转并直接从 COS 下载，不会通过应用服务器传输视频内容。
5. 在浏览器 Network 限速中切换 Fast 3G/4G，`hls.js` 应自动选择
   720p 或 1080p，不再出现固定高码率视频播放一两秒就等待的循环。
6. COS 中的原视频对象应在工作流成功后被删除；HLS 输出目录和缩略图仍在。
7. `GET /video-show/api/health?deep=true` 中
   `video_transcoding` 应为 `ok`。

未启用云压缩时，旧视频和新上传视频仍使用原生 HTTP Range 按需读取；
拖动进度时 COS 响应应为 `206 Partial Content`。首页不会预载卡片视频。

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
