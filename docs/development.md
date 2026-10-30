# biubiu AI 开发说明

<img src="../build/companion-dev/biubiu-icon.png" alt="biubiu AI 图标：一只用手比划的小手枪，指尖射出两颗 AI 星光" width="96">

这份文档写给开发和维护 biubiu AI 的人；使用者请看 [README](../README.md) 和 [图文使用教程](tutorial.md)。

biubiu AI 是随 ZCode 显示的 Windows 桌面外挂：一个无边框的 WebView2 面板，贴在 ZCode 主窗口外侧，用来填写服务地址和 API Key、拉取模型、识别参数，并把选中的模型导入 ZCode 的本机配置。

自 0.6.0 起只保留桌面外挂形态，ZCode 插件形态已卸载并从源码中移除。外挂不修改 ZCode 安装文件，不注入 ZCode 进程，只读取 ZCode 窗口的位置、状态和像素（用于取主题色）。

源码仓库：<https://github.com/drhhhao/Zcode-biubiuAI>，安装程序发布在仓库的 Releases。程序文件、命名空间、数据目录、环境变量和登录启动项沿用开发代号 ModelHarbor（`ModelHarbor.exe`、`%LOCALAPPDATA%\ModelHarbor`、`MODEL_HARBOR_*`），这样升级后设置、站点登录和启动项都照常可用；界面上看到的名称只有 biubiu AI。

| 路径 | 用途 |
| --- | --- |
| `app/lib/` | 共享逻辑：配置读写与导入合并（`core.mjs`）、参数识别（`metadata.mjs`）、站点账户（`site.mjs`）、面板界面（`panel.html`）及其测试 |
| `app/server.mjs` | 外挂使用的本地服务 |
| `app/preview.mjs` | 浏览器预览服务，只写临时配置 |
| `app/demo.mjs` | 预览与教程截图共用的演示账户和演示服务（假数据，不联网） |
| `app/host/` | C# WebView2 宿主（`ModelHarbor.cs`、`app.manifest`） |
| `app/build.mjs` | 宿主构建脚本 |
| `app/installer/` | 给用户的安装程序：安装与卸载界面（`Setup.cs`、`setup.manifest`）、打包脚本（`package.mjs`）及其测试 |
| `dist/` | 打好的安装程序 `biubiuAI-Setup-<版本>.exe` 与它的 SHA-256（构建产物，不入库） |
| `build/installer-deps/` | 安装程序随附的第三方文件：微软 WebView2 运行时引导安装程序、Node.js 许可证（手动放入，构建时不下载；仅本地，不在仓库里） |
| `docs/` | 图文使用教程 `tutorial.md`、本开发说明 `development.md`，教程截图在 `docs/images/` |
| `app/lib/logo.mjs`、`app/icon.mjs` | 图标的形状与颜色（唯一来源），以及构建时把它画成 `app/bin/biubiu.ico` 的绘制脚本 |
| `app/dev/` | 插件时代留下的真实接口检查脚本，报告写入 `build/plugin-era-reports/` |
| `app/bin/` | 构建产物（不入库） |
| `build/companion-dev/` | 替身 ZCode 窗口（`FakeZCode.cs`）、替身冒烟脚本 `smoke-host.ps1`、图标设计脚本 `logo-design.mjs`、网站窗口与托盘菜单检查 `site-window-check.mjs` 与 `SiteWindowCheck.cs`、真实 ZCode 联动脚本 `live-zcode.ps1`、安装程序检查 `installer-check.ps1`、教程截图脚本 `docs-shots.mjs` 与 `docs-installer.ps1`（后者与 `installer-check.ps1` 共用 `window-helpers.ps1` 的窗口操作） |
| `build/webview2-sdk/` | WebView2 SDK（构建用；仅本地，不在仓库里） |
| `docs/plugin-era/`、`build/plugin-era-reports/` | 插件时代的文档与验收记录，作为历史证据保留，不改写（仅本地，不在仓库里） |
| `releases/` | 历史插件版本 ZIP（0.1.0–0.2.0），不再更新（仅本地，不在仓库里） |
| `.migration/` | 迁移前的本地市场配置备份（仅本地，不在仓库里） |

## 常用命令

在本目录打开终端：

```powershell
npm test            # 共享逻辑、参数识别与本地服务测试，含版本号同步检查
npm run preview     # 浏览器预览，只写临时配置
npm run app:build   # 编译宿主到 app/bin，并复制 WebView2 DLL 与许可文件
npm run app:start   # 编译后在后台启动外挂
npm run app:smoke   # 用替身 ZCode 窗口和临时配置做冒烟测试：窗口跟随、圆角、Key 隐藏、修改与删除服务（需先 app:build）
npm run app:site-check  # 用替身网站检查网站窗口的登录交接，离线检查更新检查读 Release 与校验下载的逻辑，并检查托盘菜单的样式（需先 app:build；不访问真实网站，不用任何账号）
npm run app:installer   # 编译宿主并打包给用户的安装程序 dist\biubiuAI-Setup-<版本>.exe
npm run app:installer-check  # 安装程序的端到端检查：静默安装到临时目录、对装好的副本跑冒烟测试、升级、一键更新（替身 Release）、卸载（需先 app:installer）
npm run app:server  # 只启动本地服务（开发用；此页面会修改真实配置）
```

测试和预览无需安装 npm 依赖。预览地址：<http://127.0.0.1:17862/>，测试 URL 为 `https://api.example.com/v1`，Key 为 `demo-key`。预览里的站点账户可用演示账号 `demo@example.com` / `demo` 登录（余额、Key、分组和模型都是假的，不联网；演示余额每读一次少 0.37，便于看到每 30 秒的自动读取；Claude Pro 和 Grok 4 两个分组没有 Key，可以演示添加分组时新建 Key）；用其他账号会真实登录 ro.biubiu007.com，导入仍只写临时配置，但添加分组时新建的 Key 会真实建在网站上，登录状态只在预览进程的内存里。

## 安装（给用户）

用户只需要一个文件：`dist\biubiuAI-Setup-<版本>.exe`（约 36 MB）。双击后只有一页：确认或更改安装位置（默认 `%LOCALAPPDATA%\Programs\biubiu AI`，装在当前用户名下，不需要管理员权限），两个默认勾选的选项（桌面快捷方式；登录 Windows 后在后台待命，打开 ZCode 时自动出现），点 **安装**，完成页可以直接启动 biubiu AI。

- **运行环境一起装好**：安装目录里自带 Node.js 运行时（`node\node.exe`，由构建机上的 Node.js 打包，保留 OpenJS Foundation 签名，附许可证），用户不用另装 Node.js，也不改 PATH。Windows 11 自带 WebView2 运行时；没有它的 Windows 10 上，安装程序运行随附的微软引导安装程序（需要联网）在线装好，装不上时说明原因，联网后再运行一次安装程序即可。.NET Framework 4.8 是 Windows 10 2019 年 5 月更新及以后、Windows 11 自带的，缺少时安装程序说明去哪里装。需要 64 位 Windows 10 或 11。
- **装了什么**：`bin\`（外挂程序与 WebView2 库）、`server.mjs` 与 `lib\`（本地服务和它读取的文件，不含测试与开发工具）、`node\`、`Uninstall.exe` 和清单 `uninstall.list`；开始菜单（和桌面）快捷方式「biubiu AI」；「设置 → 应用」里的 biubiu AI 条目（`HKCU\...\Uninstall\ModelHarbor`）；勾选后台待命时由外挂自己写入登录启动项。所选文件夹里已有其他文件时，自动装进其中的「biubiu AI」子文件夹。
- **升级**：0.8.9 起，装好的 biubiu AI 发现新版本会提醒一次，用户同意后自己下载、核对并安装（见下一节）。也可以运行新版本的安装程序：默认装回原来的位置，先让正在运行的 biubiu AI 退出，新版本没有的旧文件会删除；设置和网站登录状态（`%LOCALAPPDATA%\ModelHarbor`）保留。
- **卸载**：在「设置 → 应用」里卸载，或运行安装目录里的 `Uninstall.exe`。只删除清单列出的文件、指向这里的快捷方式、登录启动项和「应用」条目；勾选「同时删除 biubiu AI 的设置、日志和网站登录状态」才删除 `%LOCALAPPDATA%\ModelHarbor`。ZCode 和它的模型配置不受影响。卸载程序从临时文件夹里的副本运行（Windows 不能删除正在运行的程序），副本在下次安装或卸载时清掉。
- **命令行**：`--silent` 不显示窗口，`--dir <文件夹>` 指定位置，`--no-desktop`、`--no-startup` 去掉对应选项，`--launch` 静默安装后启动，`--update`（外挂的一键更新用）保持桌面快捷方式和开机待命原样、不新建也不删除；`Uninstall.exe --silent [--remove-data]` 静默卸载。安装与卸载的日志在 `%TEMP%\biubiu-ai-setup.log`。
- **注意**：安装程序没有代码签名，从网上下载后第一次运行，Windows SmartScreen 会提示“Windows 已保护你的电脑”，需要点“更多信息 → 仍要运行”。要去掉这个提示，需要用代码签名证书给安装程序签名。
- **启动**：完成页的「现在启动」和 `--launch` 只在安装程序经 UAC 提权运行时（拆分令牌的提权一半）才经 Explorer 启动外挂，让它以普通权限运行；内置 Administrator 或关闭 UAC 时 Explorer 也是同样的权限，就直接启动，保留安装程序收到的环境变量（一键更新的检查依赖这一点）。

## 更新提醒与一键更新

0.8.9 起，用安装程序装好的 biubiu AI 会自己发现新版本；开发目录里运行的不会（判断依据是 `bin\` 旁边有没有 `uninstall.list`）。

- **来源**：本仓库 Releases 里最新的正式版本（`https://api.github.com/repos/drhhhao/Zcode-biubiuAI/releases/latest`，GitHub 不把草稿和预发布算作 latest），标签 `v<版本>`，安装程序是其中名为 `biubiuAI-Setup-<版本>.exe` 的附件，下载地址只接受本仓库的 `releases/download/`。宿主启动约 2 分钟后看一次，之后每 12 小时一次；请求经系统代理（和浏览器一样），带 `User-Agent: biubiu-ai/<版本>`，连不上时不打扰用户，只在日志记一行（不记地址）。JSON 由宿主自己的小解析器（`Json.Parse`）读取，不为此加载序列化库。
- **提醒一次**：发现比自己新的版本，托盘弹出一次通知「biubiu AI 有新版本 x.y.z」，点通知即可更新；同一个版本只提醒一次（记在 `companion.ini` 的 `updateSeen`）。之后托盘菜单的「检查更新」变成「更新到 x.y.z…」，面板页脚出现「新版本 x.y.z · 更新」（宿主发 `{type: 'update', version, state, percent}`，页面点击时回 `update`；页面只转达点击）。
- **用户决定**：不论从哪里点，宿主都先弹窗（标题「biubiu AI 更新」）说明要做什么，选「是」才下载，选「否」什么也不做。GitHub 没有给这个附件记录 SHA-256 时不能一键更新，改为询问是否打开 Release 页面。
- **校验**：安装程序下载到 `%TEMP%\biubiu-ai-update\`（每次先清空，之后的自动检查也会清掉留下的文件），大小和 SHA-256 必须与 GitHub 为这个附件记录的 `size`、`digest`（`sha256:…`）一致才运行，否则删除并提示，什么也不装。安装程序没有代码签名，所以校验以 GitHub 的记录为准：能修改本仓库 Release 的人就能发布更新，请保护好 GitHub 账号（建议开启两步验证）。
- **安装**：以 `--silent --update --launch --dir <当前安装目录>` 运行安装程序。它让外挂退出、原地覆盖，保持桌面快捷方式和开机待命原样，装完再启动外挂；新版本第一次运行时提示一次「已更新到 x.y.z」（`companion.ini` 的 `version` 记着上次运行的版本）。安装程序在动手前就失败时（例如没有写入权限）外挂不会退出，并提示查看 `%TEMP%\biubiu-ai-setup.log`。
- **手动检查**：托盘菜单「检查更新」或 `ModelHarbor.exe --check-update`：有新版本时直接询问是否更新，没有时提示已是最新版本。
- **发布时注意**：Release 一旦正式发布（非草稿、非预发布），所有装了 0.8.9 及以上版本的用户都会收到提醒，所以先建草稿核对标签、附件名和说明，再正式发布。0.8.8 没有更新检查，装了 0.8.8 的用户需要手动安装一次新版本。
- **测试**：`npm run app:site-check` 离线检查 JSON 解析、Release 的读取（草稿、预发布、不是版本号的标签、别处的下载地址、别的版本的附件、缺 SHA-256 都不能一键更新）、版本比较和下载校验；`npm run app:installer-check` 用 `build/companion-dev/release-stand-in.mjs`（127.0.0.1 上的替身 latest Release，下载和 GitHub 一样经一次重定向）让装好的副本走完整个流程，并检查哈希不符时拒绝安装。`MODEL_HARBOR_UPDATE_URL` 指向替身地址（替身的下载地址只能是 `http://127.0.0.1:`，首次检查提前到启动后 3 秒），或设为 `off` 不检查（冒烟测试和教程截图脚本这样设置）。

## 运行要求

- 安装版：见上一节，只需要 64 位 Windows 10 / 11。
- 开发目录里运行：Windows 10 / 11 x64、.NET Framework 4.8、Microsoft Edge WebView2 Runtime，以及 Node.js 22 或更新（宿主依次找 `MODEL_HARBOR_NODE`、`bin` 旁边的 `node\node.exe`、PATH 和常见安装位置）。
- 构建另需 Visual Studio Build Tools 的 Roslyn `csc.exe`（或 `MODEL_HARBOR_CSC`），以及 Microsoft.Web.WebView2 1.0.4314.35 NuGet 包，解压到 `build/webview2-sdk/pkg-1.0.4314.35`（或 `MODEL_HARBOR_WEBVIEW2_SDK`）。构建脚本只校验包版本和三个 DLL 的微软 Authenticode 签名，不会联网下载。
- 打包安装程序另需 `build/installer-deps/` 里的两个文件：微软的 WebView2 运行时引导安装程序 `MicrosoftEdgeWebview2Setup.exe`（<https://go.microsoft.com/fwlink/p/?LinkId=2124703>）和 Node.js 许可证 `node-LICENSE.txt`（Node.js 源码仓库对应版本的 `LICENSE`）。打包脚本随附运行它的那个 Node.js（或 `MODEL_HARBOR_BUNDLE_NODE` 指定的，需 22 或更新），检查 Node.js 的 OpenJS Foundation 签名、引导安装程序与 WebView2 库的微软签名，以及 `app/bin` 里的外挂是当前版本；同样不联网下载。安装程序的版本取自 `app/lib/tools.mjs`，不另外同步。

## 面板

- **两页**：面板顶部的标签在「biubiu AI」（站点账户）和「连接服务」两页之间切换，默认打开站点账户页。登录后站点标签上显示余额（未登录时显示「未登录」），在连接服务页也能看到余额。页面向下滚动时标签停在面板顶部，切换后新页面从顶部开始；键盘可用左右方向键和 Home / End 切换。本地服务比面板旧、没有站点工具时，只显示连接服务页，不显示标签。
- **站点账户**：站点账户页是 biubiu AI（<https://ro.biubiu007.com>）账户。用网站的邮箱和密码登录后，自动读取余额、累计充值和这个账户的全部 Key，每个 Key 显示名称、状态、分组、额度和到期时间。页面没有标题（标签已写明站点）：最上面是 **账户**（登录邮箱）和 **累计充值**，右边是 **刷新** 和 **退出登录**，下面是 **余额**，余额下方是链接 **打开 ro.biubiu007.com ↗**，再往下是分组和站内 Key；未登录时只有登录表单，说明里写明密码发往的网站。读取的是网站主平台下的第一个平台账户，与网站首页一致；Key 列表从未同步过时先自动同步一次。Key 默认以圆点隐藏，点小眼睛才读取并显示这一个 Key。点 **添加到 ZCode**，这个 Key 的模型直接在它下方展开（仍在站点账户页，不切到连接服务页），勾选后点 **添加到 ZCode（N 个）** 加入 ZCode，列表保持展开，刚加入的模型标为「已在 ZCode」；已在 ZCode 的模型保持勾选、不能取消，超过 8 个模型时可以搜索，点 **收起** 合上。一次只展开一个 Key。Key 由本地服务直接填入，不经过面板，也只会发往 ro.biubiu007.com。按分组平台对应的地址与协议：Claude 为 `https://ro.biubiu007.com`（Anthropic Messages），GPT 为 `https://ro.biubiu007.com/v1`（OpenAI Responses），Antigravity 为 `https://ro.biubiu007.com/antigravity`（Anthropic Messages），其他平台按 OpenAI 兼容的 `/v1`；Gemini 分组只有 Gemini 原生接口，ZCode 不支持，只能查看。停用或过期的 Key 不能添加。每个 Key 添加为各自的服务（默认名「biubiu AI · Key 名称」），同一分组的两个 Key 不会互相覆盖；已在 ZCode 里的 Key 标「已在 ZCode」（鼠标移上去显示所在服务），按钮变为 **选择模型**，再添加的模型合并进这个服务。每个 Key 还有 **删除**：在这个 Key 下方再点 **确认删除**，先从 ZCode 删除使用这个 Key 的全部服务（连同模型和参数设置；确认后直接删除，不另做备份；ZCode 默认模型仍在使用其中任何一个时一个都不删，网站上的 Key 也不删），再在网站上删除这个 Key，与网站「API 密钥」页的删除相同：上游的 Key 一并删除，网站上标记为已删除，之后不能再用。网站删不掉时会说明 ZCode 里已经删了哪些服务，再点一次删除即可。网站用来测试分组的测试 Key 在网站上也不能删除，这里没有删除按钮。面板显示期间每 30 秒自动读取一次余额（只读余额，不刷新 Key 和分组，已显示的 Key 不会被重新隐藏；读取失败时保留上次的余额），面板收起或随 ZCode 隐藏时停止。面板每次显示时最多每分钟重新读取一次账户，点 **刷新** 立即读取。登录状态加密保存在本机，重启外挂后不必重新登录；网站拒绝续期时提示重新登录。**退出登录** 删除本机保存的登录状态（网站没有退出接口，已发出的令牌按网站规则到期），并关闭下面的网站窗口。
- **打开网站**：点余额下方的 **打开 ro.biubiu007.com ↗**，biubiu AI 在单独的窗口里打开网站，已经登录面板里的这个账户，落在网站登录后的首页；再点一次把已打开的窗口提到前面。网站把登录状态存在浏览器自己的存储里，又没有凭链接登录的入口，所以默认浏览器无法替你登录，只能由 biubiu AI 自己的窗口（与面板同一个 WebView2，InPrivate 模式，不往磁盘写任何东西）打开。窗口里的网站要续期登录时，由 biubiu AI 让本地服务续期一次并只交给它新的访问令牌，续期令牌始终留在本地服务里，所以网站窗口和面板不会互相把对方顶下线。窗口只显示 ro.biubiu007.com，其他网址（站外链接、新窗口）交给默认浏览器打开；在窗口里退出网站后，刷新也保持退出。面板退出登录或登录失效后，窗口里的网站下次续期时回到登录页。预览没有桌面外挂，链接只在新标签页打开网站的登录页。
- **分组**：站点账户页的「分组」按平台列出这个账户可用的分组（与网站分组页相同，只列有上游分组的），每行是分组名、说明和计费倍率（橙色，一眼能看到）。已加入 ZCode 的分组标「已加入 ZCode · N 个模型」（鼠标移上去显示对应的 ZCode 服务），行尾是 **补全** 和 **删除**：**补全** 把这个分组里 ZCode 还没有的模型（网站后来加的，或者之前只用分组里的某个 Key 加了几个）加进它在 ZCode 的服务，沿用这个服务已有的 Key，不新建服务也不新建 Key，都已在 ZCode 时说明没有可加的（分组里没有可用的 Key 时没有补全）；**删除** 在这一行里再点 **确认删除**，会从 ZCode 删除在网站地址上使用这个分组任一 Key 的服务（连同模型和参数设置，每个服务删除前自动备份；ZCode 默认模型仍在使用时拒绝删除），网站上的 Key 保留。其他分组行尾是 **添加**：用这个分组里状态正常的 Key，把网站网关为它返回的全部模型一次加入 ZCode，服务名为「biubiu AI · 分组名」；分组还没有可用的 Key 时先在这一行里询问，同意后才在网站上为它新建一个 Key（名称「ZCode · 分组名」，只传名称，与网站「创建密钥」的默认相同：不限额度、不过期），以后再添加会沿用这个 Key。添加、补全和删除的结果（加了几个模型、加进哪个服务、在 ZCode 的模型选择器里去哪找，或者失败的原因）显示在这个分组行的下方，不用滚动去找；分组列表下方的状态行只给读屏软件，分组已不在列表里时才显示出来。网站读取失败时分组列表上方说明原因，列表不显示“还没有可用的分组”；网站本身出错（HTTP 5xx）且只给英文原因时显示「biubiu AI 网站暂时出错（HTTP 状态码），请稍后重试。」，网站给出的中文原因照常显示。Gemini 分组不能添加。网站上的 Key 不再需要时，在下面的站内 Key 里删除。
- **连接服务与选择模型**：连接服务页上方的表单填写地址和 Key 后获取模型，勾选后添加到 ZCode。选择已保存的服务时 Key 可以留空，沿用已保存的 Key；输入框里的 Key 同样用小眼睛切换显示。每个模型旁有 **测试**：只发一条很短的请求（回复 OK，最多 2048 个输出 token，不带思考设置），看这个模型能不能用，会消耗少量额度；站点页展开的模型列表也有。
- **模型参数**：biubiu AI 只给新加入服务的模型写三项：上下文窗口、最大输出和推理等级，面板里不再提供参数编辑，要改就在 ZCode 的模型设置里改。ZCode 自己认识的模型（它的内置规则写了值的项）用 ZCode 的值，biubiu AI 不写，ZCode 升级后也跟着变；只有服务商接口声明的上限更小时才写那个更小的值。ZCode 没写的项统一为 **256K 上下文、128K 最大输出、推理等级 低 / 高 / 最高**；服务商接口或公开模型目录（models.dev）写明上限更小、没有某个档位或不支持思考时，按真实情况往下调，从不往上调。上下文不会小于最大输出：比如 ZCode 知道 DeepSeek V4 的输出是 384K，这时不写 256K 上下文，沿用 ZCode 自己的值。每个模型下方列出加入后的参数。服务里已有的模型和其他设置（输入类型、结构化输出、联网搜索、推理参数映射等）都不改动。
- **已导入的服务**：连接服务页的表单下方常驻列出 ZCode 里每个自定义服务的名称、模型数、接口地址和 Key。点模型数展开这个服务在 ZCode 里的模型名（按 ZCode 的模型顺序），再点收起；模型名随服务列表一起读取，展开时不另发请求，列表刷新后保持展开。服务商当前提供的全部模型，要在上方选中这个已保存的服务再获取。Key 默认显示为固定长度的圆点（不透露长度），点 Key 旁的小眼睛才读取并显示这一个服务的完整 Key，再点一次隐藏。面板收起或被隐藏时，所有 Key 重新隐藏；再次显示时重新读取服务列表。
- **修改与删除服务**：每个服务下方有 **修改** 和 **删除**。**修改** 在原处展开地址和 Key 两个输入框：Key 输入框不预填已保存的 Key，留空则保持原 Key，旁边的小眼睛可查看正在输入的内容；按 ZCode 内置模板添加的服务（例如 DeepSeek）地址固定，只能改 Key。保存时只检查地址格式，不联网验证新地址或 Key；想确认能用，在上方选中这个服务再获取模型。**删除** 要再点一次 **确认删除**，会一并移除这个服务的模型和模型参数设置；ZCode 的默认模型仍来自这个服务时拒绝删除，需先在 ZCode 里换成其他服务的模型。修改和删除前都会自动备份原配置。编辑中的内容在面板收起、隐藏或服务列表刷新时丢弃。

## 窗口行为

- **贴在外侧**：默认贴在 ZCode 右边框外侧，高度与 ZCode 一致（限在所在显示器的工作区内），跟随 ZCode 移动、缩放和切换虚拟桌面。
- **自动换边**：右侧屏幕空间不足 340（按 DPI 缩放）时改贴左侧；两侧都不够时退回 ZCode 内侧边缘，宽度最多占 ZCode 窗口的 60%。托盘菜单可改为优先贴左侧。
- **ZCode 最大化**（含全屏或铺满工作区）：旁边没有空位，只显示贴在 ZCode 内侧边缘的收起标签，不会自己盖住 ZCode；点标签（或快捷键、托盘）才在 ZCode 内侧展开面板，收起后回到标签。ZCode 还原成普通窗口后按上面的规则贴回外侧；再次最大化时又只显示标签。
- **自动隐藏**：ZCode 最小化、隐藏、被系统 cloak、关闭，或窗口小于 320×240 时面板和标签都隐藏；ZCode 恢复后重新贴上，外挂本身不退出。
- **收起与展开**：点面板右上角 **收起**，或点面板朝向 ZCode 的收起条，收成贴在 ZCode 边上的小标签；点标签再展开。标签同样贴在外侧、同样跟随和隐藏。
- **快捷键** `Ctrl+Alt+M`：收起时展开；已展开但未聚焦时聚焦面板；已聚焦时收起。面板因 ZCode 最小化、关闭或太小而看不见时，快捷键、单击托盘图标和托盘菜单的「展开面板」都只用通知说明原因并保持展开，ZCode 回来时面板就在，不会悄悄收成标签。
- **启动提示**：手动启动（开始菜单、桌面快捷方式、安装完成后启动）时如果 ZCode 没开、最小化或太小，约 1.5 秒后弹一次通知「biubiu AI 已启动，图标在任务栏右下角。」加上原因；登录时的后台启动（`--background`）不提示。
- **调整宽度**：拖动面板远离 ZCode 的边缘，宽度 340–900，贴外侧时不超过屏幕剩余空间，松开后保存。
- **主题**：按 ZCode 界面的明暗自动切换浅色 / 深色，取色时排除外挂自身区域。确定主题后，一次读到相反明暗不会马上切换，约半秒后再读一次仍相反才切换：ZCode 从任务栏恢复的动画期间，屏幕上它的位置还显示着背后的内容，这样不会把面板误切成另一种颜色再切回来。最近一次的主题记在设置里，外挂重新启动后（比如 ZCode 最小化时启动）直接沿用，不会先显示默认浅色。界面参照 iOS 的分组列表：浅灰底上放白色圆角卡片（浅色 #F2F2F7 底、#FFFFFF 卡片、#1D1D1F 字；深色 #1C1C1E 底、#2C2C2E 卡片、#F5F5F7 字），用系统无衬线字体（Windows 11 上是 Segoe UI Variable 与微软雅黑 UI，装了 PingFang、HarmonyOS Sans 或 MiSans 时优先用它们），次要文字用对比度足够的灰（浅色 #6E6E73、深色 #98989F），墨色的名称、按钮和数值用粗体；灰色说明只写一句能看懂的话。两页用分段控件切换，选中的滑块平滑滑过去；输入框是浅灰填充的圆角框，输入时出现橙色描边；勾选框是圆形，勾上时轻轻弹一下；主按钮是墨色圆角按钮，次要按钮是灰色胶囊，删除一类操作用红色；橙色只用在勾选、焦点、计费倍率和「打开网站」链接上，与图标的星光一致；展开的询问、列表和提示淡入上移，按钮按下时微微缩小。收起条与托盘菜单用同一套底色和字色；收起标签上画的是图标里的小手枪，手随主题用墨色或纸色，星光始终是橙色。外壳与 ZCode 窗口一致：面板和收起标签用 Windows 11 系统绘制的圆角、细边框和柔和阴影（与 ZCode 自己窗口的圆角相同；Windows 10 没有系统圆角，保持直角）；面板里的卡片、按钮、输入框、提示框、勾选框和滚动条也都是圆角。收起条平时只显示箭头，与页面之间没有分隔线，鼠标移上去才出现一条圆角底色。系统开启“减少动画”时不播放过渡。
- 不抢焦点，Z 序紧贴在 ZCode 之上；不安装鼠标钩子。
- 只运行一个实例，再次启动不会开第二个。

单击托盘图标展开或收起面板（双击也只切换一次），右键打开托盘菜单。托盘菜单：顶部一行是小手枪图标、biubiu AI 与版本号（不可点击），下面依次是展开 / 收起面板（全局快捷键可用时右侧注明 Ctrl+Alt+M）、重新加载面板；优先贴在 ZCode 右侧 / 左侧（二选一，圆点标出当前选择）；登录 Windows 时在后台待命（勾选框）、打开日志文件夹；退出 biubiu AI。菜单与面板同一风格、同一主题：纸色底、墨色字，组与组之间是细线，鼠标或键盘停在哪一行就在哪一行铺一层圆角底色，快捷键和版本号用浅一级的文字，圆点和勾选框与面板里的一样；Windows 11 上与面板一样由系统画圆角、细边框和阴影。

## 图标

一只用手比划的小手枪（就是 biubiu 那一下），整只手是一笔连下来的线：从手腕起笔，经过竖起的拇指、伸直的食指、两个弯起的指节，再回到手腕；指尖前方射出两颗一大一小的四角星光，这是常用来表示 AI 的符号，两颗正好是「biu biu」两声。手用墨色 #1B1B1C，星光用橙色 #EA580C（与网站暖色主题的强调色一致），放在暖白色 #F6F4F0 的圆角底板上，和 Windows 11 的应用图标一样四周留白。

- **程序图标**：构建时由 `app/icon.mjs` 按 `app/lib/logo.mjs` 画出 16、20、24、32、40、48、64、96、128、256 各尺寸，写成 `app/bin/biubiu.ico` 并嵌入 `ModelHarbor.exe`，资源管理器、任务管理器、开始菜单和网站窗口的任务栏按钮都用它（任务管理器里的名称是 biubiu AI）。
- **托盘图标**：宿主按任务栏要的尺寸现画，底板铺满整个图标，小尺寸下手势更清楚。
- **收起标签**：只画手势和星光，手随面板主题用墨色或纸色，鼠标移上去时与底色对调，星光不变。
- **面板页脚**：版本号前的小图标，手用页面文字颜色。
- **托盘菜单**：顶部一行的小图标，手随菜单主题用墨色或纸色。

`build/companion-dev/biubiu-icon.png`（1024 像素）和 `biubiu-icon.svg`（矢量，可直接用在网页上）是图标的成品文件，由 `node app/icon.mjs <文件> [尺寸]` 生成。改图标时修改 `build/companion-dev/logo-design.mjs` 里的设计参数并运行它，把输出同步到 `app/lib/logo.mjs`、`ModelHarbor.cs` 的 `Logo` 类和 `panel.html` 页脚（`npm test` 检查三处一致），再用 `node app/icon.mjs build/companion-dev/biubiu-icon.png 1024` 更新预览图。

## 随 ZCode 出现

勾选托盘菜单 **登录 Windows 时在后台待命**（或运行 `app\bin\ModelHarbor.exe --install-startup`）后，会在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写入 `ModelHarbor Companion`，登录时以 `--background` 启动。它在后台等待，ZCode 窗口一出现就贴在其边上，和上次退出时一样展开成面板或收成标签（默认展开）。取消勾选或运行 `--uninstall-startup` 即移除。在任务管理器“启动”页禁用后，托盘里的勾选会显示为未勾选；从托盘重新勾选会同时解除任务管理器的禁用标记（`HKCU\...\Explorer\StartupApproved\Run`），取消勾选会一并删除两处记录。

命令行参数：

| 参数 | 作用 |
| --- | --- |
| `--background` | 登录时的后台启动：不弹启动提示，面板按上次的展开或收起状态显示 |
| `--collapse` | 让正在运行的外挂收起 |
| `--expand` | 让正在运行的外挂展开（不抢焦点） |
| `--quit` | 让正在运行的外挂退出 |
| `--check-update` | 让正在运行的外挂马上检查更新，有新版本时询问是否更新 |
| `--install-startup` / `--uninstall-startup` | 写入 / 移除登录启动项 |
| `--devtools` | 开启 WebView2 开发者工具，仅调试用 |

## 数据与安全

- 数据目录 `%LOCALAPPDATA%\ModelHarbor`（可用绝对路径的 `MODEL_HARBOR_DATA_DIR` 覆盖）：`companion.ini` 保存 `panelWidth`、`topOffset`、`expanded`、`dock`（`right` / `left`）、`zcodeExe` 、最近一次的 ZCode 主题 `theme`（`dark` / `light`）、已经提醒过的新版本 `updateSeen` 和上次运行的版本 `version`；`companion.log` 超过 1 MB 轮转为 `.old`，不记录令牌、Key 或请求内容；`WebView2\` 为浏览器数据；`site-session.key` 是按当前 Windows 用户用 DPAPI 保护的随机密钥，`site-session.json` 是用它 AES-256-GCM 加密的站点登录令牌（不含密码），退出登录或令牌失效时删除，换了用户或密钥无法解开时也直接删除。
- 本地服务只监听 `127.0.0.1` 的随机端口，每次启动生成新的访问令牌，令牌不出现在任何进程命令行中。页面使用 nonce CSP，接口检查 Host、Origin、Sec-Fetch-Site 和令牌。
- 面板只能调用 `delete_provider`、`fetch_models`、`get_models`、`import_models`、`list_providers`、`reveal_key`、`site_account`、`site_add_group`、`site_delete_key`、`site_login`、`site_logout`、`site_remove_group`、`test_model`、`update_provider` 十四个工具。除 `reveal_key` 外，工具结果不返回 Key（`update_provider` 接收新 Key，结果只说明改了地址还是 Key；`site_account` 只说明每个站内 Key 和分组是否有可用的 Key；`site_add_group` 只有带 `createKey`，即面板询问并得到同意后，才会在网站上新建 Key，结果只给出新 Key 的名称；`site_delete_key` 只在面板询问并确认后删除网站上的一个 Key，结果只给出 Key 名称和删除的服务名）；`reveal_key` 只在用户点击某个服务或某个站内 Key 的小眼睛时返回这一个 Key，面板不预取，响应不缓存（`Cache-Control: no-store`），本地服务不记录请求和响应内容。
- 站点登录：密码只随这一次登录请求发往 `https://ro.biubiu007.com/api`，不保存、不记录；登录令牌只发往同一地址（不跟随重定向），在过期前 30 秒或被拒绝时续期，网站拒绝续期即视为退出。站内 Key（包括分组列表里带的完整 Key）只留在本地服务内存里；用站内 Key 获取模型时只接受 ro.biubiu007.com 的接口地址，且不能与输入的 Key 或已保存的服务混用。宿主通过环境变量 `MODEL_HARBOR_SESSION_DIR` / `MODEL_HARBOR_SESSION_KEY` 把保存位置和密钥交给 Node，Node 读到后立即从自己的环境中删除密钥；缺少两者时登录状态只保留到外挂退出。
- 导入、修改和删除服务都保留自动备份与并发检查：写入前把原文件原样备份到配置旁的 `backups\model-harbor\`（默认 `%USERPROFILE%\.zcode\v2\backups\model-harbor\`），写入过程中 ZCode 改了配置则放弃本次写入；每次写入成功后只保留最近 10 份备份，更早的自动删除：只删外挂自己命名的 `provider_config-<UTC 时间>-<8 位随机>.json`（按文件名排先后，刚做的那份总算最新），文件夹里的其他文件不动。自动导入保留手动设置，显式编辑才覆盖对应字段；修改和删除只作用于“已导入的服务”列出的自定义服务。需要撤回时，关闭 ZCode 后用所需时间点的备份恢复 `provider_config.json`。
- 面板的 WebView2 只允许访问本地服务页面：禁止新窗口、子框架、下载和权限请求，默认关闭右键菜单、开发者工具和自动填充。
- 网站窗口用同一个 WebView2 环境里单独的 InPrivate 配置（`site`），只加载 `https://ro.biubiu007.com`：其他网址交给默认浏览器（只限 http / https，每秒最多一个），拒绝所有权限请求，关闭密码保存和自动填充，网页无法给宿主发消息。它的登录状态从一个占位开始：没有访问令牌，续期令牌是宿主每次开窗时随机生成的标记；网站带着这个标记请求 `/api/auth/refresh` 时由宿主直接作答，其他请求原样发往网站。宿主经 Node 的标准输入问 Node 要访问令牌（`{"id","op":"site-token"}`），Node 续期一次（同一时间最多每 10 秒一次）后从标准输出回答；这条管道只有宿主持有，令牌不经过面板、端口、命令行或日志。
- Node 子进程挂在宿主的作业对象上，宿主退出时一并结束；正常退出时会等待进行中的导入、修改或删除完成。
- 调试用环境变量：`MODEL_HARBOR_ZCODE_EXE`（本次运行跟随其他进程名，不保存）、`MODEL_HARBOR_CONFIG_PATH`（改用其他配置文件）、`MODEL_HARBOR_REFRESH_CATALOG=0`（不刷新公开目录）、`MODEL_HARBOR_UPDATE_URL`（替身的 latest Release 地址，或 `off` 不检查更新）。

## 内存占用

外挂由宿主 `ModelHarbor.exe`、本地服务 `node.exe` 和 WebView2 的一组进程（浏览器、GPU、渲染、网络、存储、崩溃报告）组成，任务管理器把它们归在 biubiu AI 下，“内存”一列是各进程的私有工作集。0.8.7 起：

- **面板隐藏时让出内存**：面板收起成标签或随 ZCode 隐藏时，宿主把面板 WebView2 的 `MemoryUsageTargetLevel` 设为 Low，显示时恢复 Normal。约 30 秒内 WebView2 把页面以及浏览器、GPU 进程的内存换出；脚本照常运行，面板照样收到隐藏消息、重新隐藏 Key。再显示时按需取回：本机隐藏 40 秒后再显示，内容在 0.15 秒内到位，没有空白帧。WebView2 Runtime 不支持这项设置时保持原样，日志记一行。
- **本地服务**：宿主启动 Node 时带 `--max-semi-space-size=2`（限制 V8 新生代），并固定 `UV_THREADPOOL_SIZE=2`：Windows 上 libuv 线程池每个线程预先提交 8 MB 栈，从设了 `UV_THREADPOOL_SIZE=16` 的终端启动时，光栈就提交 128 MB。公开模型目录（models.dev）的本地缓存只保留导入用到的字段（模型 ID、上限和思考档位），小约 40%；拉取模型时同一服务地址的目录匹配只做一次，3000 个模型的拉取从约 1.2 秒降到约 0.25 秒。

本机（Windows 11、AMD 核显）用替身 ZCode 量得的私有工作集：

| 状态 | 0.8.6 | 0.8.7 |
| --- | --- | --- |
| 面板显示 | 约 150 MB（WebView2 约 115 MB，其中 GPU 进程约 60 MB；Node 约 20 MB；宿主约 10 MB） | 相同 |
| 面板收起或随 ZCode 隐藏约 30 秒后 | 约 148 MB | 约 37 MB（WebView2 约 5 MB） |
| 拉取模型时 Node 的峰值（300 个模型 / 当天首次刷新公开目录） | 约 72 / 122 MB | 约 31 / 57 MB |
| Node 的提交内存（普通启动 / 继承 `UV_THREADPOOL_SIZE=16`） | 58 / 154 MB | 42 / 42 MB |

## 测试

- `npm test`：共享逻辑、参数识别和本地服务测试，并检查各处版本号一致、插件形态已移除、每次写入配置后只留最近 10 份外挂自己的备份（文件夹里的其他文件不动），以及面板两页的结构与切换（标签、方向键、切换后从页面顶部开始、没有站点工具时只剩连接服务页）。站点账户用替身网站测试（`app/lib/site.test.mjs`）：登录与错误提示、并发请求只续期一次、续期被拒即退出并删除保存的登录、未同步时自动同步与分页、站内 Key 只按 ID 读取且只发往网站地址、两个站内 Key 导入为两个服务、登录状态加密保存与换密钥后丢弃，结果中不出现 Key、令牌或密码；分组：列表不带 Key，添加分组沿用可用 Key 并一次写入全部模型、重复添加不变，没有可用 Key 时只在面板询问后新建且同时点两次也只新建一个，取模型失败时说明已新建的 Key 并在下次沿用，Gemini 分组、未知分组和未登录时不改任何东西，删除分组删除在网站地址上用其 Key 的服务（别处地址的同一 Key 不算）、每个服务一份备份、不删网站上的 Key，默认模型仍在使用时拒绝；删除站内 Key：先在一次写入里删掉 ZCode 里用这个 Key 的服务（不论地址，不备份）再按网站自己的方式删网站上的 Key，默认模型仍在使用其中任何一个时两边都不删，测试 Key、未知 Key 和未登录时不删，网站删不掉时说明 ZCode 里已删的服务、再删一次即完成，Key 按网站自己的编号（`localId`）与分组和删除对应；再次获取站内 Key 的模型时标出已在 ZCode 的模型；补全已加入的分组时沿用它在 ZCode 的服务已有的 Key，缺的模型加进这个服务、不新建服务；网站 5xx 只给英文原因时换成中文说明，中文原因照常透传；模型参数（`app/lib/metadata.test.mjs`）：ZCode 不认识的模型写 256K / 128K / low·high·max，接口和公开目录只降不升，ZCode 认识的项不写（接口声明更小除外），ZCode 规则按 ZCode 的顺序、不分大小写匹配且兜底规则不算、取最新版本的副本，已有模型不动，测试只发一条不带思考设置的短请求；网站窗口的令牌交接：未登录时不联系网站，每次交接续期一次（10 秒内重复只给同一个令牌），结果只有访问令牌、不含续期令牌，交接后面板照常读取、重启后保存的登录仍可用，续期被拒即双双退出，暂时失败时报错并保留登录。本地服务测试还检查宿主经标准输入要令牌、只从标准输出拿到回答，工具接口拿不到令牌；面板测试检查站点页的顺序（账户与累计充值、余额、打开网站链接、分组、站内 Key），分组的结果显示在该行（行不在列表里且与上方错误不同时才显示在列表下方）、已加入的分组有补全、网站读取失败时不说“还没有可用的分组”，站内 Key 的模型在站点页该 Key 下方展开、勾选添加且不切到连接服务页，删除先在行内询问，以及按钮、提示框等的圆角。图标测试（`app/icon.test.mjs`）检查图标文件里每个尺寸的格式、底板与手势和星光落在路径所说的位置、宿主 `Logo` 类和面板页脚与 `logo.mjs` 完全一致、构建把图标嵌入 exe，以及旧名不再出现在界面和文档里。
- `npm run app:smoke`：启动 `build/companion-dev/FakeZCode.exe` 替身窗口和临时数据目录，检查外侧贴靠、左侧回退、两侧都放不下时的内侧回退、移动跟随、最大化时只在内侧边缘显示标签（`--expand` 后面板在内侧展开，还原后回到外侧，再次最大化又只剩标签）、最小化隐藏与恢复、收起 / 展开、单击和双击托盘图标（向图标的隐藏窗口发 `WM_USER + 1024`，双击只切换一次）、ZCode 最小化时单击托盘图标或按 `Ctrl+Alt+M` 后恢复仍是面板（快捷键被别的程序占用时跳过）、手动启动时 ZCode 最小化会提示（日志 `startup notice`）而 ZCode 在屏幕上和 `--background` 时不提示、`--background` 按上次的展开或收起状态显示、明暗主题、ZCode 在白色或黑色背景前从任务栏恢复时面板不闪成另一种主题（含 ZCode 最小化时才启动外挂的情况）、单实例、只监听回环地址和退出清理；面板和收起标签在深色主题下放到一块白色替身底板前，检查远离 ZCode 那一侧的两个角透出底板（圆角）、同一条边的中间仍是面板自己的颜色，并把面板顶部两角存为 `build/companion-dev/panel-corners.png`；最后用临时配置里的假 Key 通过 UI 自动化切到「连接服务」页并检查：已保存 Key 默认以圆点隐藏、点小眼睛显示完整 Key、面板收起再展开以及 ZCode 最小化再恢复后重新隐藏；在面板里 **修改** 这个服务的地址和 Key 后，临时配置随之更新并留下一份备份，新 Key 同样默认隐藏、点小眼睛才显示；**删除** 要再点 **确认删除** 才生效，删除后配置和面板里都不再有这个服务，并再留下一份备份；日志里始终没有 Key。不触碰真实 ZCode。替身窗口和 Electron 无边框窗口一样保留标题栏样式，所以最小化与恢复时有系统动画；它的 `backdrop white|black|off` 命令在它正后方放一块同样大小的纯色窗口。替身源码改动后需用 Roslyn `csc.exe` 重新编译 `FakeZCode.exe`。
- `npm run app:site-check`（`build/companion-dev/site-window-check.mjs`）：把 `SiteWindowCheck.cs` 编译到临时目录，引用构建好的 `ModelHarbor.exe`，让真正的网站窗口打开 127.0.0.1 上的替身网站（Node 一侧也用替身）。检查：网站一开始拿到的是占位登录；带标记的续期两次拿到令牌（并再拿到标记），之后面板已退出时得到 401、没有回答时得到 503，令牌能用于替身的 `/api/auth/me`；不带标记的续期原样到达网站，请求体不变；网页给宿主发的消息到不了宿主；站外的新窗口和跳转交给“默认浏览器”（只打印，不真的打开），页面留在网站上；第一次加载后刷新保留网站自己的登录状态；日志写在临时目录里，没有令牌和标记。再检查宿主与 Node 之间的管道：宿主能读出带令牌、已退出和出错的回答，其他行不当作回答；对真正的 `app/server.mjs`（临时数据目录里没有登录，所以不联系任何网站）经标准输入提问能得到回答，同时问两次各得一个回答，未知的问题、服务未就绪或已停止时立即失败。然后离线检查更新检查（`SiteWindowCheck.exe --updates`）：JSON 的各种值、转义和数字能读、不是 JSON 的文字被拒绝；GitHub 形状的 Release 给出版本、页面、安装程序地址、大小和 SHA-256，草稿、预发布、不是版本号的标签不算，别处的下载地址、别的版本的附件、缺少或不是 SHA-256 的摘要都不能一键更新；只有更新的版本才算；下载的文件大小或 SHA-256 不符时不运行；开发目录里的构建不检查更新。最后检查托盘菜单（含「检查更新」一行）：在自己的纯色底板前分别打开浅色和深色菜单（截图里只有底板和菜单），检查菜单停在放下的位置、各行等距排列、四角是圆角、底色是面板的纸色且没有灰色图标栏、只有鼠标所在的一行有底色、顶部一行有橙色星光、当前停靠侧的圆点和启动项勾选框画对了，两张截图并排存为 `build/companion-dev/tray-menu.png`。不访问真实网站，不用任何账号。
- 安装程序：`npm test` 里的 `app/installer/package.test.mjs` 检查安装包只带本地服务实际读取的文件（从 `server.mjs` 顺着 import 找出，不含测试和开发工具）、压缩包按 UTF-8 文件名完整还原且同样的文件打出同样的包、安装程序与外挂对互斥体、退出事件、启动项和数据目录的名字一致、宿主先用 `bin` 旁边的 Node.js，以及只按当前用户安装、不碰 ZCode、只删清单里的文件。`npm run app:installer-check`（`build/companion-dev/installer-check.ps1`）做端到端检查：打开安装窗口截图后关闭（不安装）；静默安装到带空格和中文的临时路径，核对文件与清单、Node.js 签名、「应用」条目和开始菜单快捷方式，未勾选时不建桌面快捷方式、不写登录启动项；把 Node.js 从 PATH 拿掉后对装好的副本跑完整的 `app:smoke`（`MODEL_HARBOR_EXE` 指向它），并确认服务由随附的 Node.js 运行；原地升级会删掉新版本没有的旧文件；再用替身 Release（`release-stand-in.mjs`，名为 0.9.0、安装程序就是本次构建的）让装好的副本一键更新：提醒一次且不自己下载，`--check-update` 后先询问（截图存为 `update-ask.png`），点「是」后经重定向下载一次、核对 SHA-256、静默原地安装并在同样的环境里重新启动，桌面快捷方式、登录启动项和「应用」条目不变，重新启动后再检查也不再提醒，下载的文件清掉；替身改报不符的 SHA-256 后再更新，拒绝安装、外挂不退出、文件删掉。全程盯着真实数据目录的日志，测试里启动的外挂一旦写到那里就立即让它退出并判为失败。打开卸载窗口截图后关闭（不卸载）；静默卸载后安装目录、「应用」条目和快捷方式都没了，外层文件夹、外挂数据目录和登录启动项不受影响；装进有其他文件的文件夹时进到「biubiu AI」子文件夹，卸载后其他文件还在；最后像用户一样在窗口里点「安装」、取消「现在启动」、点「完成」，确认装好且没有启动。截图存为 `build/companion-dev/installer.png`、`installer-done.png`、`uninstaller.png`。机器上已经装有 biubiu AI（「应用」里有条目或开始菜单已有快捷方式）时拒绝运行，以免替换它；外挂只跟随替身 ZCode、只用临时数据目录。
- `build/companion-dev/live-zcode.ps1`：对真实 ZCode 窗口做联动测试（移动、缩放、最大化、最小化，含两侧都放不下时的内侧回退），结束后恢复 ZCode 原始窗口状态。**只在用户明确同意后运行。**

## 插件形态的移除记录

- 已执行 `zcode plugins uninstall`，`model-harbor@dev-huaweiyun-excel-a7abdff0` 不再出现在已安装插件列表中；卸载前的 `installed_plugins.json` 与 `known_marketplaces.json` 备份在 `build/plugin-uninstall-backup-20261024-220013/`。
- 项目内的 `plugins/` 目录（插件源码与本地市场清单）已删除。
- ZCode CLI 的安装缓存 `~/.zcode/cli/plugins/cache/dev-huaweiyun-excel-a7abdff0/model-harbor/` 仍由 ZCode 管理，本项目不手动改动。
- 插件时代的说明、验收报告和截图保留在 `docs/plugin-era/` 与 `build/plugin-era-reports/`。旧验收记录中的 `huaweiyun_excel/_incoming/model-harbor-smoke` 等路径是历史位置，保留原样。
