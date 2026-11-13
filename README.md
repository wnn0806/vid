# 通话录音上传服务（Render / Zeabur 免费托管）

零依赖 Node.js 服务，接收手机 App 上传的通话录音并保存、列表、播放。
接口与 App 的「服务器上传」设置完全对应。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload` | multipart/form-data，字段 `file`（音频），可选 `phoneNumber` / `duration` / `source` / `recordedAt`；需要时带请求头 `X-Token` |
| GET | `/api/list` | 已上传文件 JSON 列表 |
| GET | `/api/health` | 健康检查 |
| GET | `/files/<文件名>` | 播放 / 下载录音（支持 Range，可直接被播放器拖动进度） |
| GET | `/` | 网页列表，可在线试听 |

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | 监听端口，托管平台会自动注入 |
| `UPLOAD_TOKEN` | 空 | 设置后 App 必须填写同样的令牌才能上传 |
| `MAX_UPLOAD_MB` | `64` | 单文件大小上限 |
| `DATA_DIR` | `./data` | 文件保存目录 |

## 本地自测

```bash
npm start
curl http://127.0.0.1:8000/api/health
curl -F "file=@test.m4a" -F "phoneNumber=13800138000" -F "duration=32000" http://127.0.0.1:8000/api/upload
```

## 方案一：Render 免费托管

1. 把这个目录推到 GitHub（新建一个仓库，只上传本目录内的文件）。
2. 打开 https://dashboard.render.com → **New → Web Service** → 选择该仓库。
3. 配置：
   - Runtime：`Node`
   - Build Command：`npm install`
   - Start Command：`node server.js`
   - Instance Type：`Free`
4. 在 Environment 里加 `UPLOAD_TOKEN`（自己定一个口令），保存后等待部署完成。
5. 拿到形如 `https://call-upload-api-xxxx.onrender.com` 的地址。

也可以直接用仓库里的 `render.yaml`：**New → Blueprint**，选中仓库即可。

在 App 里填写：

- 上传地址：`https://call-upload-api-xxxx.onrender.com/api/upload`
- 访问令牌：与 `UPLOAD_TOKEN` 相同（没设置就留空）

注意：Render 免费实例 15 分钟无请求会休眠，下一次上传会有约 30–60 秒冷启动；免费实例没有持久磁盘，重新部署或重启会清空已上传文件，适合临时使用。

## 方案二：Zeabur 免费托管

1. 把本目录推到 GitHub。
2. 打开 https://zeabur.com → 新建项目 → **Add Service → Git** → 选择仓库。
3. Zeabur 会自动识别 Node.js 并执行 `npm start`；在 **Environment** 里添加 `UPLOAD_TOKEN`。
4. 在 **Networking** 里点 **Generate Domain**，得到 `https://xxx.zeabur.app`。
5. App 上传地址填 `https://xxx.zeabur.app/api/upload`。

需要长期保存文件时，在 Zeabur 给该服务挂一个持久卷（Volume），挂载路径填 `/app/data`，即 `DATA_DIR` 的默认目录。

## 长期存储建议

免费托管实例的磁盘都是临时的。如果录音需要长期保留，把 `DATA_DIR` 换成对象存储（阿里云 OSS / 腾讯云 COS / Cloudflare R2）即可，服务端只需改 `handleUpload` 中的写文件那一处。
