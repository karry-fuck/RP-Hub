# Roleplay Hub

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D.svg?logo=vue.js)](https://vuejs.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![DaisyUI](https://img.shields.io/badge/DaisyUI-5A0EF8?logo=daisyui&logoColor=white)](https://daisyui.com/)

> **一款本地角色扮演（Roleplay）对话和角色卡生成工具。数据经轻量服务器（`server.py`）落盘 SQLite，支持局域网跨设备共享、聊天图片持久化与 ComfyUI 同源反代。**

**【免责与授权声明】**  
本项目基于 **[CC BY-NC 4.0（知识共享-署名-非商业性使用 4.0 国际许可协议）](./LICENSE)** 开源。**明确禁止任何形式的商业化使用（包括但不限于：作为收费服务提供、打包在付费产品中售卖、在产品内植入广告盈利等）。** 任何使用者必须遵守该协议，尊重原作者的署名权。对于违反协议的商业行为，保留追究法律责任的权利。

---

## 核心特性 (Features)

Roleplay Hub 致力于提供流畅、私密且功能强大的本地化AI Roleplay体验。

## 快速开始 (Quick Start)

本项目只需 **Python 3**（标准库，零第三方依赖），无需 Node.js / 构建步骤。

### 1. 下载与运行
1. 点击项目主页绿色的 `Code` 按钮，选择 `Download ZIP`。
2. 将下载的 ZIP 压缩包解压到您的本地任意文件夹中。
3. 在项目根目录启动服务器：
   ```bash
   python3 server.py
   ```
4. 浏览器访问 **http://127.0.0.1:8000**（默认端口 8000）即可开始使用。

- **局域网跨设备**：手机 / 其他电脑访问 `http://<本机IP>:8000`（启动时服务器会打印本机 IP；若无法访问请先放行端口）。
- 常用参数：`python3 server.py --port 9000 --bind 0.0.0.0`。
- **数据落盘**：角色、聊天、记忆、设置存到 `rp_hub_data.db`（SQLite），聊天生成的图片存 `images/generated/`，重启不丢失、跨设备共享。
- **ComfyUI 免配置**：同机启动 ComfyUI 后，应用内选 ComfyUI 生图即可（走 `/comfy_api` 反代，无需填地址、免 CORS）。
- ⚠️ **必须通过 server.py 访问**：`file://` 双击 `index.html` 无法使用（数据与图片全部经服务器读写）。

### 2. 初始化设置
1. 打开应用后，点击侧边栏（或顶部菜单）的**设置 (Settings)** 选项。
2. 选择自定义配置，填入您自己的或第三方提供的 API 节点 (`API URL`)。
3. 填入对应的 `API Key`，并输入或选择您想使用的 `模型名称 (Model)`。
4. 在**角色管理**界面，导入您的角色卡文件（或点击新建角色并手动填写设定）。
5. 回到对话界面，开始属于您的 Roleplay 旅程

---

## 目录结构 (Directory Structure)

```text
Roleplay-Hub/
├── server.py             # 数据服务器（Python 标准库，零依赖）
├── index.html            # 主程序
├── character/            # 辅助页面
│   └── index.html
├── assets/
│   ├── css/
│   │   └── styles.css    # 核心样式文件
│   └── js/
│       ├── app.js        # 核心业务逻辑
│       ├── server-api.js # 服务器 API 客户端（kvGet/kvSet/imageSave 等）
│       ├── card-utils.js # 角色卡导入导出相关工具
│       ├── ui-select.js  # 自定义选择器组件
│       └── utils.js      # 工具函数库
├── images/
│   └── generated/        # 聊天生成的图片（自动创建）
├── rp_hub_data.db        # 数据存储（SQLite，首次启动自动生成）
└── README.md             # 本说明文件
```

---

## 协议与许可 (License)

本项目严格遵守以下开源协议：

**[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans)**

* **您可以**：自由地共享（在任何媒介以任何形式复制、发行本作品）与演绎（修改、转换或以本作品为基础进行创作）。
* **您必须**：
  * **署名 (Attribution)**：给出适当的署名，提供指向本许可协议的链接，同时标明是否对原始作品作了修改。
  * **非商业性使用 (NonCommercial)**：**您不得将本作品或演绎作品用于任何商业目的。** 禁止任何形式的售卖、付费订阅集成或利用本项目进行广告牟利。
* 若要获取本项目的商业授权，请直接联系项目原作者。

详细许可条款请参见根目录下的 [`LICENSE`](./LICENSE) 文件。
